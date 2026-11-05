import { fade } from "@remotion/transitions/fade";
import { linearBlur } from "@remotion/transitions/linear-blur";
import { zoomInOut } from "@remotion/transitions/zoom-in-out";
import { crosswarp } from "@remotion/transitions/crosswarp";
import { dissolve } from "@remotion/transitions/dissolve";
import { dreamyZoom } from "@remotion/transitions/dreamy-zoom";
import { ripple } from "@remotion/transitions/ripple";
import { blurSlide } from "@remotion/transitions/blur-slide";
import { none } from "@remotion/transitions/none";
import type { TransitionPresentation } from "@remotion/transitions";
import type { TransitionDescriptor } from "./types";
import { watercolor } from "./watercolor/presentation";

// Дескриптор (JSON) -> презентація (функції). Дескриптори живуть у variants.ts.
export const makePresentation = (d: TransitionDescriptor): TransitionPresentation<any> => {
  if (d.kind === "watercolor") return watercolor(d.options);
  const o = (d.options ?? {}) as any;
  switch (d.name) {
    case "fade":
      return fade(o);
    case "linearBlur":
      return linearBlur(o);
    case "zoomInOut":
      return zoomInOut(o);
    case "crosswarp":
      return crosswarp(o);
    case "dissolve":
      return dissolve(o);
    case "dreamyZoom":
      return dreamyZoom(o);
    case "ripple":
      return ripple(o);
    case "blurSlide":
      return blurSlide(o);
    case "none":
      return none();
  }
};
