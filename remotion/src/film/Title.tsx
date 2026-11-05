import React from "react";
import type { TitleSpec, TitleElementSpec } from "../film-types";
import { clamp01 } from "./math";
import { widestLine } from "./fonts";

export const rgba = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

type Common = {
  frame: number;
  frameWidth: number;
  frameHeight: number;
  paper: string;
  family: string;
  stack: string;
  shadow: { blur: number; color: string; alpha: number };
};

// Пляма світла під текстом: овал кольору паперу, прозорість alpha посередині до 0 на краях.
export const Glow: React.FC<{ spec: TitleSpec; alpha: number; paper: string; frameWidth: number }> = ({ spec, alpha, paper, frameWidth }) => {
  const g = spec.glow;
  if (alpha <= 0 || g.width <= 0) return null;
  const solid = Math.max(0, 1 - g.feather / (Math.min(g.width, g.height) / 2)) * 100;
  return (
    <div
      style={{
        position: "absolute",
        left: (frameWidth - g.width) / 2,
        top: g.centerY - g.height / 2,
        width: g.width,
        height: g.height,
        background: `radial-gradient(closest-side, ${rgba(paper, 1)} ${solid}%, ${rgba(paper, 0)} 100%)`,
        opacity: alpha,
      }}
    />
  );
};

const El: React.FC<{ e: TitleElementSpec; spec: TitleSpec; c: Common; size: number }> = ({ e, spec, c, size }) => {
  const k = clamp01((c.frame - e.fromFrame) / Math.max(1, e.toFrame - e.fromFrame));
  const h = 1 - clamp01((c.frame - spec.hideFrom) / Math.max(1, spec.hideTo - spec.hideFrom));
  const opacity = k * h;
  if (opacity <= 0) return null;
  if (e.kind === "rule") {
    return (
      <div
        style={{
          position: "absolute",
          top: e.topPx,
          left: (c.frameWidth - e.width) / 2,
          width: e.width,
          height: e.size,
          background: e.color,
          opacity,
          transform: `scaleX(${k})`,
          transformOrigin: "center",
        }}
      />
    );
  }
  // letter-spacing додає проміжок і після останньої літери: padding-left на ту саму величину вирівнює рядок по центру.
  const pad = e.letterSpacing > 0 ? `${e.letterSpacing}em` : 0;
  return (
    <div
      style={{
        position: "absolute",
        top: e.topPx,
        left: (c.frameWidth - spec.blockWidth) / 2,
        width: spec.blockWidth,
        boxSizing: "border-box",
        textAlign: "center",
        whiteSpace: "nowrap",
        fontSize: size,
        fontWeight: e.weight,
        lineHeight: e.lineHeight,
        color: rgba(e.color, e.alpha),
        letterSpacing: `${e.letterSpacing}em`,
        textShadow: `0 0 ${c.shadow.blur}px ${rgba(c.shadow.color, c.shadow.alpha)}`,
        opacity,
        transform: e.rise ? `translateY(${(1 - k) * e.rise}px)` : undefined,
      }}
    >
      {e.lines.map((l, i) => (
        <span key={i} style={{ display: "block", width: "max-content", margin: "0 auto", paddingLeft: pad }}>
          {l}
        </span>
      ))}
    </div>
  );
};

// Підігнати назву: якщо найширший рядок ширший за блок, зменшувати всі рядки однаково кроком fitStep.
export const fitSize = (e: TitleElementSpec, spec: TitleSpec, family: string): number => {
  if (e.kind !== "title") return e.size;
  let size = e.size;
  for (let guard = 0; guard < 80 && size > 20; guard++) {
    if (widestLine(e.lines, e.weight, size, family, e.letterSpacing) <= spec.blockWidth + 0.5) break;
    size -= spec.fitStep;
  }
  return size;
};

export const TitleText: React.FC<{ spec: TitleSpec } & Common> = ({ spec, ...c }) => {
  if (c.frame < spec.activeFrom || c.frame >= spec.activeTo) return null;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: c.stack }}>
      {spec.elements.map((e, i) => (
        <El key={i} e={e} spec={spec} c={c} size={fitSize(e, spec, c.family)} />
      ))}
    </div>
  );
};
