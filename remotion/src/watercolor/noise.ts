import { createNoise2D, createNoise3D } from "simplex-noise";

// Шум із simplex-noise напряму: @remotion/noise тримає лише 10 генераторів у кеші,
// а нам потрібно більше шарів, і він перестворював би генератор на кожен виклик.
// Той самий simplex, тільки зі своїм необмеженим кешем за рядком-зерном.

const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export const mulberry32 = (seed: number) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const seedNumber = hashSeed;

const cache2 = new Map<string, ReturnType<typeof createNoise2D>>();
const cache3 = new Map<string, ReturnType<typeof createNoise3D>>();

export const noise2D = (seed: string, x: number, y: number): number => {
  let n = cache2.get(seed);
  if (!n) {
    n = createNoise2D(mulberry32(hashSeed(seed)));
    cache2.set(seed, n);
  }
  return n(x, y);
};

export const noise3D = (seed: string, x: number, y: number, z: number): number => {
  let n = cache3.get(seed);
  if (!n) {
    n = createNoise3D(mulberry32(hashSeed(seed)));
    cache3.set(seed, n);
  }
  return n(x, y, z);
};
