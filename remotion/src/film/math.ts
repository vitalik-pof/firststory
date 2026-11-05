// Чиста математика фільму: камера, тон кадру під титром, поява елементів. Усе рахується з номера кадру.
import { Easing } from "remotion";
import type { CameraSpec, FilmShot, ToneState, TonePhase } from "../film-types";

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Висота кадру при cover: зображення 768×1376 вписане в 1080 завширшки.
export const IMG_W = 1080;
export const IMG_H = 1935;
export const FRAME_H = 1920;

export type CameraState = { s: number; cx: number; cy: number };

// Лінійно за кадрами між початком і кінцем вікна; центр утримується в межах зображення.
export const cameraAt = (c: CameraSpec, localFrame: number, bump = 0): CameraState => {
  const t = c.holdFrame <= 0 ? 1 : clamp01(localFrame / c.holdFrame);
  const s = lerp(c.s0, c.s1, t) + bump;
  const cx = lerp(c.cx0, c.cx1, t);
  const cy = lerp(c.cy0, c.cy1, t);
  const halfW = 0.5 / s;
  const halfH = (0.5 * FRAME_H) / IMG_H / s;
  return {
    s,
    cx: Math.min(1 - halfW, Math.max(halfW, cx)),
    cy: Math.min(1 - halfH, Math.max(halfH, cy)),
  };
};

// transform: translate(dx, dy) scale(s) для елемента 1080×1935 з transform-origin 50% 50%.
export const cameraTransform = (st: CameraState): string => {
  const dx = (0.5 - st.cx) * IMG_W * st.s;
  const dy = (0.5 - st.cy) * IMG_H * st.s;
  return `translate(${dx}px, ${dy}px) scale(${st.s})`;
};

// Крива проступання плям: та сама, що в пробах переходів.
const revealEase = Easing.bezier(0.45, 0, 0.35, 1);
export const revealProgress = (shot: FilmShot, frame: number): number => {
  if (shot.revealFrames <= 0) return 1;
  const t = (frame - shot.startFrame) / shot.revealFrames;
  return t <= 0 ? 0 : t >= 1 ? 1 : revealEase(t);
};

export const toneAt = (initial: ToneState, phases: TonePhase[], frame: number): ToneState => {
  let state = initial;
  for (const ph of phases) {
    if (frame >= ph.toFrame) {
      state = ph.to;
      continue;
    }
    if (frame <= ph.from) break;
    const t = smoothstep((frame - ph.from) / (ph.toFrame - ph.from));
    return {
      veil: lerp(state.veil, ph.to.veil, t),
      glow: lerp(state.glow, ph.to.glow, t),
      blur: lerp(state.blur, ph.to.blur, t),
      saturation: lerp(state.saturation, ph.to.saturation, t),
      scale: lerp(state.scale, ph.to.scale, t),
    };
  }
  return state;
};
