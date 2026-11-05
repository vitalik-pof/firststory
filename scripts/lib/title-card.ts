// Початковий титр для аніматика: розбір розділу «## Початковий титр» з edit.md (монтажер).
//
// Титр малює код, тому всі числа беруться з документа: текст, тривалість, тло (розмитий кадр 1 під
// паперовою вуаллю, пляма світла, зернистість, потемніння), шрифт і посилання на нього, розміри в
// пікселях кадру 1080×1920, вертикальні положення елементів у пікселях від верху, секунди появи,
// зникнення тексту й зняття вуалі та розмиття. Що в документі не знайшлося, заповнюється
// значенням за замовчуванням і потрапляє в warnings (нічого не вгадується мовчки).
// Результат серіалізується в JSON (його читає код сторінки огляду).

import { existsSync } from 'node:fs';
import { blockText, readDoc, splitByHeading, type Doc } from './md';
import { paths } from './paths';

export type TitleKind = 'title' | 'author' | 'small' | 'rule';

export interface TitleElement {
  kind: TitleKind;
  /** Рядки тексту (для риски порожньо). */
  lines: string[];
  /** Висота шрифту, px кадру (для риски: завтовшки). */
  size: number;
  /** Ширина риски, px кадру (для тексту 0). */
  width: number;
  weight: number;
  lineHeight: number;
  /** CSS-колір без прозорості, наприклад #2E3347. */
  color: string;
  /** Непрозорість кольору 0–1 («на 85% прозорості» у документі означає непрозорість 0.85). */
  alpha: number;
  /** Міжлітерний інтервал, em. */
  letterSpacing: number;
  /** Верх елемента, px від верху кадру 1920. */
  topPx: number;
  /** Секунди фільму: проявляється від from до to. */
  from: number;
  to: number;
  /** Піднімається на стільки px кадру до свого місця (0: без зсуву). */
  rise: number;
}

export interface TitleCard {
  /** Тривалість титру, секунди від початку фільму. */
  duration: number;
  frameWidth: number;
  frameHeight: number;
  /** Ширина текстового блоку, px кадру; блок по центру кадру. */
  blockWidth: number;
  /** Крок зменшення назви, якщо вона ширша за блок, px кадру. */
  fitStep: number;
  font: {
    family: string;
    /** Посилання Google Fonts (css2) або порожньо. */
    url: string;
    weights: number[];
  };
  fontStack: string;
  textShadow?: { blur: number; color: string; alpha: number };
  background: {
    /** Колір паперу: вуаль, основа під кадром, пляма світла. */
    paper: string;
    /** Непрозорість вуалі, 0–1. */
    veil: number;
    /** Розмиття кадру 1, px кадру. */
    blur: number;
    /** Насиченість кадру 1 (1 = без змін). */
    saturation: number;
    /** Додатковий масштаб кадру 1 (0.04 = +4%). */
    scale: number;
    grain: number;
    vignette: number;
    glow: { width: number; height: number; alpha: number; feather: number };
  };
  /** Вуаль, пляма, розмиття, насиченість і масштаб знімаються за однією кривою від from до to (секунди фільму). */
  release: { from: number; to: number };
  /** Текст і риска разом гаснуть від from до to. */
  hide: { from: number; to: number };
  elements: TitleElement[];
}

export interface TitleCardResult {
  card?: TitleCard;
  warnings: string[];
}

const N = '(\\d+(?:[.,]\\d+)?)';
const num = (s: string): number => Number(s.replace(',', '.'));
const HEX = '#([0-9A-Fa-f]{6})';
const DASH = '[–-]';

/** Титр з edit.md; без файлу, без розділу або з «немає» титру немає. */
export function parseTitleCard(story: string): TitleCardResult {
  const file = paths.storyFile(story, 'edit.md');
  if (!existsSync(file)) return { warnings: [] };
  return parseTitleCardDoc(readDoc(file, 'editor'));
}

export function parseTitleCardDoc(doc: Doc): TitleCardResult {
  const { sections } = splitByHeading(doc.lines, 2);
  const sec = sections.find((s) => /^Початковий титр$/i.test(s.title));
  if (!sec) return { warnings: [] };
  const text = blockText(sec.body).trim();
  // «немає» (з крапкою, поясненням чи без) без жодного опису титра означає, що титра немає.
  if (!text || (/^(немає|нема)\b/i.test(text) && !/Тривалість/i.test(text)) || /^[—–-]$/.test(text)) return { warnings: [] };
  return parseTitleText(text);
}

