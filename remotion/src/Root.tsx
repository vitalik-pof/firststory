import React from "react";
import { Composition } from "remotion";
import { Probe, probeDuration } from "./Probe";
import type { ProbeProps } from "./types";

export const defaultProbeProps: ProbeProps = {
  frames: ["frames/frame-01.png", "frames/frame-02.png", "frames/frame-03.png", "frames/frame-04.png"],
  fps: 30,
  holdFrames: 75,
  transitionFrames: 36,
  zoomFrom: 1,
  zoomTo: 1.06,
  transition: { kind: "builtin", name: "fade" },
};

export const Root: React.FC = () => (
  <Composition
    id="TransitionProbe"
    component={Probe}
    width={540}
    height={960}
    fps={30}
    durationInFrames={probeDuration(defaultProbeProps)}
    defaultProps={defaultProbeProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: probeDuration(props),
      fps: props.fps,
    })}
  />
);
