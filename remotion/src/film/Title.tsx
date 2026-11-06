import React from "react";
import type { TitleSpec, TitleElementSpec } from "../film-types";
import { clamp01 } from "./math";
import { widestLine } from "./fonts";
import { splitTwoLines } from "./linebreak";

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

export type LaidOut = { size: number; lines: string[]; top: number };

// Розкладка групи титру в браузері (потрібні виміри тексту): за edit.md кожен текст влазить у блок blockWidth.
// Назва: шрифт зменшують кроком fitStep до minSize, нижче падіння з назвою мови й рядка. Автор, рядок про проєкт, сайт:
// зменшують до minSize, потім переносять на другий рядок за тим самим правилом розриву, що й назву (і всі
// елементи під ним зсуваються вниз на висоту доданого рядка). Низ групи нижчий за maxBottom: падіння.
// Результат залежить лише від пропсів і шрифту, тож однаковий на кожному кадрі; кешується за spec.
const layoutCache = new WeakMap<TitleSpec, LaidOut[]>();
export const layoutTitle = (spec: TitleSpec, family: string): LaidOut[] => {
  const cached = layoutCache.get(spec);
  if (cached) return cached;
  const lang = spec.lang ?? "?";
  const out: LaidOut[] = [];
  let shift = 0;
  let bottom = 0;
  for (const e of spec.elements) {
    if (e.kind === "rule") {
      out.push({ size: e.size, lines: [], top: e.topPx + shift });
      bottom = Math.max(bottom, e.topPx + shift + e.size);
      continue;
    }
    const widest = (lines: string[], size: number): number => widestLine(lines, e.weight, size, family, e.letterSpacing);
    let size = e.size;
    let lines = e.lines;
    const min = e.minSize ?? e.size;
    while (widest(lines, size) > spec.blockWidth + 0.5 && size - spec.fitStep >= min) size -= spec.fitStep;
    if (widest(lines, size) > spec.blockWidth + 0.5) {
      if (e.kind === "title") {
        throw new Error(`Титр (${lang}): назва «${lines.join(" / ")}» не вміщується в ${spec.blockWidth} px навіть на найменшому розмірі ${min} px (ширший рядок ${Math.round(widest(lines, size))} px). Скоротіть назву в «Титрах» сценарію.`);
      }
      const two = splitTwoLines(lines.join(" "));
      if (two.length < 2 || widest(two, size) > spec.blockWidth + 0.5) {
        throw new Error(`Титр (${lang}): рядок «${lines.join(" ")}» не вміщується в ${spec.blockWidth} px навіть після переносу на другий рядок на розмірі ${size} px. Скоротіть текст у «Титрах» сценарію.`);
      }
      lines = two;
      const top = e.topPx + shift;
      out.push({ size, lines, top });
      bottom = Math.max(bottom, top + lines.length * size * e.lineHeight);
      shift += size * e.lineHeight; // додатковий рядок зсуває все, що нижче
      continue;
    }
    out.push({ size, lines, top: e.topPx + shift });
    bottom = Math.max(bottom, e.topPx + shift + lines.length * size * e.lineHeight);
  }
  if (spec.maxBottom !== undefined && bottom > spec.maxBottom) {
    throw new Error(`Титр (${lang}): низ групи на y ${Math.round(bottom)} нижчий за ${spec.maxBottom}: текст завеликий. Скоротіть тексти в «Титрах» сценарію.`);
  }
  layoutCache.set(spec, out);
  return out;
};

const El: React.FC<{ e: TitleElementSpec; spec: TitleSpec; c: Common; laid: LaidOut }> = ({ e, spec, c, laid }) => {
  const k = clamp01((c.frame - e.fromFrame) / Math.max(1, e.toFrame - e.fromFrame));
  const h = 1 - clamp01((c.frame - spec.hideFrom) / Math.max(1, spec.hideTo - spec.hideFrom));
  const opacity = k * h;
  if (opacity <= 0) return null;
  if (e.kind === "rule") {
    return (
      <div
        style={{
          position: "absolute",
          top: laid.top,
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
        top: laid.top,
        left: (c.frameWidth - spec.blockWidth) / 2,
        width: spec.blockWidth,
        boxSizing: "border-box",
        textAlign: "center",
        whiteSpace: "nowrap",
        fontSize: laid.size,
        fontWeight: e.weight,
        lineHeight: e.lineHeight,
        color: rgba(e.color, e.alpha),
        letterSpacing: `${e.letterSpacing}em`,
        textShadow: `0 0 ${c.shadow.blur}px ${rgba(c.shadow.color, c.shadow.alpha)}`,
        opacity,
        transform: e.rise ? `translateY(${(1 - k) * e.rise}px)` : undefined,
      }}
    >
      {laid.lines.map((l, i) => (
        <span key={i} style={{ display: "block", width: "max-content", margin: "0 auto", paddingLeft: pad }}>
          {l}
        </span>
      ))}
    </div>
  );
};

export const TitleText: React.FC<{ spec: TitleSpec } & Common> = ({ spec, ...c }) => {
  if (c.frame < spec.activeFrom || c.frame >= spec.activeTo) return null;
  const laid = layoutTitle(spec, c.family);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: c.stack }}>
      {spec.elements.map((e, i) => (
        <El key={i} e={e} spec={spec} c={c} laid={laid[i]!} />
      ))}
    </div>
  );
};
