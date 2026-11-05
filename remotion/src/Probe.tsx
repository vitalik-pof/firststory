import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from "remotion";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import type { ProbeProps } from "./types";
import { makePresentation } from "./presentations";

// Тривалість шоту в послідовності: чистий показ (holdFrames) плюс переходи з обох боків.
// Крайні шоти мають перехід тільки з одного боку.
const shotDuration = (props: ProbeProps, index: number): number => {
  const last = props.frames.length - 1;
  const sides = (index > 0 ? 1 : 0) + (index < last ? 1 : 0);
  return props.holdFrames + sides * props.transitionFrames;
};

export const probeDuration = (props: ProbeProps): number => {
  const n = props.frames.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += shotDuration(props, i);
  return total - (n - 1) * props.transitionFrames;
};

// Повільний наїзд: масштаб залежить тільки від номера кадру всередині шоту.
const Shot: React.FC<{ src: string; duration: number; zoomFrom: number; zoomTo: number }> = ({
  src,
  duration,
  zoomFrom,
  zoomTo,
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, duration], [zoomFrom, zoomTo], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.sin),
  });
  return (
    <AbsoluteFill style={{ backgroundColor: "#f3ecdc", overflow: "hidden" }}>
      <Img
        src={staticFile(src)}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})`, transformOrigin: "50% 50%" }}
      />
    </AbsoluteFill>
  );
};

export const Probe: React.FC<ProbeProps> = (props) => {
  const timing = linearTiming({
    durationInFrames: props.transitionFrames,
    easing: Easing.bezier(0.45, 0, 0.35, 1),
  });
  const presentation = makePresentation(props.transition);
  const nodes: React.ReactNode[] = [];
  props.frames.forEach((src, i) => {
    if (i > 0) {
      nodes.push(<TransitionSeries.Transition key={`t${i}`} timing={timing} presentation={presentation} />);
    }
    const duration = shotDuration(props, i);
    nodes.push(
      <TransitionSeries.Sequence key={`s${i}`} durationInFrames={duration}>
        <Shot src={src} duration={duration} zoomFrom={props.zoomFrom} zoomTo={props.zoomTo} />
      </TransitionSeries.Sequence>,
    );
  });
  return (
    <AbsoluteFill style={{ backgroundColor: "#f3ecdc" }}>
      <TransitionSeries>{nodes}</TransitionSeries>
    </AbsoluteFill>
  );
};
