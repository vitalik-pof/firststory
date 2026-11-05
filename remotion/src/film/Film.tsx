import React from "react";
import { AbsoluteFill, Html5Audio, Img, staticFile, useCurrentFrame } from "remotion";
import type { FilmProps, FilmShot } from "../film-types";
import { MaskedReveal } from "../watercolor/presentation";
import { cameraAt, cameraTransform, revealProgress, toneAt } from "./math";
import { useFonts } from "./fonts";
import { Glow, TitleText, rgba } from "./Title";
import { Subtitles } from "./Subtitles";

// Кадр зображення з рухом камери. Масштаб і зсув залежать тільки від номера кадру всередині вікна кадру.
const ShotImage: React.FC<{ shot: FilmShot; frame: number }> = ({ shot, frame }) => {
  const st = cameraAt(shot.camera, frame - shot.startFrame, shot.scaleBump);
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: (1920 - 1935) / 2,
          width: 1080,
          height: 1935,
          transformOrigin: "50% 50%",
          transform: cameraTransform(st),
        }}
      >
        <Img src={staticFile(shot.src)} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>
    </AbsoluteFill>
  );
};

// Шари: кожен наступний кадр проступає своєю маскою поверх уже видимих. Нижче за найвищий повністю
// проявлений кадр нічого не малюється. Так працюють і короткі, і довгі переходи, навіть якщо вони накладаються.
const ShotStack: React.FC<{ shots: FilmShot[]; frame: number; fps: number }> = ({ shots, frame, fps }) => {
  const active = shots.filter((s) => frame >= s.startFrame && frame < s.endFrame);
  let base = 0;
  active.forEach((s, i) => {
    if (revealProgress(s, frame) >= 1) base = i;
  });
  const drawn = active.slice(base).filter((s) => revealProgress(s, frame) > 0);
  return (
    <>
      {drawn.map((s) => {
        const p = revealProgress(s, frame);
        const inner = <ShotImage shot={s} frame={frame} />;
        if (p >= 1 || !s.reveal) return <AbsoluteFill key={s.n}>{inner}</AbsoluteFill>;
        return (
          <AbsoluteFill key={s.n}>
            <MaskedReveal options={s.reveal} progress={p} timeSec={(frame - s.startFrame) / fps}>
              {inner}
            </MaskedReveal>
          </AbsoluteFill>
        );
      })}
    </>
  );
};

const grainUrl = (opacity: number): string => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='480'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='${opacity}'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
};

export const Film: React.FC<FilmProps> = (props) => {
  const frame = useCurrentFrame();
  const fontsReady = useFonts(props.font.url, props.font.checks);
  const { width, height, fps } = props;
  if (!fontsReady) return <AbsoluteFill style={{ backgroundColor: props.background }} />;

  const tone = toneAt(props.tone.initial, props.tone.phases, frame);
  const toned = tone.blur > 0.01 || tone.saturation < 0.999 || tone.scale > 0.0001;
  const common = {
    frame,
    frameWidth: width,
    frameHeight: height,
    paper: props.background,
    family: props.font.family,
    stack: props.font.stack,
    shadow: props.textShadow,
  };
  const paperLayer = `radial-gradient(ellipse at center, rgba(60, 40, 20, 0) 55%, rgba(60, 40, 20, ${props.paper.vignette}) 100%), ${grainUrl(props.paper.grain)}`;

  return (
    <AbsoluteFill style={{ backgroundColor: props.background, overflow: "hidden" }}>
      {/* Кадри з тоном під титром: розмиття, насиченість, додатковий масштаб. */}
      <AbsoluteFill
        style={
          toned
            ? { filter: `blur(${tone.blur}px) saturate(${tone.saturation})`, transform: `scale(${1 + tone.scale})`, transformOrigin: "50% 50%" }
            : undefined
        }
      >
        <ShotStack shots={props.shots} frame={frame} fps={fps} />
      </AbsoluteFill>
      {/* Паперова вуаль, пляма світла, зернистість і потемніння, далі текст титрів. */}
      {tone.veil > 0 ? <AbsoluteFill style={{ backgroundColor: rgba(props.background, tone.veil) }} /> : null}
      {[props.opening, props.closing].map((spec, i) =>
        frame >= spec.activeFrom && frame < spec.activeTo ? <Glow key={i} spec={spec} alpha={tone.glow} paper={props.background} frameWidth={width} /> : null,
      )}
      <AbsoluteFill style={{ backgroundImage: paperLayer }} />
      <TitleText spec={props.opening} {...common} />
      <TitleText spec={props.closing} {...common} />
      <Subtitles cards={props.subtitles.cards} style={props.subtitles.style} frame={frame} frameWidth={width} frameHeight={height} stack={props.font.stack} />
      {props.audio ? <Html5Audio src={staticFile(props.audio)} /> : null}
    </AbsoluteFill>
  );
};

// Мінімальні пропси для Студії та selectComposition; справжні будує scripts/film-props.ts.
export const emptyFilmProps: FilmProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 30,
  background: "#F1E9DA",
  font: { family: "Lora", stack: '"Lora", Georgia, serif', url: "https://fonts.googleapis.com/css2?family=Lora:wght@500;700&subset=cyrillic&display=swap", checks: [] },
  textShadow: { blur: 20, color: "#F1E9DA", alpha: 0.7 },
  paper: { grain: 0, vignette: 0 },
  tone: { initial: { veil: 0, glow: 0, blur: 0, saturation: 1, scale: 0 }, phases: [] },
  opening: { activeFrom: 0, activeTo: 0, blockWidth: 840, fitStep: 2, hideFrom: 0, hideTo: 1, glow: { width: 0, height: 0, feather: 0, centerY: 0 }, elements: [] },
  closing: { activeFrom: 0, activeTo: 0, blockWidth: 840, fitStep: 2, hideFrom: 0, hideTo: 1, glow: { width: 0, height: 0, feather: 0, centerY: 0 }, elements: [] },
  shots: [],
  subtitles: {
    style: { blockWidth: 880, bottomY: 1488, size: 60, lineHeight: 1.2, letterSpacing: 0.01, weight: 700, fill: "#FBF6EA", stroke: "#232738", strokeWidth: 7, shadow: "0 3px 14px rgba(20,22,34,0.55)" },
    cards: [],
  },
  audio: null,
};
