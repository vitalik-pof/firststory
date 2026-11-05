import type { TransitionDescriptor, WatercolorOptions } from "./types";

export type Variant = {
  // Сповільнення переходу відносно базових 1,2 с. Відсутнє означає звичайну швидкість.
  slow?: number;
  // Скільки кадрів фільму брати (з початку). Відсутнє означає всі чотири.
  frameCount?: number;
  // Група для index.json і бюджету.
  group?: "base" | "slow";
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
    transition: wc({ character: "bloom", seed: "n2", soft: 0.07, drift: 0.05, edge: { ...PIGMENT_EDGE, tint: "#8a6650", tintStrength: 0.3 } }),
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
    transition: wc({ character: "wet", seed: "n6", soft: 0.4, drift: 0.04 }),
  },
  {
    id: "wc-wet-edge",
    title: "Акварель: намокання з теплим пігментним краєм",
    description: "Те саме зернисте проступання, але з теплою вохристою облямівкою пігменту на межі вологого й сухого.",
    transition: wc({
      character: "wet",
      seed: "n7",
      soft: 0.22,
      drift: 0.04,
      edge: { strength: 0.8, width: 0.12, tint: "#c89a5e", tintStrength: 0.35 },
    }),
  },
];

// Повільні версії трьох відібраних режисером переходів: 1,2 с -> 6 с (x5) і 12 с (x10).
// Беремо тільки склейки 1->2 і 2->3 (три кадри), щоб шість роликів вкластися в бюджет без втрати якості.
const SLOW_BASE: Array<{ id: string; short: string; title: string }> = [
  { id: "wc-blots", short: "кілька плям", title: "Акварель: кілька плям" },
  { id: "wc-wet", short: "намокання паперу", title: "Акварель: намокання паперу" },
  { id: "wc-wet-edge", short: "намокання з пігментним краєм", title: "Акварель: намокання з теплим пігментним краєм" },
];

export const SLOW_FACTORS = [5, 10] as const;

export const SLOW_VARIANTS: Variant[] = SLOW_BASE.flatMap((b) => {
  const base = VARIANTS.find((v) => v.id === b.id);
  if (!base || base.transition.kind !== "watercolor") throw new Error(`Нема базового варіанта ${b.id}`);
  const baseOptions = base.transition.options;
  return SLOW_FACTORS.map((k): Variant => ({
    id: `${b.id}-x${k}`,
    slow: k,
    frameCount: 3,
    group: "slow",
    title: `${b.title}, у ${k} разів повільніше`,
    description: `Той самий перехід «${b.short}», розтягнутий з 1,2 до ${(1.2 * k).toFixed(0)} с, край повільно дихає (показано дві склейки).`,
    // Дихання краю в реальному часі, щоб довгий перехід не виглядав мертвим.
    transition: { kind: "watercolor", options: { ...baseOptions, breath: k >= 10 ? 0.014 : 0.012 } },
  }));
});

export const ALL_VARIANTS: Variant[] = [...VARIANTS.map((v) => ({ ...v, group: "base" as const })), ...SLOW_VARIANTS];
