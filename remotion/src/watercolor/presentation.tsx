import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import type { WatercolorOptions } from "../types";
import { renderMasks, type Masks } from "./mask";

const decode = (url: string): Promise<void> => {
  const img = new Image();
  img.src = url;
  return img.decode();
};

const maskStyle = (url: string): React.CSSProperties => ({
  WebkitMaskImage: `url(${url})`,
  maskImage: `url(${url})`,
  WebkitMaskSize: "100% 100%",
  maskSize: "100% 100%",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
});

// Маскований показ шару: новий кадр проступає за progress (0..1) через маску з шуму.
// Використовують і презентація TransitionSeries (проби), і шарова композиція фільму.
export const MaskedReveal: React.FC<{
  options: WatercolorOptions;
  progress: number;
  timeSec: number;
  children: React.ReactNode;
}> = ({ options, progress, timeSec, children }) => {
  // Поза проміжком (0, 1) маска не потрібна: нічого не видно або видно все без маски. Це економить рендер.
  const active = progress > 0 && progress < 1;
  // Маска залежить тільки від progress і часу, які рахуються з номера кадру.
  const masks = useMemo(() => (active ? renderMasks(options, progress, timeSec) : null), [active, options, progress, timeSec]);
  const [shown, setShown] = useState<Masks | null>(null);
  const handleRef = useRef<number | null>(null);

  // Рендер не знімає кадр, доки PNG-маска не декодована і не підставлена.
  useLayoutEffect(() => {
    if (!masks) return;
    const handle = delayRender("watercolor mask");
    handleRef.current = handle;
    let cancelled = false;
    Promise.all([decode(masks.alpha), masks.ring ? decode(masks.ring) : Promise.resolve()])
      .then(() => {
        if (!cancelled) setShown(masks);
      })
      .catch((e) => cancelRender(e));
    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [masks]);

  useLayoutEffect(() => {
    if (shown && shown === masks && handleRef.current !== null) {
      continueRender(handleRef.current);
    }
  }, [shown, masks]);

  if (progress >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  if (progress <= 0 || !shown) return <AbsoluteFill style={{ opacity: 0 }}>{children}</AbsoluteFill>;
  const edge = options.edge;
  return (
    <AbsoluteFill style={maskStyle(shown.alpha)}>
      <AbsoluteFill>{children}</AbsoluteFill>
      {edge && shown.ring ? (
        <>
          {/* Пігмент збирається по краю: кадр темнішає власним кольором, як висохла акварельна пляма. */}
          <AbsoluteFill style={{ ...maskStyle(shown.ring), mixBlendMode: "multiply" }}>{children}</AbsoluteFill>
          {edge.tint ? (
            <AbsoluteFill
              style={{
                ...maskStyle(shown.ring),
                mixBlendMode: "multiply",
                backgroundColor: edge.tint,
                opacity: edge.tintStrength,
              }}
            />
          ) : null}
        </>
      ) : null}
    </AbsoluteFill>
  );
};

const WatercolorComponent: React.FC<TransitionPresentationComponentProps<WatercolorOptions>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (presentationDirection !== "entering") return <AbsoluteFill>{children}</AbsoluteFill>;
  // Вхідний шот стартує разом із переходом, тож локальний кадр це кадр переходу.
  return (
    <MaskedReveal options={passedProps} progress={presentationProgress} timeSec={frame / fps}>
      {children}
    </MaskedReveal>
  );
};

export const watercolor = (options: WatercolorOptions): TransitionPresentation<WatercolorOptions> => ({
  component: WatercolorComponent,
  props: options,
});
