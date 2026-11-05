import { noise3D } from "./noise";
import type { WatercolorOptions } from "../types";
import { buildField, GRID_H, GRID_W, type Field } from "./field";

const fieldCache = new Map<string, Field>();
const getField = (o: WatercolorOptions): Field => {
  const key = `${o.character}|${o.seed}`;
  let f = fieldCache.get(key);
  if (!f) {
    f = buildField(o.character, o.seed);
    fieldCache.set(key, f);
  }
  return f;
};

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export type Masks = {
  // PNG data URL: альфа = де новий кадр уже проявився.
  alpha: string;
  // PNG data URL: альфа = сила облямівки пігменту; null, якщо облямівки нема.
  ring: string | null;
};

const toDataUrl = (rgba: Uint8ClampedArray): string => {
  const canvas = document.createElement("canvas");
  canvas.width = GRID_W;
  canvas.height = GRID_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas недоступний");
  const img = new ImageData(new Uint8ClampedArray(rgba), GRID_W, GRID_H);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
};

// Маска для одного кадру переходу. Залежить тільки від progress (0..1), тож детермінована.
export const renderMasks = (o: WatercolorOptions, progress: number, timeSec = 0): Masks => {
  const field = getField(o);
  const n = GRID_W * GRID_H;
  const { soft, drift, edge } = o;
  const breath = o.breath ?? 0;
  const p = Math.min(1, Math.max(0, progress));
  // На p=0 нічого не видно, на p=1 видно все, навіть із урахуванням зсуву краю.
  const t = -(drift + breath) + p * (1 + soft + 2 * (drift + breath));
  const z = p * 1.4;

  const alpha = new Uint8ClampedArray(n * 4);
  const ring = edge ? new Uint8ClampedArray(n * 4) : null;
  const ringInner = soft * 0.5;
  for (let i = 0; i < n; i++) {
    // Край "дихає": повільний шум зсуває момент відкриття пікселя.
    const dn = drift > 0 ? noise3D(`${o.seed}:d`, field.u[i] * 7, field.v[i] * 7, z) : 0;
    // Дихання: дрібний шум у реальному часі, амплітуда мала, щоб піксель не стрибав туди-сюди.
    const bn = breath > 0 ? noise3D(`${o.seed}:b`, field.u[i] * 13, field.v[i] * 13, timeSec * 0.55) : 0;
    const s = t - field.open[i] - drift * dn - breath * bn;
    const a = smoothstep(0, soft, s);
    const k = i * 4;
    alpha[k] = alpha[k + 1] = alpha[k + 2] = 255;
    alpha[k + 3] = a * 255;
    if (ring && edge) {
      const rise = smoothstep(0, ringInner, s);
      const fall = 1 - smoothstep(ringInner, ringInner + edge.width, s);
      const r = rise * fall * (0.55 + 0.9 * field.grain[i]) * edge.strength;
      ring[k] = ring[k + 1] = ring[k + 2] = 255;
      ring[k + 3] = Math.min(1, r) * 255;
    }
  }
  return { alpha: toDataUrl(alpha), ring: ring ? toDataUrl(ring) : null };
};
