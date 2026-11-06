// Пропси композиції `Film`. Усе тут серіалізується в JSON. Час скрізь у номерах кадрів (30 к/с).
// Пропси будує скрипт `scripts/film-props.ts` з edit.md і timings.json, руками їх не пишуть.

import type { WatercolorOptions } from "./types";

// Рух камери: масштаб s і центр вікна (cx; cy) у частках зображення. Лінійно за кадрами від 0 до holdFrame
// (локальний кадр у вікні кадру), далі стан не змінюється. holdFrame дорівнює довжині вікна, якщо камера йде до кінця.
export type CameraSpec = {
  s0: number;
  s1: number;
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
  holdFrame: number;
};

export type FilmShot = {
  n: number; // номер кадру 1..25
  src: string; // шлях відносно public/, наприклад frames/frame-01.png
  startFrame: number; // перший кадр вікна: з нього кадр починає проступати плямами
  endFrame: number; // перший кадр після вікна (не включено)
  // Скільки кадрів нове зображення проступає плямами від startFrame (для першого кадру 0: він просто є).
  revealFrames: number;
  // Налаштування плям для цього проступання (зерно різне від переходу до переходу). null для першого кадру.
  reveal: WatercolorOptions | null;
  camera: CameraSpec;
  // Додатковий масштаб поверх камери (техномонтажна поправка, якщо на стоп-кадрі видно край паперу). 0 = без.
  scaleBump: number;
};

export type TitleElementSpec = {
  kind: "title" | "author" | "small" | "rule" | "site";
  lines: string[]; // для риски порожньо
  size: number; // висота шрифту, px (для риски: завтовшки)
  width: number; // ширина риски, px (для тексту 0)
  weight: number;
  lineHeight: number;
  color: string;
  alpha: number;
  letterSpacing: number; // em
  topPx: number;
  // Найменший дозволений розмір, px: тримається в browser-підгонці (зменшувати кроком fitStep, не нижче minSize).
  // Для назви нижче падіння, для решти тексту після цього перенос на другий рядок. Без поля: розмір не змінюється.
  minSize?: number;
  fromFrame: number; // проявляється від fromFrame до toFrame
  toFrame: number;
  rise: number; // піднімається на стільки px до свого місця
};

export type TitleSpec = {
  // Кадри, у яких титр взагалі малюється (поза ними нічого не рендериться).
  activeFrom: number;
  activeTo: number;
  blockWidth: number;
  fitStep: number;
  // Мова титру й найнижча допустима точка групи (px): для повідомлень про падіння під час підгонки.
  lang?: string;
  maxBottom?: number;
  // Текст і риска гаснуть від hideFrom до hideTo.
  hideFrom: number;
  hideTo: number;
  glow: { width: number; height: number; feather: number; centerY: number };
  elements: TitleElementSpec[];
};

// Стан тону кадру під титром: вуаль, пляма світла, розмиття, насиченість, додатковий масштаб.
export type ToneState = {
  veil: number; // непрозорість вуалі 0..1
  glow: number; // непрозорість плями світла 0..1
  blur: number; // px кадру
  saturation: number; // 1 = без змін
  scale: number; // 0.04 = +4%
};

// Від попереднього стану до `to` за плавною кривою (smoothstep) на кадрах [from, to).
export type TonePhase = { from: number; toFrame: number; to: ToneState };

export type SubtitleCard = {
  text: string;
  inFrame: number; // з цього кадру починає проявлятися
  inEnd: number; // на цьому кадрі повністю видно
  outFrame: number; // з цього кадру починає гаснути
  outEnd: number; // на цьому кадрі зникла
};

export type SubtitleStyle = {
  blockWidth: number;
  bottomY: number; // низ блоку, px від верху кадру
  size: number;
  lineHeight: number;
  letterSpacing: number;
  weight: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  shadow: string; // CSS text-shadow
  // Картка з одного слова, що не влазить у blockWidth: шрифт зменшують кроком fitStep до minSize, інакше падіння.
  fitStep?: number;
  minSize?: number;
};

export type FilmProps = {
  lang?: string; // код мовної версії: uk, en, fr, de
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  background: string; // колір паперу під усім
  // Шрифт: посилання Google Fonts і перевірки document.fonts.load (spec, text).
  font: { family: string; stack: string; url: string; checks: Array<{ spec: string; text: string }> };
  textShadow: { blur: number; color: string; alpha: number };
  // Зернистість паперу й потемніння по краях лежать на всьому фільмі.
  paper: { grain: number; vignette: number };
  tone: { initial: ToneState; phases: TonePhase[] };
  opening: TitleSpec;
  closing: TitleSpec;
  shots: FilmShot[];
  subtitles: { style: SubtitleStyle; cards: SubtitleCard[] };
  // Файл зведення відносно public/; null означає без звуку.
  audio: string | null;
  // Довідкові числа розрахунку кадрів (tD, A, S, E, D…) для звіту; композиція їх не читає.
  meta?: Record<string, unknown>;
};