export function parseTitleText(text: string): TitleCardResult {
  const warnings: string[] = [];
  const lines = text.split('\n').map((l) => l.trim());
  const miss = (what: string, fallback: string): void => void warnings.push(`Початковий титр (edit.md): ${what} не знайдено, взято ${fallback}.`);
  const bullets = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const hexOf = (s: string): string | undefined => new RegExp(HEX).exec(s)?.[0];

  // ---- тривалість
  const durM = new RegExp(`Тривалість:\\s*${N}\\s*с`, 'i').exec(text);
  const duration = durM ? num(durM[1]!) : 3;
  if (!durM) miss('«Тривалість: N с»', `${duration} с`);

  // ---- текст: нумеровані пункти з «…» (назва, автор, рядок про проєкт; риска без лапок; «/» у назві розбиває рядок)
  const quoted = lines.filter((l) => /^\d+\.\s/.test(l)).map((l) => /«([^»]*)»/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
  if (!quoted.length) {
    warnings.push('Початковий титр (edit.md): не знайдено тексту титра (пронумеровані рядки з «…»), титр у аніматику не показано.');
    return { warnings };
  }
  const [titleText, authorText, smallText] = quoted;
  if (quoted.length < 3) warnings.push(`Початковий титр (edit.md): рядків тексту ${quoted.length} замість трьох, показано стільки, скільки є.`);

  // ---- тло
  const paperM = new RegExp(`суцільний колір\\s*\`?${HEX}`, 'i').exec(text);
  const veilM = new RegExp(`суцільний колір[^;]*?з прозорістю\\s+${N}\\s*%`, 'i').exec(text);
  const blurM = new RegExp(`blur\\(\\s*${N}\\s*px\\s*\\)`, 'i').exec(text) ?? new RegExp(`Гаусове,\\s*близько\\s+${N}\\s*піксел`, 'i').exec(text);
  const satM = new RegExp(`насиченість[^.;]*?до\\s+${N}\\s*%`, 'i').exec(text);
  const grainM = new RegExp(`шум\\s+${N}\\s*(?:${DASH}\\s*${N})?\\s*%`, 'i').exec(text);
  const vigM = new RegExp(`потемніння по краях[^%]*?${N}\\s*%`, 'i').exec(text);
  const scaleM = new RegExp(`масштабі\\s*\\+${N}\\s*%`, 'i').exec(text);
  const glowM = new RegExp(`пляма світла[^]*?шириною близько\\s+${N},\\s*висотою близько\\s+${N}\\s*піксел[^]*?прозорість\\s+${N}\\s*%[^]*?розтушовка близько\\s+${N}\\s*піксел`, 'i').exec(text);
  if (!paperM) miss('кольору вуалі («суцільний колір #…»)', '#F1E9DA');
  if (!veilM) miss('прозорості вуалі («з прозорістю N%»)', '72%');
  if (!blurM) miss('розмиття («blur(Npx)» чи «Гаусове, близько N пікселів»)', '32 px');
  if (!satM) miss('насиченості кадру («знижена … до N%»)', '80%');
  if (!grainM) miss('зернистості («шум N–M%»)', '0');
  if (!vigM) miss('потемніння по краях («потемніння по краях … N%»)', '0');
  if (!scaleM) miss('додаткового масштабу («масштабі +N%»)', '0');
  if (!glowM) miss('плями світла («шириною близько W, висотою близько H пікселів … прозорість N% … розтушовка близько K пікселів»)', 'без плями');
  const grain = grainM ? (num(grainM[1]!) + (grainM[2] ? num(grainM[2]) : num(grainM[1]!))) / 2 / 100 : 0;

  // ---- зняття вуалі: «- 2.7–3.4: паперова вуаль, … знімаються разом»
  const relB = bullets.map((b) => new RegExp(`^${N}\\s*${DASH}\\s*${N}:\\s*паперова вуаль`, 'i').exec(b)).find((m) => m);
  const release = relB ? { from: num(relB[1]!), to: num(relB[2]!) } : { from: duration - 0.3, to: duration + 0.4 };
  if (!relB) miss('секунд зняття вуалі («- A–B: паперова вуаль, …»)', `${release.from}–${release.to} с`);

  // ---- блок і положення
  const bw = new RegExp(`блоці завширшки\\s+${N}\\s*піксел`, 'i').exec(text);
  if (!bw) miss('ширини текстового блоку («у блоці завширшки N пікселів»)', '840 px');
  const blockWidth = bw ? num(bw[1]!) : 840;
  const stepM = new RegExp(`кроком у\\s+${N}\\s*піксел`, 'i').exec(text);
  const layout = (label: RegExp): string => bullets.find((b) => label.test(b) && /\by\s+(?:близько\s+)?\d+/.test(b)) ?? '';
  const lay = { title: layout(/^назва:/i), rule: layout(/^риска:/i), author: layout(/^автор:/i), small: layout(/^рядок про проєкт:/i) };
  const yFrom = (l: string): { y0?: number; y1?: number } => {
    const m = new RegExp(`\\by\\s+(?:близько\\s+)?${N}(?:\\s*(?:до|${DASH})\\s*${N})?`, 'i').exec(l);
    return m ? { y0: num(m[1]!), y1: m[2] ? num(m[2]) : undefined } : {};
  };

  // ---- шрифт: «- назва: Lora 700, 96 пікселів, колір #…», «розрідження 0.02 em», «на 85% прозорості»
  const font = (label: RegExp): string => bullets.find((b) => label.test(b) && /піксел/i.test(b) && /Lora|шрифт|колір/i.test(b) && !/\by\s+(?:близько\s+)?\d+/.test(b)) ?? '';
  const fl = { title: font(/^назва:/i), author: font(/^автор:/i), small: font(/^рядок про проєкт:/i) };
  const family = /Один шрифт на весь титр:\s*([A-Za-z][\w ]*?)\s+з Google Fonts/i.exec(text)?.[1] ?? 'Lora';
  const urlM = /https:\/\/fonts\.googleapis\.com\/css2\?[^\s`'")]+/.exec(text);
  if (!urlM) miss('посилання Google Fonts («https://fonts.googleapis.com/css2?…»)', 'без завантаження, системний шрифт');
  const weights = [...new Set([...(urlM?.[0] ?? '').matchAll(/wght@([\d;]+)/g)].flatMap((m) => m[1]!.split(';').map(Number)))];
  const fontStack = `"${family}", Georgia, "Times New Roman", serif`;
  const lhM = new RegExp(`міжрядковий інтервал\\s+${N}`, 'i').exec(lay.title);
  const shadowM = new RegExp(`тінь без зсуву\\s*\`?0 0 ${N}px\`?\\s*кольору\\s*\`?${HEX}\`?\\s*на\\s+${N}\\s*%`, 'i').exec(text);

  // ---- поява й зникнення
  const apRe = new RegExp(`^${N}\\s*${DASH}\\s*${N}:`);
  const apBullets = bullets.filter((b) => apRe.test(b) && !/вуаль/i.test(b));
  const hideB = apBullets.map((b) => ({ b, m: apRe.exec(b)! })).find((x) => /гаснуть/i.test(x.b));
  const hide = hideB ? { from: num(hideB.m[1]!), to: num(hideB.m[2]!) } : { from: duration - 0.2, to: duration + 0.1 };
  if (!hideB) miss('секунд зникнення тексту («- A–B: … гаснуть»)', `${hide.from}–${hide.to} с`);
  const appear = (re: RegExp): { from: number; to: number; rise: number } | undefined => {
    const b = apBullets.find((x) => re.test(x) && !/гаснуть/i.test(x));
    const m = b ? apRe.exec(b) : null;
    if (!b || !m) return undefined;
    const r = new RegExp(`піднімається на\\s+${N}\\s*піксел`, 'i').exec(b);
    return { from: num(m[1]!), to: num(m[2]!), rise: r ? num(r[1]!) : 0 };
  };
  const ap = { small: appear(/рядок про проєкт/i), rule: appear(/риск/i), author: appear(/автор/i), title: appear(/назв/i) };
  const order: TitleKind[] = ['title', 'rule', 'author', 'small'];
  const defaultAp: Record<TitleKind, { from: number; to: number; rise: number }> = {
    title: { from: 0, to: 0.3, rise: 0 },
    rule: { from: 0.1, to: 0.4, rise: 0 },
    author: { from: 0.15, to: 0.4, rise: 0 },
    small: { from: 0.2, to: 0.45, rise: 0 },
  };
  for (const k of order) if (!ap[k]) miss(`секунд появи елемента «${k}» («- A–B: …» у «Як з'являється»)`, `${defaultAp[k].from}–${defaultAp[k].to} с`);

  // ---- елементи
  const defaultTop: Record<TitleKind, number> = { title: 540, rule: 826, author: 882, small: 990 };
  const text3: Record<'title' | 'author' | 'small', string | undefined> = { title: titleText, author: authorText, small: smallText };
  const mk = (kind: TitleKind): TitleElement | undefined => {
    const a = ap[kind] ?? defaultAp[kind];
    const { y0, y1 } = yFrom(lay[kind]);
    if (y0 === undefined) miss(`вертикального положення «${kind}» («y N»)`, `${defaultTop[kind]} px`);
    const top = y0 ?? defaultTop[kind];
    if (kind === 'rule') {
      const w = new RegExp(`завширшки\\s+${N}`, 'i').exec(lay.rule);
      const th = new RegExp(`завтовшки\\s+${N}\\s*піксел`, 'i').exec(lay.rule);
      const colorB = bullets.find((b) => /^риска:/i.test(b) && hexOf(b)) ?? '';
      if (!w || !th) miss('розмірів риски («завтовшки N пікселів, завширшки M пікселів»)', '4×180 px');
      return { kind, lines: [], size: th ? num(th[1]!) : 4, width: w ? num(w[1]!) : 180, weight: 400, lineHeight: 1, color: hexOf(colorB) ?? '#B5502F', alpha: 1, letterSpacing: 0, topPx: top, from: a.from, to: a.to, rise: 0 };
    }
    const t = text3[kind];
    if (!t) return undefined;
    const f = fl[kind];
    const ls = kind === 'title' ? t.split('/').map((x) => x.trim()).filter(Boolean) : [t];
    const sizeM = new RegExp(`${N}\\s*піксел`, 'i').exec(f);
    if (!sizeM) miss(`розміру шрифту «${kind}» («N пікселів»)`, '48 px');
    const sz = sizeM ? num(sizeM[1]!) : 48;
    const wM = /(?:Lora|шрифт)\s+(\d{3})/i.exec(f);
    const alphaM = new RegExp(`на\\s+${N}\\s*%\\s*прозорості`, 'i').exec(f);
    const spM = new RegExp(`розрідження\\s+${N}\\s*em`, 'i').exec(f);
    // міжрядковий інтервал: заданий явно (назва) або з висоти рядка «від y A до B»
    const lh = kind === 'title' && lhM ? num(lhM[1]!) : y1 !== undefined ? Math.round(((y1 - top) / ls.length / sz) * 1000) / 1000 : 1.3;
    return {
      kind,
      lines: ls,
      size: sz,
      width: 0,
      weight: wM ? Number(wM[1]) : kind === 'title' ? 700 : 500,
      lineHeight: lh,
      color: hexOf(f) ?? '#2E3347',
      alpha: alphaM ? num(alphaM[1]!) / 100 : 1,
      letterSpacing: spM ? num(spM[1]!) : 0,
      topPx: top,
      from: a.from,
      to: a.to,
      rise: a.rise,
    };
  };
  const elements: TitleElement[] = [];
  for (const k of order) {
    const e = mk(k);
    if (e) elements.push(e);
  }
  return {
    card: {
      duration,
      frameWidth: 1080,
      frameHeight: 1920,
      blockWidth,
      fitStep: stepM ? num(stepM[1]!) : 2,
      font: { family, url: urlM?.[0] ?? '', weights },
      fontStack,
      textShadow: shadowM ? { blur: num(shadowM[1]!), color: `#${shadowM[2]!}`, alpha: num(shadowM[3]!) / 100 } : undefined,
      background: {
        paper: paperM ? `#${paperM[1]!}` : '#F1E9DA',
        veil: veilM ? num(veilM[1]!) / 100 : 0.72,
        blur: blurM ? num(blurM[1]!) : 32,
        saturation: satM ? num(satM[1]!) / 100 : 0.8,
        scale: scaleM ? num(scaleM[1]!) / 100 : 0,
        grain,
        vignette: vigM ? num(vigM[1]!) / 100 : 0,
        glow: glowM ? { width: num(glowM[1]!), height: num(glowM[2]!), alpha: num(glowM[3]!) / 100, feather: num(glowM[4]!) } : { width: 0, height: 0, alpha: 0, feather: 0 },
      },
      release,
      hide,
      elements,
    },
    warnings,
  };
}
