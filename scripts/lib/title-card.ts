// Початковий титр для аніматика: розбір розділу «## Початковий титр» з edit.md (монтажер).
//
// Титр малює код (тло, текст, поява, наплив у кадр 1), тому всі числа беруться з документа:
// текст, тривалість, кольори, розміри в пікселях кадру 1080×1920, положення у відсотках висоти,
// секунди появи й наплив. Що в документі не знайшлося, заповнюється значенням за замовчуванням
// і потрапляє в warnings (нічого не вгадується мовчки). Результат серіалізується в JSON.

import { existsSync } from 'node:fs';
import { blockText, readDoc, splitByHeading, type Doc } from './md';
import { paths } from './paths';

export type TitleKind = 'title' | 'author' | 'small' | 'rule';

export interface TitleElement {
  kind: TitleKind;
  /** Рядки тексту (для риски порожньо). */
  lines: string[];
  /** Висота шрифту, px кадру 1080 завширшки (для риски: завтовшки). */
  size: number;
  /** Ширина риски, px кадру (для тексту 0). */
  width: number;
  weight: number;
  lineHeight: number;
  /** CSS-колір без прозорості, наприклад #2E3347. */
  color: string;
  /** Прозорість кольору 0–1 (80% прозорості в документі означає непрозорість 0.8). */
  alpha: number;
  /** Міжлітерний інтервал, em. */
  letterSpacing: number;
  /** Верх елемента, % висоти кадру. */
  topPct: number;
  /** Секунди фільму: проявляється від from до to. */
  from: number;
  to: number;
  /** Піднімається на стільки px кадру до свого місця (0: без зсуву). */
  rise: number;
}

export interface TitleCard {
  /** Тривалість титру, секунди від початку фільму. */
  duration: number;
  /** Наплив у кадр 1: титр гасне, кадр проявляється. */
  crossfade: { from: number; to: number };
  background: { color: string; grain: number; vignette: number };
  /** Ширина кадру в px, у яких дано розміри. */
  frameWidth: number;
  sidePx: number;
  fontStack: string;
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
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
/** Кадр 9:16 завширшки 1080 px (формат фільму за edit.md), розміри титру дано в його пікселях. */
const c0 = { frameWidth: 1080 };

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

  // Тривалість.
  const durM = new RegExp(`Тривалість:\\s*${N}\\s*с`, 'i').exec(text);
  const cfM = new RegExp(`наплив\\s+${N}\\s*с,\\s*від\\s+${N}\\s+до\\s+${N}\\s*с`, 'i').exec(text);
  const duration = durM ? num(durM[1]!) : cfM ? num(cfM[3]!) : 3;
  if (!durM) miss('«Тривалість: N с»', `${duration} с`);
  let crossfade = { from: duration - 0.8, to: duration };
  if (cfM) crossfade = { from: num(cfM[2]!), to: num(cfM[3]!) };
  else miss('«наплив N с, від A до B с»', `від ${crossfade.from} до ${crossfade.to} с`);

