import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";

// Шрифт з Google Fonts. Перед першим кадром чекаємо document.fonts.load для кожного накреслення і document.fonts.ready,
// інакше титр і субтитри намалюються системним шрифтом.
export const useFonts = (url: string, checks: Array<{ spec: string; text: string }>): boolean => {
  const [handle] = useState(() => delayRender("Google Fonts", { timeoutInMilliseconds: 90_000 }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
    Promise.all(checks.map((c) => document.fonts.load(c.spec, c.text)))
      .then(async (loaded) => {
        const empty = checks.filter((_, i) => loaded[i]?.length === 0);
        if (empty.length) throw new Error(`Шрифт не завантажився: ${empty.map((c) => c.spec).join("; ")} (${url})`);
        await document.fonts.ready;
        if (cancelled) return;
        setReady(true);
        continueRender(handle);
      })
      .catch((e) => cancelRender(e));
    return () => {
      cancelled = true;
    };
  }, [url, checks, handle]);
  return ready;
};

let ctx: CanvasRenderingContext2D | null = null;
// Ширина найширшого рядка в px з урахуванням розрідження (em). Потрібна, щоб підігнати назву до блоку.
export const widestLine = (lines: string[], weight: number, size: number, family: string, letterSpacingEm: number): number => {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("2D canvas недоступний");
  ctx.font = `${weight} ${size}px ${family}`;
  return Math.max(...lines.map((l) => ctx!.measureText(l).width + l.length * letterSpacingEm * size));
};
