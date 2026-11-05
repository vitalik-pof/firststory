// Зразок зведення: музика під голосом за словами з timings.json.
//
// Рівні задаються «в дБ відносно голосу»: гучність (RMS) музичного зразка зводиться до RMS голосу
// на ділянках мовлення, а далі кривою додається «під голосом» там, де голос звучить, і «в паузах»
// там, де він мовчить. Зміна гучності лінійна в дБ за заданий час; приглушення починається ЗА
// цей час до першого слова, підйом після останнього слова. Усе рахується в пам'яті на PCM float32.

import { spawnSync } from 'node:child_process';
import type { EnvPatch } from './mix-spec';

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

/**
 * Музика для фільму: файл береться з секунди offset і читається зі швидкістю speed (секунда фільму t це
 * секунда файлу offset + speed·t). Швидкість змінюється разом із тональністю: ffmpeg asetrate (+ aresample
 * до 44100), без артефактів розтягування. Без offset і зі speed 1 це звичайне декодування.
 */
export function decodeMusic(file: string, offset: number, speed: number): Float32Array {
  const args = ['-v', 'error'];
  if (offset > 0) args.push('-ss', String(offset));
  args.push('-i', file);
  if (speed !== 1) args.push('-af', `aresample=${SR},asetrate=${Math.round(SR * speed)},aresample=${SR}`);
  args.push('-f', 'f32le', '-ac', String(CH), '-ar', String(SR), '-');
  const r = spawnSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg не зміг прочитати музику ${file}: ${r.stderr?.toString()}`);
  const buf = r.stdout as Buffer;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
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

// ------------------------------------------------------------------ повне зведення фільму

/** Крива «дБ у момент t»: основна функція, поверх якої лягають ділянки (пізніші перекривають раніші). */
export function withPatches(base: (t: number) => number, patches: EnvPatch[]): (t: number) => number {
  const resolved = patches
    .filter((p) => p.points.length >= 2)
    .map((p) => ({ t0: p.points[0]!.t, t1: p.points[p.points.length - 1]!.t, pts: p.points.map((q) => ({ t: q.t, db: q.db === 'base' ? base(q.t) : q.db })) }));
  return (t) => {
    for (let i = resolved.length - 1; i >= 0; i--) {
      const r = resolved[i]!;
      if (t >= r.t0 && t <= r.t1) return dbAt(r.pts, t);
    }
    return base(t);
  };
}

/** Основна крива музики: як у зразку, але якщо мовлення починається раніше за час зміни, музика одразу на рівні «під голосом». */
export function baseMusicEnvelope(intervals: Interval[], underDb: number, pauseDb: number, fade: number): (t: number) => number {
  const pts = envelopePoints(intervals, underDb, pauseDb, fade);
  const first = intervals[0];
  if (first && first.a < fade) for (const p of pts) if (p.t <= first.a) p.db = underDb;
  return (t) => dbAt(pts, t);
}

export interface FilmSfx {
  label: string;
  pcm: Float32Array;
  /** Секунда фільму, на якій починається файл. */
  start: number;
  /** Рівень відносно голосу, дБ, у момент t. */
  levelDb: (t: number) => number;
  fadeIn: number;
  fadeOutLen: number;
  /** Секунда, на якій згасання закінчується (не пізніше за кінець файлу й фільму). */
  fadeOutEnd: number;
}

export interface FilmParams {
  words: Array<{ start: number; end: number }>;
  pauseMin: number;
  /** Рівень музики відносно голосу, дБ, у момент t. */
  musicDb: (t: number) => number;
  /** Наприкінці фільму музика гасне до нуля за стільки секунд (амплітуда лінійно). */
  endFade: number;
  /** Вхід музики з нуля на початку фільму (проти клацання), секунд; 0 або без поля: без входу. */
  musicFadeIn?: number;
  /** RMS музики (лінійний), якщо його треба взяти не з наданого PCM, а, наприклад, з ділянки оригінального файлу. */
  musicRms?: number;
  /** Шумів може не бути: порожній список. */
  sfx: FilmSfx[];
}

export interface FilmResult {
  pcm: Float32Array;
  voiceRmsDb: number;
  musicRmsDb: number;
  sfxRmsDb: Array<{ label: string; rmsDb: number }>;
  peakScale: number;
  musicShorterBy: number;
}

/** Однополюсний фільтр низьких частот (для «приглушеного» шуму), на кожному каналі окремо. */
export function lowpass(pcm: Float32Array, cutoffHz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SR);
  const out = new Float32Array(pcm.length);
  const y = new Array<number>(CH).fill(0);
  for (let f = 0; f < pcm.length / CH; f++) {
    for (let c = 0; c < CH; c++) {
      y[c] = y[c]! + a * (pcm[f * CH + c]! - y[c]!);
      out[f * CH + c] = y[c]!;
    }
  }
  return out;
}

/** Рівень (множник) у кожну 5-ту мс, між ними лінійно: дешевше за обчислення кривої на кожному семплі. */
function gainTable(dbFn: (t: number) => number, seconds: number, rmsRatio: number): { at: (f: number) => number } {
  const step = Math.round(SR * 0.005);
  const n = Math.ceil((seconds * SR) / step) + 2;
  const tab = new Float32Array(n);
  for (let i = 0; i < n; i++) tab[i] = rmsRatio * 10 ** (dbFn((i * step) / SR) / 20);
  return {
    at: (f) => {
      const k = f / step;
      const i = Math.floor(k);
      const fr = k - i;
      return tab[i]! * (1 - fr) + tab[Math.min(i + 1, n - 1)]! * fr;
    },
  };
}

/**
 * Повне зведення: голос на 0 дБ, музика й шуми під ним за кривими (дБ відносно голосу). Рівні
 * музики й шумів міряються так само, як у зразку: RMS музики (від початку, на довжину фільму) і RMS
 * кожного шуму (весь файл) зводяться до RMS голосу на ділянках мовлення, далі додається крива.
 * Довжина результату дорівнює довжині голосу (voice уже містить тишу затримки на початку, якщо озвучення
 * стоїть у фільмі не з нуля: див. padVoice).
 */
export function mixFilm(voice: Float32Array, music: Float32Array, p: FilmParams): FilmResult {
  const frames = voice.length / CH;
  const filmSec = frames / SR;
  const intervals = speechIntervals(p.words, p.pauseMin);
  const voiceRms = rmsOver(voice, intervals);
  if (voiceRms <= 0) throw new Error('Не знайдено мовлення (RMS голосу = 0): перевірте озвучення й timings.json.');
  const musicFrames = music.length / CH;
  const musicRms = p.musicRms ?? rmsOver(music, [{ a: 0, b: Math.min(musicFrames / SR, filmSec) }]);
  if (musicRms <= 0) throw new Error('Музика беззвучна.');
  const out = new Float32Array(voice);
  const mg = gainTable(p.musicDb, filmSec, voiceRms / musicRms);
  for (let f = 0; f < Math.min(frames, musicFrames); f++) {
    let g = mg.at(f);
    const left = filmSec - f / SR;
    if (p.endFade > 0 && left < p.endFade) g *= Math.max(0, left / p.endFade);
    const tIn = f / SR;
    if (p.musicFadeIn && tIn < p.musicFadeIn) g *= tIn / p.musicFadeIn;
    for (let c = 0; c < CH; c++) out[f * CH + c] = out[f * CH + c]! + music[f * CH + c]! * g;
  }
  const sfxRmsDb: Array<{ label: string; rmsDb: number }> = [];
  for (const s of p.sfx) {
    const sfxFrames = s.pcm.length / CH;
    const rms = rmsOver(s.pcm, [{ a: 0, b: sfxFrames / SR }]);
    if (rms <= 0) throw new Error(`${s.label}: файл беззвучний.`);
    sfxRmsDb.push({ label: s.label, rmsDb: toDb(rms) });
    const startFrame = Math.round(s.start * SR);
    const levelTab = gainTable((t) => s.levelDb(t + s.start), sfxFrames / SR, voiceRms / rms);
    const outEnd = s.fadeOutEnd - s.start; // відносно початку файлу
    for (let i = 0; i < sfxFrames; i++) {
      const f = startFrame + i;
      if (f >= frames) break;
      const t = i / SR;
      let g = levelTab.at(i);
      if (s.fadeIn > 0 && t < s.fadeIn) g *= t / s.fadeIn;
      if (s.fadeOutLen > 0 && t > outEnd - s.fadeOutLen) g *= Math.max(0, (outEnd - t) / s.fadeOutLen);
      for (let c = 0; c < CH; c++) out[f * CH + c] = out[f * CH + c]! + s.pcm[i * CH + c]! * g;
    }
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  let peakScale = 1;
  if (peak > 0.98) {
    peakScale = 0.98 / peak;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! * peakScale;
  }
  return { pcm: out, voiceRmsDb: toDb(voiceRms), musicRmsDb: toDb(musicRms), sfxRmsDb, peakScale, musicShorterBy: Math.max(0, filmSec - musicFrames / SR) };
}

/** Ставить озвучення у фільм із затримкою: перед ним додається тиша delay секунд. */
export function padVoice(voice: Float32Array, delay: number): Float32Array {
  const lead = Math.round(delay * SR) * CH;
  if (lead <= 0) return voice;
  const out = new Float32Array(lead + voice.length);
  out.set(voice, lead);
  return out;
}
