import { mulberry32, noise2D, seedNumber } from "./noise";
import type { WatercolorCharacter } from "../types";

// Сітка маски. Пропорція 9:16; маска розтягується браузером на весь кадр, тому край виходить гладким.
export const GRID_W = 360;
export const GRID_H = 640;

export type Field = {
  // "Час відкриття" кожного пікселя, рівномірно розподілений на 0..1:
  // частка площі, що вже відкрита в момент t, дорівнює t.
  open: Float32Array;
  // Випадкова "зернистість" пігменту 0..1, щоб облямівка була нерівною.
  grain: Float32Array;
  // Координати пікселів в одиницях висоти кадру (щоб відстані були круглі).
  u: Float32Array;
  v: Float32Array;
};

const fbm = (seed: string, x: number, y: number, octaves: number): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2D(`${seed}:${o}`, x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm; // приблизно -1..1
};

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type RawFn = (u: number, v: number) => number;

const makeRaw = (character: WatercolorCharacter, seed: string): RawFn => {
  const W = GRID_W / GRID_H; // 0.5625
  // Загальне викривлення простору: форма плями не кругла, а "жива".
  const warp = (u: number, v: number, amount: number): [number, number] => [
    u + amount * fbm(`${seed}:wu`, u * 2.2, v * 2.2, 3),
    v + amount * fbm(`${seed}:wv`, u * 2.2 + 9.1, v * 2.2 + 3.7, 3),
  ];
  switch (character) {
    case "bloom": {
      const cx = W * 0.46;
      const cy = 0.47;
      return (u, v) => {
        const [wu, wv] = warp(u, v, 0.09);
        const d = Math.hypot(wu - cx, wv - cy);
        return d / 0.6 + 0.26 * fbm(`${seed}:a`, u * 4, v * 4, 4) + 0.06 * fbm(`${seed}:b`, u * 16, v * 16, 2);
      };
    }
    case "corner": {
      const cx = -0.03;
      const cy = 0.74;
      return (u, v) => {
        const [wu, wv] = warp(u, v, 0.12);
        const d = Math.hypot((wu - cx) * 0.9, (wv - cy) * 0.75);
        return d / 0.78 + 0.34 * fbm(`${seed}:a`, u * 3.4, v * 3.4, 4) + 0.08 * fbm(`${seed}:b`, u * 14, v * 14, 2);
      };
    }
    case "blots": {
      const rnd = mulberry32(seedNumber(seed));
      const blots = Array.from({ length: 6 }, (_, k) => ({
        x: 0.05 + rnd() * (W - 0.1),
        y: 0.07 + ((k + rnd() * 0.8) / 6) * 0.86,
        delay: rnd() * 0.32,
        speed: 1.7 + rnd() * 1.2,
      }));
      return (u, v) => {
        const [wu, wv] = warp(u, v, 0.07);
        let best = Infinity;
        for (const b of blots) {
          best = Math.min(best, b.delay + Math.hypot(wu - b.x, wv - b.y) * b.speed);
        }
        return best + 0.2 * fbm(`${seed}:a`, u * 5, v * 5, 4) + 0.05 * fbm(`${seed}:b`, u * 18, v * 18, 2);
      };
    }
    case "wash": {
      return (u, v) => {
        // Вертикальні патьоки: шум розтягнутий уздовж y.
        const streak = fbm(`${seed}:s`, u * 17, v * 1.6, 3);
        const slow = fbm(`${seed}:a`, u * 3, v * 3, 3);
        return v * 0.86 + u * 0.08 + 0.22 * streak + 0.1 * slow + 0.04 * fbm(`${seed}:b`, u * 20, v * 20, 2);
      };
    }
    case "wet": {
      return (u, v) => {
        // Переважає велика пляма, зерно лише модулює її: виходить "вбирання", а не пил.
        const low = fbm(`${seed}:a`, u * 3.2, v * 3.2, 3);
        const mid = fbm(`${seed}:m`, u * 26, v * 26, 2);
        const fine = fbm(`${seed}:g`, u * 85, v * 85, 2);
        const fibres = fbm(`${seed}:f`, u * 60, v * 20, 2);
        return 0.62 * low + 0.22 * mid + 0.1 * fine + 0.08 * fibres;
      };
    }
  }
};

export const buildField = (character: WatercolorCharacter, seed: string): Field => {
  const n = GRID_W * GRID_H;
  const raw = makeRaw(character, seed);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const f = new Float32Array(n);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      u[i] = x / GRID_H;
      v[i] = y / GRID_H;
      f[i] = raw(u[i], v[i]);
    }
  }
  // Вирівнювання за рангом: відкрита площа росте рівно за часом, а характер краю лишається.
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => f[a] - f[b]);
  const open = new Float32Array(n);
  for (let r = 0; r < n; r++) open[order[r]] = r / (n - 1);

  const grain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = 0.5 + 0.5 * (0.6 * noise2D(`${seed}:pg`, u[i] * 60, v[i] * 60) + 0.4 * noise2D(`${seed}:pg2`, u[i] * 150, v[i] * 150));
    grain[i] = smoothstep(0.15, 0.85, g);
  }
  return { open, grain, u, v };
};