  // Текст: нумеровані пункти з «…» (для назви «/» розбиває на рядки).
  const quoted = lines.filter((l) => /^\d+\.\s/.test(l)).map((l) => /«([^»]*)»/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
  if (!quoted.length) {
    warnings.push('Початковий титр (edit.md): не знайдено тексту титра (пронумеровані рядки з «…»), титр у аніматику не показано.');
    return { warnings };
  }
  const [titleText, authorText, smallText] = quoted;
  if (quoted.length < 3) warnings.push(`Початковий титр (edit.md): рядків тексту ${quoted.length} замість трьох, показано стільки, скільки є.`);

  // Тло.
  const bgLine = lines.find((l) => /^Тло:/i.test(l)) ?? '';
  const bgColor = new RegExp(HEX).exec(bgLine)?.[0];
  const grainM = new RegExp(`шум на\\s+${N}\\s*(?:${DASH}\\s*${N})?\\s*%`, 'i').exec(bgLine);
  const vigM = new RegExp(`по краях[^%]*?${N}\\s*%`, 'i').exec(bgLine);
  if (!bgColor) miss('кольору тла в рядку «Тло:»', '#F1E9DA');
  if (!grainM) miss('зернистості тла («шум на N%»)', '0');
  if (!vigM) miss('потемніння по краях («по краях … N%»)', '0');
  const grain = grainM ? (num(grainM[1]!) + (grainM[2] ? num(grainM[2]) : num(grainM[1]!))) / 2 / 100 : 0;
  const vignette = vigM ? num(vigM[1]!) / 100 : 0;

  // Положення: «Назва займає приблизно 36–46% висоти, риска близько 47%, автор близько 50%, дрібний рядок близько 54%».
  const posText = lines.find((l) => /^Де на екрані/i.test(l)) ?? '';
  const pTitle = new RegExp(`назва займає[^%]*?${N}\\s*(?:${DASH}\\s*${N})?\\s*%`, 'i').exec(posText);
  const pRule = new RegExp(`риска[^%]*?${N}\\s*%`, 'i').exec(posText);
  const pAuthor = new RegExp(`автор[^%]*?${N}\\s*%`, 'i').exec(posText);
  const pSmall = new RegExp(`дрібний рядок[^%]*?${N}\\s*%`, 'i').exec(posText);
  const sides = new RegExp(`Поля по боках не менше\\s+${N}\\s*піксел`, 'i').exec(posText);
  const titleEnd = pTitle?.[2] ? num(pTitle[2]) : undefined;
  const top = { title: pTitle ? num(pTitle[1]!) : 36, rule: pRule ? num(pRule[1]!) : 47, author: pAuthor ? num(pAuthor[1]!) : 50, small: pSmall ? num(pSmall[1]!) : 54 };
  if (!pTitle || !pRule || !pAuthor || !pSmall) miss('положення елементів у «Де на екрані»', 'стандартні відсотки (36, 47, 50, 54)');

  // Шрифт і розмір: пункти «- назва: …», «- автор: …», «- дрібний рядок: …», «- риска: …».
  const bullet = (label: RegExp): string => lines.find((l) => l.startsWith('- ') && label.test(l.slice(2))) ?? '';
  const fontLines = { title: bullet(/^назва:/i), author: bullet(/^автор:/i), small: bullet(/^дрібний рядок:/i), rule: bullet(/^риска:/i) };
  const size = (l: string, fb: number, what: string): number => {
    const m = new RegExp(`${N}\\s*піксел`, 'i').exec(l);
    if (!m) miss(`розміру в пікселях для «${what}»`, `${fb} px`);
    return m ? num(m[1]!) : fb;
  };
  const color = (l: string): string => new RegExp(HEX).exec(l)?.[0] ?? '#2E3347';
  const alpha = (l: string): number => {
    const m = new RegExp(`на\\s+${N}\\s*%\\s*прозорості`, 'i').exec(l);
    return m ? num(m[1]!) / 100 : 1;
  };
  const lhM = new RegExp(`міжрядковий інтервал[^\\d]*${N}`, 'i').exec(fontLines.title);
  const fontNames = /наприклад\s+([^),;]+?)\s+(?:або|чи)\s+([^),;\s][^),;]*?)[,)]/i.exec(text);
  const fontStack = [...(fontNames ? [fontNames[1]!, fontNames[2]!] : ['PT Serif', 'Lora']), 'Georgia', 'Times New Roman'].map((f) => `"${f.trim()}"`).join(', ') + ', serif';

  const appear = (re: RegExp): { from: number; to: number; rise: number } | undefined => {
    const b = lines.find((l) => l.startsWith('- ') && new RegExp(`^- ${N}\\s*${DASH}\\s*${N}:`).test(l) && re.test(l));
    const m = b ? new RegExp(`^- ${N}\\s*${DASH}\\s*${N}:`).exec(b) : null;
    if (!b || !m) return undefined;
    const r = new RegExp(`піднімається на\\s+${N}\\s*піксел`, 'i').exec(b);
    return { from: num(m[1]!), to: num(m[2]!), rise: r ? num(r[1]!) : 0 };
  };
  const ap = { small: appear(/дрібн/i), rule: appear(/риск/i), author: appear(/автор/i), title: appear(/назв/i) };
  const order: TitleKind[] = ['title', 'rule', 'author', 'small'];
  const defaultAp: Record<TitleKind, { from: number; to: number; rise: number }> = {
    title: { from: 0.2, to: 1, rise: 0 },
    rule: { from: 0.8, to: 1.4, rise: 0 },
    author: { from: 1, to: 1.6, rise: 0 },
    small: { from: 1.4, to: 2, rise: 0 },
  };
  for (const k of order) if (!ap[k]) miss(`секунд появи елемента «${k}» («- A–B: …» у «Як з'являється»)`, `${defaultAp[k].from}–${defaultAp[k].to} с`);

  const elements: TitleElement[] = [];
  const text3: Record<'title' | 'author' | 'small', string | undefined> = { title: titleText, author: authorText, small: smallText };
  const mk = (kind: TitleKind): TitleElement | undefined => {
    const a = ap[kind] ?? defaultAp[kind];
    const fl = fontLines[kind];
    if (kind === 'rule') {
      const w = new RegExp(`завширшки\\s+${N}\\s*піксел`, 'i').exec(fl);
      const th = new RegExp(`завтовшки\\s+${N}\\s*піксел`, 'i').exec(fl);
      if (!w || !th) miss('розмірів риски («завтовшки N пікселів, завширшки M пікселів»)', '3×160 px');
      return { kind, lines: [], size: th ? num(th[1]!) : 3, width: w ? num(w[1]!) : 160, weight: 400, lineHeight: 1, color: new RegExp(HEX).exec(fl)?.[0] ?? '#B5502F', alpha: 1, letterSpacing: 0, topPct: top.rule, from: a.from, to: a.to, rise: 0 };
    }
    const t = text3[kind];
    if (!t) return undefined;
    const ls = kind === 'title' ? t.split('/').map((x) => x.trim()).filter(Boolean) : [t];
    const sz = size(fl, kind === 'title' ? 96 : kind === 'author' ? 44 : 30, kind);
    const lh = kind === 'title' && lhM ? num(lhM[1]!) : kind === 'title' ? 1.15 : 1.3;
    // «Назва займає 36–46% висоти»: блок тексту стоїть по центру цього проміжку (з міжрядковим інтервалом він трохи вищий за проміжок).
    const blockPct = ((ls.length * sz * lh) / ((c0.frameWidth * 16) / 9)) * 100;
    return {
      kind,
      lines: ls,
      size: sz,
      width: 0,
      weight: /напівжирн/i.test(fl) ? 700 : 400,
      lineHeight: lh,
      color: color(fl),
      alpha: alpha(fl),
      letterSpacing: /розріджен/i.test(fl) ? 0.06 : 0,
      topPct: kind === 'title' && titleEnd !== undefined ? r3(top.title + (titleEnd - top.title - blockPct) / 2) : top[kind],
      from: a.from,
      to: a.to,
      rise: a.rise,
    };
  };
  for (const k of order) {
    const e = mk(k);
    if (e) elements.push(e);
  }
  return {
    card: {
      duration,
      crossfade,
      background: { color: bgColor ?? '#F1E9DA', grain, vignette },
      frameWidth: c0.frameWidth,
      sidePx: sides ? num(sides[1]!) : 120,
      fontStack,
      elements,
    },
    warnings,
  };
}
