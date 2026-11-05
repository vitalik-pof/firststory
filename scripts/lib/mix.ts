// Зразок зведення: музика під голосом за словами з timings.json.
//
// Рівні задаються «в дБ відносно голосу»: гучність (RMS) музичного зразка зводиться до RMS голосу
// на ділянках мовлення, а далі кривою додається «під голосом» там, де голос звучить, і «в паузах»
// там, де він мовчить. Зміна гучності лінійна в дБ за заданий час; приглушення починається ЗА
// цей час до першого слова, підйом після останнього слова. Усе рахується в пам'яті на PCM float32.

import { spawnSync } from 'node:child_process';

export const SR = 44100;
export const CH = 2;

export function decodeStereo(file: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', String(CH), '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg не зміг декодувати ${file}: ${r.stderr?.toString()}`);
  const buf = r.stdout as Buffer;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
}

export function encodeStereoMp3(pcm: Float32Array, out: string, kbps = 128): void {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ac', String(CH), '-ar', String(SR), '-i', '-', '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, out], {
    input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error(`ffmpeg не зміг записати ${out}: ${r.stderr?.toString()}`);
}

export interface Interval {
  a: number;
  b: number;
}

/** Інтервали мовлення: слова, між якими пауза не довша за pauseMin, зливаються. */
export function speechIntervals(words: Array<{ start: number; end: number }>, pauseMin: number): Interval[] {
  const out: Interval[] = [];
  for (const w of [...words].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && w.start - last.b <= pauseMin) last.b = Math.max(last.b, w.end);
    else out.push({ a: w.start, b: w.end });
  }
  return out;
}

export interface EnvPoint {
  t: number;
  db: number;
}

/** Кусково-лінійна крива гучності музики (дБ відносно голосу), t у секундах від початку вікна. */
export function envelopePoints(intervals: Interval[], underDb: number, pauseDb: number, fade: number): EnvPoint[] {
  const pts: EnvPoint[] = [{ t: 0, db: pauseDb }];
  const push = (t: number, db: number): void => {
    const last = pts[pts.length - 1]!;
    pts.push({ t: Math.max(t, last.t), db });
  };
  intervals.forEach((iv, i) => {
    const prev = intervals[i - 1];
    const gap = prev ? iv.a - prev.b : Infinity;
    if (prev && gap < 2 * fade) {
      // Пауза коротша за два переходи: музика не встигає піднятись до кінця.
      const peak = underDb + (pauseDb - underDb) * (gap / (2 * fade));
      pts.pop(); // прибираємо підйом, який поставили після попереднього інтервалу
      push(prev.b, underDb);
      push(prev.b + gap / 2, peak);
      push(iv.a, underDb);
    } else {
      push(iv.a - fade, pauseDb);
      push(iv.a, underDb);
    }
    push(iv.b, underDb);
    push(iv.b + fade, pauseDb);
  });
  return pts;
}

export function dbAt(pts: EnvPoint[], t: number): number {
  if (t <= pts[0]!.t) return pts[0]!.db;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    if (t <= p.t) {
      const q = pts[i - 1]!;
      return p.t === q.t ? p.db : q.db + ((p.db - q.db) * (t - q.t)) / (p.t - q.t);
    }
  }
  return pts[pts.length - 1]!.db;
}

export function rmsOver(pcm: Float32Array, intervals: Interval[]): number {
  let sum = 0;
  let n = 0;
  for (const iv of intervals) {
    const from = Math.max(0, Math.floor(iv.a * SR)) * CH;
    const to = Math.min(pcm.length, Math.floor(iv.b * SR) * CH);
    for (let i = from; i < to; i++) {
      sum += pcm[i]! * pcm[i]!;
      n++;
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export const toDb = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

export interface MixParams {
  underDb: number;
  pauseDb: number;
  fade: number;
  pauseMin: number;
  /** Слова мовлення відносно початку вікна. */
  words: Array<{ start: number; end: number }>;
  musicFadeIn: number;
  musicFadeOut: number;
}

export interface MixResult {
  pcm: Float32Array;
  voiceRmsDb: number;
  musicRmsDb: number;
  peakScale: number;
  musicShorterBy: number;
  intervals: Interval[];
  envelope: EnvPoint[];
}

/** voice і music: стерео PCM (interleaved). voice — вікно зразка; музика береться з її початку. */
export function mixVoiceAndMusic(voice: Float32Array, music: Float32Array, p: MixParams): MixResult {
  const windowSec = voice.length / CH / SR;
  const intervals = speechIntervals(p.words, p.pauseMin);
  const voiceRms = rmsOver(voice, intervals);
  if (voiceRms <= 0) throw new Error('У вікні зразка не знайдено мовлення (RMS голосу = 0): перевірте фрагменти й таймінги.');
  const musicLen = Math.min(music.length, voice.length);
  const musicRms = rmsOver(music, [{ a: 0, b: musicLen / CH / SR }]);
  if (musicRms <= 0) throw new Error('Музичний зразок беззвучний.');
  const base = voiceRms / musicRms;
  const env = envelopePoints(intervals, p.underDb, p.pauseDb, p.fade);
  const out = new Float32Array(voice.length);
  const frames = voice.length / CH;
  const musicFrames = music.length / CH;
  for (let f = 0; f < frames; f++) {
    const t = f / SR;
    let g = 0;
    if (f < musicFrames) {
      g = base * 10 ** (dbAt(env, t) / 20);
      if (t < p.musicFadeIn) g *= t / p.musicFadeIn;
      const tail = Math.min(windowSec, musicFrames / SR) - t;
      if (tail < p.musicFadeOut) g *= Math.max(0, tail / p.musicFadeOut);
    }
    for (let c = 0; c < CH; c++) out[f * CH + c] = voice[f * CH + c]! + (f < musicFrames ? music[f * CH + c]! * g : 0);
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  let peakScale = 1;
  if (peak > 0.98) {
    peakScale = 0.98 / peak;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * peakScale;
  }
  return { pcm: out, voiceRmsDb: toDb(voiceRms), musicRmsDb: toDb(musicRms), peakScale, musicShorterBy: Math.max(0, windowSec - musicFrames / SR), intervals, envelope: env };
}
