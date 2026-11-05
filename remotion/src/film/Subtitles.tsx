import React from "react";
import type { SubtitleCard, SubtitleStyle } from "../film-types";
import { clamp01 } from "./math";

const cardOpacity = (c: SubtitleCard, frame: number): number => {
  const fin = clamp01((frame - c.inFrame) / Math.max(1, c.inEnd - c.inFrame));
  const fout = 1 - clamp01((frame - c.outFrame) / Math.max(1, c.outEnd - c.outFrame));
  return fin * fout;
};

// Субтитри лежать поверх кадрів і титрів; у переходах участі не беруть.
export const Subtitles: React.FC<{ cards: SubtitleCard[]; style: SubtitleStyle; frame: number; frameWidth: number; frameHeight: number; stack: string }> = ({
  cards,
  style,
  frame,
  frameWidth,
  frameHeight,
  stack,
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
              fontSize: style.size,
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
