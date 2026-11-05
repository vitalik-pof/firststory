// Вимір звуку для вирівнювання проб голосів: тривалість мовлення без тиші на краях і медіана
// основного тону (F0). Усе локально: ffmpeg декодує файл у моно PCM, решта на чистому TypeScript,
// без кредитів.

import { spawnSync } from 'node:child_process';

export const ANALYSIS_RATE = 16_000;

/** Декодує аудіофайл у моно float32 із частотою sr (ffmpeg). */
export function decodeMono(file: string, sr = ANALYSIS_RATE): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg не зміг декодувати ${file}: ${r.stderr?.toString() ?? ''}`);
  const buf = r.stdout;
  // Копіюємо, щоб вирівняти байти під Float32Array.
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** RMS кадрів: вікно winSec, крок hopSec. */
export function frameRms(x: Float32Array, sr: number, winSec = 0.02, hopSec = 0.01): { rms: Float64Array; win: number; hop: number } {
  const win = Math.max(1, Math.round(winSec * sr));
  const hop = Math.max(1, Math.round(hopSec * sr));
  const n = x.length >= win ? Math.floor((x.length - win) / hop) + 1 : 0;
  const rms = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const a = f * hop;
    for (let i = a; i < a + win; i++) s += x[i]! * x[i]!;
    rms[f] = Math.sqrt(s / win);
  }
  return { rms, win, hop };
}

function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).sort((u, v) => u - v);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]!;
}

export interface SpeechSpan {
  /** Початок першого й кінець останнього кадру вище порога, секунди. */
  start: number;
  end: number;
  /** Тривалість мовлення без тиші на краях (усередині паузи зберігаються). */
  duration: number;
  /** Повна тривалість файлу. */
  total: number;
}

/** Поріг тиші: 35 дБ нижче за гучні кадри (95-й процентиль RMS). */
export const SILENCE_DB_BELOW_LOUD = 35;

export function speechSpan(x: Float32Array, sr: number): SpeechSpan {
  const total = x.length / sr;
  const { rms, win, hop } = frameRms(x, sr);
  if (!rms.length) return { start: 0, end: 0, duration: 0, total };
  const loud = percentile(rms, 0.95);
  const threshold = Math.max(1e-5, loud * 10 ** (-SILENCE_DB_BELOW_LOUD / 20));
  let first = -1;
  let last = -1;
  for (let f = 0; f < rms.length; f++) {
    if (rms[f]! >= threshold) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return { start: 0, end: 0, duration: 0, total };
  const start = (first * hop) / sr;
  const end = (last * hop + win) / sr;
  return { start, end, duration: end - start, total };
}

export interface F0Result {
  /** Медіана F0 за озвученими кадрами, Гц, або null, якщо озвучених кадрів немає. */
  hz: number | null;
  voicedFrames: number;
  frames: number;
}

export interface F0Options {
  minHz?: number;
  maxHz?: number;
  /** Мінімальна нормована автокореляція, щоб кадр вважався озвученим. */
  voicing?: number;
}

/**
 * Медіана F0 автокореляцією (NCCF): кадри по 40 мс із кроком 10 мс, діапазон 70–400 Гц. Тихі кадри
 * (нижче 12% від гучних за RMS) і кадри з слабкою періодичністю пропускаються. Щоб не ловити
 * октаву вниз, береться найкоротший лаг серед піків не нижче 90% від найвищого, з параболічним уточненням.
 */
export function medianF0(x: Float32Array, sr: number, opts: F0Options = {}): F0Result {
  const minHz = opts.minHz ?? 70;
  const maxHz = opts.maxHz ?? 400;
  const voicing = opts.voicing ?? 0.6;
  const win = Math.round(0.04 * sr);
  const hop = Math.round(0.01 * sr);
  const minLag = Math.floor(sr / maxHz);
  const maxLag = Math.ceil(sr / minHz);
  const need = win + maxLag + 1;
  const frames = x.length >= need ? Math.floor((x.length - need) / hop) + 1 : 0;
  if (!frames) return { hz: null, voicedFrames: 0, frames: 0 };

  const rmsAll = frameRms(x, sr, 0.04, 0.01).rms;
  const gate = percentile(rmsAll, 0.95) * 0.12;
  const f0s: number[] = [];
  const nccf = new Float64Array(maxLag + 2);
  const a = new Float64Array(win);

  for (let f = 0; f < frames; f++) {
    const base = f * hop;
    let mean = 0;
    for (let i = 0; i < win; i++) mean += x[base + i]!;
    mean /= win;
    let e0 = 0;
    for (let i = 0; i < win; i++) {
      const v = x[base + i]! - mean;
      a[i] = v;
      e0 += v * v;
    }
    if (Math.sqrt(e0 / win) < gate || e0 <= 0) continue;
    // Енергія зсунутого вікна — ковзною сумою.
    let eL = 0;
    for (let i = 0; i < win; i++) {
      const v = x[base + minLag + i]! - mean;
      eL += v * v;
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (lag > minLag) {
        const out = x[base + lag - 1]! - mean;
        const inn = x[base + lag - 1 + win]! - mean;
        eL += inn * inn - out * out;
      }
      let c = 0;
      for (let i = 0; i < win; i++) c += a[i]! * (x[base + lag + i]! - mean);
      nccf[lag] = eL > 0 ? c / Math.sqrt(e0 * eL) : 0;
    }
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) if (nccf[lag]! > best) best = nccf[lag]!;
    if (best < voicing) continue;
    let pick = -1;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      const v = nccf[lag]!;
      if (v >= 0.9 * best && v >= nccf[lag - 1]! && v >= nccf[lag + 1]!) {
        pick = lag;
        break;
      }
    }
    if (pick < 0) continue;
    const y0 = nccf[pick - 1]!;
    const y1 = nccf[pick]!;
    const y2 = nccf[pick + 1]!;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    f0s.push(sr / (pick + Math.max(-1, Math.min(1, shift))));
  }
  if (!f0s.length) return { hz: null, voicedFrames: 0, frames };
  f0s.sort((u, v) => u - v);
  const m = f0s.length >> 1;
  const hz = f0s.length % 2 ? f0s[m]! : (f0s[m - 1]! + f0s[m]!) / 2;
  return { hz, voicedFrames: f0s.length, frames };
}

export interface Measurement {
  f0: F0Result;
  span: SpeechSpan;
}

export function measureSamples(x: Float32Array, sr = ANALYSIS_RATE): Measurement {
  return { f0: medianF0(x, sr), span: speechSpan(x, sr) };
}

export function measureFile(file: string): Measurement {
  return measureSamples(decodeMono(file));
}
