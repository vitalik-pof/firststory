import type { TransitionDescriptor, WatercolorOptions } from "./types";

export type Variant = {
  id: string; // коротке англійське ім'я файлу без розширення
  title: string; // назва українською для режисера
  description: string; // одне речення: як виглядає перехід
  transition: TransitionDescriptor;
};

const wc = (o: Partial<WatercolorOptions> & Pick<WatercolorOptions, "character" | "seed">): TransitionDescriptor => ({
  kind: "watercolor",
  options: { soft: 0.12, drift: 0.04, edge: null, ...o },
});

// Облямівка: власний колір кадру збирається по краю плями.
const PIGMENT_EDGE = { strength: 1, width: 0.07, tint: null, tintStrength: 0 } as const;

export const VARIANTS: Variant[] = [
  {
    id: "fade",
    title: "Тихе розчинення",
    description: "Класичне плавне перетікання одного кадру в інший, без жодного руху, найспокійніше.",
    transition: { kind: "builtin", name: "fade" },
  },
  {
    id: "linear-blur",
    title: "Розмите розчинення",
    description: "Обидва кадри на мить розмиваються, зливаються і знов стають різкими, як погляд крізь сльози.",
    transition: { kind: "builtin", name: "linearBlur", options: { intensity: 0.12 } },
  },
  {
    id: "zoom-in-out",
    title: "Відступ і наїзд",
    description: "Старий кадр трохи віддаляється, новий наїжджає зсередини, між ними м'яке перетікання.",
    transition: { kind: "builtin", name: "zoomInOut" },
  },
  {
    id: "crosswarp",
    title: "Хвиля-перетікання",
    description: "Кадри перетікають один в один з легкою хвилястою деформацією, як зображення на воді.",
    transition: { kind: "builtin", name: "crosswarp" },
  },
  {
    id: "dreamy-zoom",
    title: "Сонний наїзд",
    description: "Кадр м'яко розмивається й повільно наїжджає, новий проступає з туману.",
    transition: { kind: "builtin", name: "dreamyZoom" },
  },
  {
    id: "wc-bloom",
    title: "Акварель: розтікання від центру",
    description: "Новий кадр проступає з середини м'якою неправильною плямою, що розтікається до країв.",
    transition: wc({ character: "bloom", seed: "n1", soft: 0.2, drift: 0.05 }),
  },
  {
    id: "wc-bloom-edge",
    title: "Акварель: розтікання з пігментним краєм",
    description: "Пляма розтікається від центру, а по її краю збирається темніша кольорова облямівка, як у висохлої акварелі.",
    transition: wc({ character: "bloom", seed: "n2", soft: 0.07, drift: 0.05, edge: { ...PIGMENT_EDGE } }),
  },
  {
    id: "wc-corner",
    title: "Акварель: пляма з краю",
    description: "Одна велика пляма наповзає з нижнього лівого краю кадру і заливає його, край рваний і м'який.",
    transition: wc({ character: "corner", seed: "n3", soft: 0.12, drift: 0.06 }),
  },
  {
    id: "wc-blots",
    title: "Акварель: кілька плям",
    description: "Нове зображення проступає в кількох місцях одразу, плями ростуть і зливаються, край із темнішою облямівкою.",
    transition: wc({ character: "blots", seed: "n4", soft: 0.08, drift: 0.05, edge: { ...PIGMENT_EDGE, strength: 0.9, width: 0.06 } }),
  },
  {
    id: "wc-wash",
    title: "Акварель: змив згори вниз",
    description: "Новий кадр стікає зверху вниз, як мокрий мазок із патьоками, край нерівний.",
    transition: wc({ character: "wash", seed: "n5", soft: 0.1, drift: 0.04, edge: { strength: 0.7, width: 0.06, tint: null, tintStrength: 0 } }),
  },
  {
    id: "wc-wet",
    title: "Акварель: намокання паперу",
    description: "Кадр проступає по всьому аркушу зернистими плямками, наче папір намокає й пігмент осідає в текстурі.",
    transition: wc({ character: "wet", seed: "n6", soft: 0.28, drift: 0.04 }),
  },
  {
    id: "wc-wet-edge",
    title: "Акварель: намокання з теплим пігментним краєм",
    description: "Те саме зернисте проступання, але з теплою вохристою облямівкою пігменту на межі вологого й сухого.",
    transition: wc({
      character: "wet",
      seed: "n7",
      soft: 0.14,
      drift: 0.04,
      edge: { strength: 0.9, width: 0.09, tint: "#c89a5e", tintStrength: 0.45 },
    }),
  },
];
