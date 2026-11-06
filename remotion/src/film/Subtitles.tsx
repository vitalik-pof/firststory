import React from "react";
import type { SubtitleCard, SubtitleStyle } from "../film-types";
import { clamp01 } from "./math";
import { widestLine } from "./fonts";

const cardOpacity = (c: SubtitleCard, frame: number): number => {
  const fin = clamp01((frame - c.inFrame) / Math.max(1, c.inEnd - c.inFrame));
  const fout = 1 - clamp01((frame - c.outFrame) / Math.max(1, c.outEnd - c.outFrame));
  return fin * fout;
};

// Картка з одного слова, що не влазить у блок (довгі німецькі слова): шрифт зменшують кроком fitStep до minSize, інакше падіння.
// Картки з кількома словами переносяться на два рядки самі.
const fitCardSize = (text: string, style: SubtitleStyle, family: string): number => {
  if (/\s/.test(text) || style.fitStep === undefined || style.minSize === undefined) return style.size;
  let size = style.size;
  const w = (sz: number): number => widestLine([text], style.weight, sz, family, style.letterSpacing);
  while (w(size) > style.blockWidth && size - style.fitStep >= style.minSize) size -= style.fitStep;
  if (w(size) > style.blockWidth) throw new Error(`Субтитри: слово «${text}» не вміщується в ${style.blockWidth} px навіть на розмірі ${size} px.`);
  return size;
};

// Субтитри лежать поверх кадрів і титрів; у переходах участі не беруть.
export const Subtitles: React.FC<{ cards: SubtitleCard[]; style: SubtitleStyle; frame: number; frameWidth: number; frameHeight: number; stack: string; family: string }> = ({
  cards,
  style,
  frame,
  frameWidth,
  frameHeight,
  stack,
  family,
}) => {
  const visible = cards.filter((c) => frame >= c.inFrame && frame < c.outEnd);
  return (
    <>
      {visible.map((c, i) => {
        const o = cardOpacity(c, frame);
        if (o <= 0) return null;
        return (
          <div
            key={`${c.inFrame}-${i}`}
            style={{
              position: "absolute",
              left: (frameWidth - style.blockWidth) / 2,
              width: style.blockWidth,
              bottom: frameHeight - style.bottomY,
              textAlign: "center",
              fontFamily: stack,
              fontWeight: style.weight,
              fontSize: fitCardSize(c.text, style, family),
              lineHeight: style.lineHeight,
              letterSpacing: `${style.letterSpacing}em`,
              color: style.fill,
              WebkitTextStroke: `${style.strokeWidth}px ${style.stroke}`,
              paintOrder: "stroke fill",
              textShadow: style.shadow,
              opacity: o,
            }}
          >
            {c.text}
          </div>
        );
      })}
    </>
  );
};
