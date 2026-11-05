// Пропси композиції `Film` (remotion/) з монтажного аркуша edit.md і timings.json.
//
// edit.md єдине джерело чисел: таблиця «Числа для збирання» вже в кадрах, її не округлюємо повторно.
// Усе, що не розбирається однозначно, дає помилку з поясненням, а не вгадується. Результат серіалізується в JSON.

import { existsSync, readFileSync } from 'node:fs';
import { blockText, readDoc, splitByHeading, type Doc, type Section } from './md';
import { paths } from './paths';
import { parseTitleCardDoc, type TitleCard } from './title-card';
import { buildCards, cardFrames, countMerges, normalizeWords, DEFAULT_RULES, DEFAULT_TIMING, type SubtitleRules, type TimingRules, type TimedWord } from './subtitles';
import { VARIANTS } from '../../remotion/src/variants';
import type { WatercolorOptions } from '../../remotion/src/types';
import type { CameraSpec, FilmProps, FilmShot, TitleElementSpec, TitleSpec, ToneState } from '../../remotion/src/film-types';

const FPS = 30;
const N = '(\\d+(?:[.,]\\d+)?)';
const DASH = '[–-]';
const num = (s: string): number => Number(s.replace(',', '.'));
const sec2f = (s: number): number => Math.round(s * FPS);
// З цієї тривалості (кадрів) і довше перехід «дихає» (breath): 2.5 с, як сказано в «Як переходи поводяться».
const BREATH_FROM_FRAMES = 75;
const BREATH = 0.012;

export class FilmSheetError extends Error {
  constructor(message: string) {
    super(`Монтажний аркуш (edit.md): ${message}`);
    this.name = 'FilmSheetError';
  }
}
const fail = (m: string): never => {
  throw new FilmSheetError(m);
};

// ---- таблиці markdown

function tableRows(sec: Section): string[][] {
  return sec.body
    .map((l) => l.text.trim())
    .filter((t) => t.startsWith('|'))
    .map((t) => t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-{3,}:?$/.test(c)));
}

function findSection(doc: Doc, level: number, re: RegExp, label: string): Section {
  const { sections } = splitByHeading(doc.lines, level);
  const s = sections.find((x) => re.test(x.title));
  if (!s) return fail(`немає розділу «${label}» (заголовок рівня ${level}).`);
  return s;
}

function col(header: string[], re: RegExp, what: string): number {
  const i = header.findIndex((h) => re.test(h));
  if (i < 0) fail(`у таблиці немає колонки «${what}»; колонки в аркуші: ${header.join(' | ')}.`);
  return i;
}

// ---- числа для збирання

export interface SheetRow {
  n: number;
  start: number;
  end: number;
  length: number;
  /** Перехід у наступний кадр, кадрів; 0 для останнього. */
  transition: number;
}

export function parseNumbers(doc: Doc): SheetRow[] {
  const { sections } = splitByHeading(doc.lines, 2);
  const sheet = sections.find((s) => /^Монтажний аркуш$/i.test(s.title));
  if (!sheet) return fail('немає розділу «Монтажний аркуш».');
  const sub = splitByHeading(sheet.body, 3).sections.find((s) => /^Числа для збирання/i.test(s.title));
  if (!sub) return fail('у «Монтажному аркуші» немає розділу «Числа для збирання».');
  const rows = tableRows(sub);
  if (rows.length < 2) return fail('таблиця «Числа для збирання» порожня.');
  const header = rows[0]!;
  const cN = col(header, /^Кадр/i, 'Кадр');
  const cS = col(header, /^Початок/i, 'Початок');
  const cE = col(header, /^Кінець/i, 'Кінець');
  const cL = col(header, /^Довжина/i, 'Довжина');
  const cT = col(header, /^Перех\S*.*кадр/i, 'Перехід у наступний, кадрів');
  const out: SheetRow[] = [];
  for (const r of rows.slice(1)) {
    const int = (s: string | undefined, what: string): number => {
      if (s === undefined || !/^\d+$/.test(s)) return fail(`у рядку кадру «${r[cN]}» поле «${what}» має бути цілим числом кадрів, а там «${s}».`);
      return Number(s);
    };
    const n = int(r[cN], 'Кадр');
    const tr = r[cT] ?? '';
    const transition = /^(немає|—|-|0)?$/i.test(tr) ? 0 : int(tr, 'Перехід у наступний, кадрів');
    out.push({ n, start: int(r[cS], 'Початок'), end: int(r[cE], 'Кінець'), length: int(r[cL], 'Довжина'), transition });
  }
  return out;
}

export function checkNumbers(rows: SheetRow[], totalFrames: number, frameCount: number): void {
  if (rows.length !== frameCount) fail(`у таблиці «Числа для збирання» ${rows.length} кадрів, а має бути ${frameCount}.`);
  rows.forEach((r, i) => {
    if (r.n !== i + 1) fail(`кадри в «Числах для збирання» мають іти підряд: на місці ${i + 1} стоїть кадр ${r.n}.`);
    if (r.end - r.start !== r.length) fail(`кадр ${r.n}: Кінець − Початок = ${r.end - r.start}, а Довжина ${r.length}.`);
    const next = rows[i + 1];
    if (next) {
      if (r.transition <= 0) fail(`кадр ${r.n}: перехід у наступний не заданий.`);
      if (r.end - next.start !== r.transition) fail(`кадр ${r.n}: Кінець(${r.n}) − Початок(${next.n}) = ${r.end - next.start}, а перехід у таблиці ${r.transition} кадрів.`);
    } else if (r.transition !== 0) fail(`останній кадр ${r.n} не може мати переходу далі.`);
  });
  if (rows[0]!.start !== 0) fail(`кадр 1 має починатися з кадру 0, а починається з ${rows[0]!.start}.`);
  const last = rows[rows.length - 1]!;
  if (last.end !== totalFrames) fail(`кадр ${last.n} закінчується на ${last.end}, а фільм має ${totalFrames} кадрів.`);
}

// ---- камера

const CENTER = /\(\s*(\d(?:[.,]\d+)?)\s*;\s*(\d(?:[.,]\d+)?)\s*\)/g;

export function parseCamera(cell: string, n: number, length: number, startFrame: number): CameraSpec {
  const label = `кадр ${n}, «Рух камери»`;
  let s0: number;
  let s1: number;
  const range = /(\d{2,3})\s*%\s*(?:→|->)\s*(\d{2,3})\s*%/.exec(cell);
  if (range) {
    s0 = num(range[1]!) / 100;
    s1 = num(range[2]!) / 100;
  } else {
    const one = /масштаб(?:і|\s)\s*(\d{2,3})\s*%/.exec(cell);
    if (!one) return fail(`${label}: не знайшов масштаб ні як «A% → B%», ні як «масштаб N%»: «${cell}».`);
    s0 = s1 = num(one[1]!) / 100;
  }
  const centers = [...cell.matchAll(CENTER)].map((m) => [num(m[1]!), num(m[2]!)] as const);
  if (centers.length < 1 || centers.length > 2) return fail(`${label}: очікую один центр «(x; y)» (без зсуву) або два через «→», знайшов ${centers.length}: «${cell}».`);
  const [c0, c1] = [centers[0]!, centers[1] ?? centers[0]!];
  // «від A до B с»: камера рухається лише до B, далі стоїть.
  let holdFrame = length;
  const hold = new RegExp(`від\\s+${N}\\s+до\\s+${N}\\s*с`).exec(cell);
  if (hold) {
    holdFrame = sec2f(num(hold[2]!)) - startFrame;
    const a = sec2f(num(hold[1]!));
    if (a !== startFrame) fail(`${label}: рух «від ${hold[1]} с» не збігається з початком вікна (${startFrame} кадрів).`);
    if (holdFrame <= 0 || holdFrame > length) fail(`${label}: кінець руху «${hold[2]} с» поза вікном кадру.`);
  }
  if (s0 < 1 || s1 < 1) fail(`${label}: масштаб менший за 100% (${s0}, ${s1}).`);
  const cam: CameraSpec = { s0, s1, cx0: c0[0], cy0: c0[1], cx1: c1[0], cy1: c1[1], holdFrame };
  // Вікно не може виходити за зображення; дрібну неточність (до 0.01) компонент поправляє сам, більшу вважаємо помилкою аркуша.
  for (const [s, cx, cy] of [[s0, c0[0], c0[1]], [s1, c1[0], c1[1]]] as const) {
    const halfW = 0.5 / s;
    const halfH = (0.5 * 1920) / 1935 / s;
    const over = Math.max(halfW - cx, cx + halfW - 1, halfH - cy, cy + halfH - 1);
    if (over > 0.01) fail(`${label}: вікно камери (масштаб ${s}, центр ${cx}; ${cy}) виходить за зображення на ${over.toFixed(3)} частки.`);
  }
  return cam;
}

export interface SheetCamera {
  n: number;
  cell: string;
  startSec: number;
  endSec: number;
}

export function parseCameraTable(doc: Doc): SheetCamera[] {
  const { sections } = splitByHeading(doc.lines, 2);
  const sheet = sections.find((s) => /^Монтажний аркуш$/i.test(s.title));
  if (!sheet) return fail('немає розділу «Монтажний аркуш».');
  const sub = splitByHeading(sheet.body, 3).sections.find((s) => /^Таблиця$/i.test(s.title));
  if (!sub) return fail('у «Монтажному аркуші» немає розділу «Таблиця».');
  const rows = tableRows(sub);
  const header = rows[0] ?? [];
  const cN = col(header, /^Кадр/i, 'Кадр');
  const cS = col(header, /^Початок/i, 'Початок, с');
  const cE = col(header, /^Кінець/i, 'Кінець, с');
  const cC = col(header, /Рух камери/i, 'Рух камери');
  return rows.slice(1).map((r) => ({ n: Number(r[cN]), cell: r[cC] ?? '', startSec: num(r[cS] ?? 'NaN'), endSec: num(r[cE] ?? 'NaN') }));
}

// ---- фінальний титр

interface ClosingParse {
  spec: TitleSpec;
  grow: { from: number; to: number; to_state: ToneState };
  cream: { from: number; to: number };
  from: ToneState;
}

const bulletsOf = (sec: Section): string[] =>
  blockText(sec.body)
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().slice(2));

export function parseClosing(doc: Doc, base: TitleCard, totalFrames: number): ClosingParse {
  const sec = findSection(doc, 2, /^Фінальний титр$/i, 'Фінальний титр');
  const text = blockText(sec.body);
  const items = text.split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\s/.test(l));
  if (items.length !== 4) fail(`у «Фінальному титрі» очікую 4 пронумеровані пункти (автор, риска, рядок про проєкт, адреса), знайшов ${items.length}.`);
  const color = (s: string): string => /#[0-9A-Fa-f]{6}/.exec(s)?.[0] ?? fail(`у пункті «${s}» немає кольору #RRGGBB.`);
  const quoted = (s: string): string => /«([^»]+)»/.exec(s)?.[1]?.trim() ?? fail(`у пункті «${s}» немає тексту в «…».`);
  const textSpec = (s: string, kind: 'author' | 'small' | 'site'): Omit<TitleElementSpec, 'topPx' | 'fromFrame' | 'toFrame' | 'rise' | 'lineHeight'> => {
    const w = /Lora\s+(\d{3})/.exec(s)?.[1] ?? fail(`у пункті «${s}» немає «Lora NNN».`);
    const size = new RegExp(`${N}\\s*піксел`).exec(s)?.[1] ?? fail(`у пункті «${s}» немає розміру «N пікселів».`);
    const ls = new RegExp(`розрідження\\s+${N}\\s*em`).exec(s)?.[1];
    const al = new RegExp(`на\\s+${N}\\s*%\\s*(?:не)?прозорості`).exec(s)?.[1];
    return { kind, lines: [quoted(s)], size: num(size), width: 0, weight: Number(w), color: color(s), alpha: al ? num(al) / 100 : 1, letterSpacing: ls ? num(ls) : 0 };
  };
  const [i1, i2, i3, i4] = items as [string, string, string, string];
  if (!/^\d+\.\s*Автор/i.test(i1) || !/риск/i.test(i2) || !/Рядок про проєкт/i.test(i3) || !/Адреса/i.test(i4)) fail('порядок пунктів «Фінального титру» має бути: автор, риска, рядок про проєкт, адреса.');
  const author = textSpec(i1, 'author');
  const small = textSpec(i3, 'small');
  const site = textSpec(i4, 'site');
  const ruleThick = new RegExp(`${N}\\s*піксел\\S*\\s*завтовшки`).exec(i2)?.[1] ?? fail('у пункті про риску немає «N пікселів завтовшки».');
  const ruleWide = new RegExp(`${N}\\s*завширшки`).exec(i2)?.[1] ?? fail('у пункті про риску немає «N завширшки».');
  const rule: TitleElementSpec = { kind: 'rule', lines: [], size: num(ruleThick), width: num(ruleWide), weight: 400, lineHeight: 1, color: color(i2), alpha: 1, letterSpacing: 0, topPx: 0, fromFrame: 0, toFrame: 0, rise: 0 };

  // положення: «- автор: від y 617 до 697;», «риска на y 753–757», «рядок про проєкт: y 813–865», «адреса: y 905–957»
  const lay = bulletsOf(sec).filter((b) => /\by\s+\d+/.test(b));
  const yOf = (re: RegExp, what: string): [number, number] => {
    const m = lay.map((b) => re.exec(b)).find((x) => x);
    if (!m) return fail(`у «Де на екрані» немає положення елемента «${what}» («y A–B»).`);
    return [num(m[1]!), num(m[2]!)];
  };
  const yAuthor = yOf(new RegExp(`автор:\\s*від y\\s+${N}\\s*(?:до|${DASH})\\s*${N}`, 'i'), 'автор');
  const yRule = yOf(new RegExp(`риска на y\\s+${N}\\s*${DASH}\\s*${N}`, 'i'), 'риска');
  const ySmall = yOf(new RegExp(`рядок про проєкт:\\s*y\\s+${N}\\s*${DASH}\\s*${N}`, 'i'), 'рядок про проєкт');
  const ySite = yOf(new RegExp(`адреса:\\s*y\\s+${N}\\s*${DASH}\\s*${N}`, 'i'), 'адреса');
  const lh = (y: [number, number], size: number): number => Math.round(((y[1] - y[0]) / size) * 1000) / 1000;
  const a: TitleElementSpec = { ...author, lineHeight: lh(yAuthor, author.size), topPx: yAuthor[0], fromFrame: 0, toFrame: 0, rise: 0 };
  rule.topPx = yRule[0];
  const sm: TitleElementSpec = { ...small, lineHeight: lh(ySmall, small.size), topPx: ySmall[0], fromFrame: 0, toFrame: 0, rise: 0 };
  const st: TitleElementSpec = { ...site, lineHeight: lh(ySite, site.size), topPx: ySite[0], fromFrame: 0, toFrame: 0, rise: 0 };

  // секунди й кадри: «- 129.70–130.00 (3891–3900): автор проявляється …»
  const tb = bulletsOf(sec)
    .map((b) => new RegExp(`^${N}\\s*${DASH}\\s*${N}\\s*\\(\\s*(\\d+)\\s*${DASH}\\s*(\\d+)\\s*\\):\\s*(.*)$`).exec(b))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ s0: num(m[1]!), s1: num(m[2]!), f0: Number(m[3]), f1: Number(m[4]), text: m[5]! }));
  const pick = (re: RegExp, what: string): (typeof tb)[number] => {
    const hit = tb.filter((t) => re.test(t.text));
    if (hit.length !== 1) return fail(`у «Як з'являється і зникає» очікую рівно один пункт про «${what}», знайшов ${hit.length}.`);
    const t = hit[0]!;
    if (Math.abs(sec2f(t.s0) - t.f0) > 1 || Math.abs(sec2f(t.s1) - t.f1) > 1) fail(`пункт про «${what}»: секунди ${t.s0}–${t.s1} і кадри ${t.f0}–${t.f1} розходяться більше ніж на кадр.`);
    return t;
  };
  const grow = pick(/^паперова вуаль росте/i, 'вуаль росте');
  const tAuthor = pick(/^автор проявляється/i, 'автор проявляється');
  const tRule = pick(/^риска виростає/i, 'риска виростає');
  const tSmall = pick(/^проявляється рядок про проєкт/i, 'проявляється рядок про проєкт');
  const tSite = pick(/^проявляється адреса/i, 'проявляється адреса');
  const out = pick(/гаснуть/i, 'текст гасне і вуаль росте до 100%');
  a.fromFrame = tAuthor.f0;
  a.toFrame = tAuthor.f1;
  a.rise = Number(new RegExp(`піднімається на\\s+${N}\\s*піксел`).exec(tAuthor.text)?.[1] ?? 0);
  rule.fromFrame = tRule.f0;
  rule.toFrame = tRule.f1;
  sm.fromFrame = tSmall.f0;
  sm.toFrame = tSmall.f1;
  st.fromFrame = tSite.f0;
  st.toFrame = tSite.f1;
  const fadeSec = new RegExp(`за\\s+${N}\\s*${DASH}\\s*${N}`).exec(out.text);
  if (!fadeSec) fail('у пункті про зникнення немає «за A–B» (секунди, коли гаснуть текст і риска).');
  const hideFrom = sec2f(num(fadeSec![1]!));
  const hideTo = sec2f(num(fadeSec![2]!));
  const creamTo = /вуаль росте від\s+\d+\s*%\s+до\s+100\s*%/.test(out.text) ? out.f1 : fail('у пункті про зникнення немає «вуаль росте від N% до 100%».');

  // тон вуалі: «від 0% до 72%», розмиття «від 0 до 32 пікселів», насиченість «від 100% до 80%», пляма «від 0% до 45%», масштаб «від 0 до +4%»
  const g = grow.text;
  const veilTo = new RegExp(`вуаль росте від\\s+\\d+\\s*%\\s+до\\s+${N}\\s*%`).exec(g)?.[1] ?? fail('у пункті про вуаль немає «вуаль росте від 0% до N%».');
  const blurTo = new RegExp(`розмиття[^,;]*?від\\s+\\d+\\s+до\\s+${N}\\s*піксел`).exec(g)?.[1] ?? fail('у пункті про вуаль немає «розмиття … від 0 до N пікселів».');
  const satTo = new RegExp(`насиченість від\\s+\\d+\\s*%\\s+до\\s+${N}\\s*%`).exec(g)?.[1] ?? fail('у пункті про вуаль немає «насиченість від 100% до N%».');
  const glowM = new RegExp(`пляма світла[^;]*?від\\s+\\d+\\s*%\\s+до\\s+${N}\\s*%\\s*\\(овал\\s+${N}\\s*×\\s*${N}\\s*піксел[^,)]*,\\s*розтушовка\\s+${N}`).exec(g);
  if (!glowM) fail('у пункті про вуаль немає «пляма світла … від 0% до N% (овал W×H пікселів, розтушовка K)».');
  const scaleTo = new RegExp(`додатковий масштаб від\\s+\\d+\\s+до\\s*\\+${N}\\s*%`).exec(g)?.[1] ?? fail('у пункті про вуаль немає «додатковий масштаб від 0 до +N%».');
  const full: ToneState = { veil: num(veilTo) / 100, glow: num(glowM![1]!) / 100, blur: num(blurTo), saturation: num(satTo) / 100, scale: num(scaleTo) / 100 };
  const clear: ToneState = { veil: 0, glow: 0, blur: 0, saturation: 1, scale: 0 };

  const els = [a, rule, sm, st];
  const top = Math.min(...els.map((e) => e.topPx));
  const bottom = Math.max(...els.map((e) => (e.kind === 'rule' ? e.topPx + e.size : e.topPx + e.lines.length * e.size * e.lineHeight)));
  const centerY = (top + bottom) / 2;
  return {
    spec: {
      activeFrom: grow.f0,
      activeTo: totalFrames,
      blockWidth: base.blockWidth,
      fitStep: base.fitStep,
      hideFrom,
      hideTo,
      glow: { width: num(glowM![2]!), height: num(glowM![3]!), feather: num(glowM![4]!), centerY },
      elements: els,
    },
    grow: { from: grow.f0, to: grow.f1, to_state: full },
    cream: { from: out.f0, to: creamTo },
    from: clear,
  };
}

// ---- початковий титр (розбір у title-card.ts, той самий, що в аніматику)

export function openingSpec(card: TitleCard): { spec: TitleSpec; initial: ToneState; releaseFrom: number; releaseTo: number } {
  const bg = card.background;
  const els: TitleElementSpec[] = card.elements.map((e) => ({
    kind: e.kind,
    lines: e.lines,
    size: e.size,
    width: e.width,
    weight: e.weight,
    lineHeight: e.lineHeight,
    color: e.color,
    alpha: e.alpha,
    letterSpacing: e.letterSpacing,
    topPx: e.topPx,
    fromFrame: e.from * FPS,
    toFrame: e.to * FPS,
    rise: e.rise,
  }));
  const top = Math.min(...els.map((e) => e.topPx));
  const bottom = Math.max(...els.map((e) => (e.kind === 'rule' ? e.topPx + e.size : e.topPx + e.lines.length * e.size * e.lineHeight)));
  return {
    spec: {
      activeFrom: 0,
      activeTo: sec2f(card.release.to),
      blockWidth: card.blockWidth,
      fitStep: card.fitStep,
      hideFrom: card.hide.from * FPS,
      hideTo: card.hide.to * FPS,
      glow: { width: bg.glow.width, height: bg.glow.height, feather: bg.glow.feather, centerY: (top + bottom) / 2 },
      elements: els,
    },
    initial: { veil: bg.veil, glow: bg.glow.alpha, blur: bg.blur, saturation: bg.saturation, scale: bg.scale },
    releaseFrom: card.release.from * FPS,
    releaseTo: card.release.to * FPS,
  };
}

// ---- субтитри: правила з розділу «Субтитри»

export interface SubtitleSpecParsed {
  rules: SubtitleRules;
  timing: TimingRules;
  style: FilmProps['subtitles']['style'];
}

const WORDS: Record<string, number> = { двох: 2, трьох: 3, чотирьох: 4 };

export function parseSubtitleSpec(doc: Doc): SubtitleSpecParsed {
  const sec = findSection(doc, 2, /^Субтитри$/i, 'Субтитри');
  const t = blockText(sec.body);
  const need = (re: RegExp, what: string): RegExpExecArray => re.exec(t) ?? fail(`у «Субтитрах» не знайшов «${what}».`);
  const wordsM = need(/до\s+(двох|трьох|чотирьох|\d+)\s+слів/i, 'до N слів');
  const maxWords = WORDS[wordsM[1]!] ?? Number(wordsM[1]);
  const maxChars = Number(need(/до\s+(\d+)\s+символів/i, 'до N символів')[1]);
  const pause = num(need(new RegExp(`пауза\\s+${N}\\s*с`, 'i'), 'пауза N с')[1]!);
  const offset = num(need(new RegExp(`start\\s*\\+\\s*${N}\\s*с`, 'i'), '`start + N с`')[1]!);
  const lead = Number(need(/за\s+(\d+)\s+кадр\S*\s+до початку свого першого слова/i, 'за N кадри до початку свого першого слова')[1]);
  const fin = Number(need(/від 0% до 100% за\s+(\d+)\s+кадр/i, 'від 0% до 100% за N кадри')[1]);
  const trail = Number(need(/через\s+(\d+)\s+кадр\S*\s+після кінця свого останнього слова/i, 'через N кадрів після кінця останнього слова')[1]);
  const fout = Number(need(/за\s+(\d+)\s+кадр\S*\s+від 100% до 0%/i, 'за N кадри від 100% до 0%')[1]);
  const min = Number(need(/не коротше ніж\s+(\d+)\s+кадр/i, 'не коротше ніж N кадрів')[1]);
  const block = Number(need(/блок завширшки\s+(\d+)\s+піксел/i, 'блок завширшки N пікселів')[1]);
  const bottom = Number(need(/Низ блоку на y\s+(\d+)/i, 'низ блоку на y N')[1]);
  const weight = Number(need(/Lora\s+(\d{3})/i, 'Lora NNN')[1]);
  const size = Number(need(new RegExp(`Lora\\s+\\d{3}(?:\\s*\\([^)]*\\))?,\\s*${N}\\s*піксел`, 'i'), 'Lora NNN (…), N пікселів')[1]);
  const lh = num(need(new RegExp(`міжрядковий інтервал\\s+${N}`, 'i'), 'міжрядковий інтервал N')[1]!);
  const ls = num(need(new RegExp(`розрідження\\s+${N}\\s*em`, 'i'), 'розрідження N em')[1]!);
  const fill = need(/заливки\s*`(#[0-9A-Fa-f]{6})`/i, 'колір заливки `#…`')[1]!;
  const strokeM = need(new RegExp(`обведення\\s*\`(#[0-9A-Fa-f]{6})\`\\s*завтовшки\\s+${N}\\s*піксел`, 'i'), 'обведення `#…` завтовшки N пікселів');
  const shM = need(/тінь\s*`([^`]+)`\s*кольору\s*`#([0-9A-Fa-f]{6})`\s*на\s+(\d+)\s*%/i, 'тінь `0 3px 14px` кольору `#…` на N%');
  const rgb = Number.parseInt(shM[2]!, 16);
  return {
    rules: { maxWords, maxChars, pauseSeconds: pause },
    timing: { fps: FPS, offsetSeconds: offset, leadFrames: lead, fadeInFrames: fin, trailFrames: trail, fadeOutFrames: fout, minOnScreenFrames: min },
    style: {
      blockWidth: block,
      bottomY: bottom,
      size,
      lineHeight: lh,
      letterSpacing: ls,
      weight,
      fill,
      stroke: strokeM[1]!,
      strokeWidth: num(strokeM[2]!),
      shadow: `${shM[1]} rgba(${(rgb >> 16) & 255}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${num(shM[3]!) / 100})`,
    },
  };
}

// ---- збирання

export interface BuildOptions {
  story: string;
  frameCount?: number;
  /** Додатковий масштаб до окремих кадрів (+2% тощо), якщо на стоп-кадрі видно край паперу. */
  bumps?: Record<number, number>;
  /** Не падати, якщо секунди в таблиці й кадри в «Числах» розходяться більше ніж на кадр. */
  allowSecondsMismatch?: boolean;
  /** Перекрити читання з диска в тестах. */
  doc?: Doc;
  timings?: { fragments: Array<{ words: TimedWord[] }> };
  audioExists?: boolean;
}

export interface BuildResult {
  props: FilmProps;
  warnings: string[];
}

export function buildFilmProps(o: BuildOptions): BuildResult {
  const warnings: string[] = [];
  const doc = o.doc ?? readDoc(paths.storyFile(o.story, 'edit.md'), 'editor');
  const frameCount = o.frameCount ?? 25;
  const head = blockText(doc.lines.slice(0, 20));
  const fmt = /(\d+)×(\d+),\s*(\d+)\s*кадр/.exec(head) ?? fail('у шапці немає «Формат: … 1080×1920, 30 кадрів на секунду».');
  if (Number(fmt[1]) !== 1080 || Number(fmt[2]) !== 1920 || Number(fmt[3]) !== FPS) fail(`формат ${fmt[1]}×${fmt[2]}, ${fmt[3]} к/с, а композиція зроблена під 1080×1920 при ${FPS} к/с.`);
  const totalM = /Загальна тривалість:\s*[\d.,]+\s*с,\s*(\d+)\s*кадр/.exec(head) ?? fail('у шапці немає «Загальна тривалість: N с, M кадрів».');
  const total = Number(totalM[1]);

  const rows = parseNumbers(doc);
  checkNumbers(rows, total, frameCount);

  // секунди з таблиці «Таблиця» проти кадрів із «Чисел»
  const cams = parseCameraTable(doc);
  if (cams.length !== frameCount) fail(`у таблиці «Таблиця» ${cams.length} кадрів, а має бути ${frameCount}.`);
  const mismatches: string[] = [];
  rows.forEach((r, i) => {
    const c = cams[i]!;
    if (c.n !== r.n) fail(`у таблиці «Таблиця» на місці ${i + 1} стоїть кадр ${c.n}.`);
    if (Math.abs(c.startSec * FPS - r.start) > 1 || Math.abs(c.endSec * FPS - r.end) > 1) {
      mismatches.push(`кадр ${r.n}: у секундах ${c.startSec}–${c.endSec} с (${(c.startSec * FPS).toFixed(1)}–${(c.endSec * FPS).toFixed(1)} кадрів), у «Числах» ${r.start}–${r.end}`);
    }
  });
  if (mismatches.length) {
    const msg = `секунди в «Таблиці» і кадри в «Числах для збирання» розходяться більше ніж на кадр: ${mismatches.join('; ')}.`;
    if (o.allowSecondsMismatch) warnings.push(msg);
    else fail(msg);
  }

  // титри
  const opened = parseTitleCardDoc(doc);
  if (!opened.card) fail(`не вдалося розібрати «Початковий титр»${opened.warnings.length ? `: ${opened.warnings.join(' ')}` : ''}.`);
  if (opened.warnings.length) fail(`«Початковий титр» розібрано з припущеннями, а я не вгадую: ${opened.warnings.join(' ')}`);
  const card = opened.card!;
  const opening = openingSpec(card);
  const closing = parseClosing(doc, card, total);
  const sub = parseSubtitleSpec(doc);

  // шрифт
  if (!card.font.url) fail('у «Початковому титрі» немає посилання Google Fonts.');
  const family = card.font.family;
  const checks = [...opening.spec.elements, ...closing.spec.elements]
    .filter((e) => e.kind !== 'rule')
    .map((e) => ({ spec: `${e.weight} ${e.size}px "${family}"`, text: e.lines.join(' ') }));
  checks.push({ spec: `${sub.style.weight} ${sub.style.size}px "${family}"`, text: 'Контакт2u ФарбаФабра абвгґдеєжзиіїйклмнопрстуфхцчшщьюя' });

  // кадри
  const wc = VARIANTS.find((v) => v.id === 'wc-blots');
  if (!wc || wc.transition.kind !== 'watercolor') fail('у remotion/src/variants.ts немає варіанта wc-blots.');
  const baseOpts = (wc!.transition as { kind: 'watercolor'; options: WatercolorOptions }).options;
  const camParsed: CameraSpec[] = rows.map((r, i) => parseCamera(cams[i]!.cell, r.n, r.length, r.start));
  const shots: FilmShot[] = rows.map((r, i) => {
    const prev = rows[i - 1];
    const reveal = prev ? prev.transition : 0;
    const opts: WatercolorOptions | null = prev
      ? { ...baseOpts, seed: i === 1 ? baseOpts.seed : `${baseOpts.seed}-${i}`, ...(reveal >= BREATH_FROM_FRAMES ? { breath: BREATH } : {}) }
      : null;
    return {
      n: r.n,
      src: `frames/frame-${String(r.n).padStart(2, '0')}.png`,
      startFrame: r.start,
      endFrame: r.end,
      revealFrames: reveal,
      reveal: opts,
      camera: camParsed[i]!,
      scaleBump: o.bumps?.[r.n] ?? 0,
    };
  });
  const last = shots[shots.length - 1]!;
  if (closing.grow.from < last.startFrame + last.revealFrames) fail(`вуаль фінального титру починає рости на кадрі ${closing.grow.from}, а кадр ${last.n} ще проступає до ${last.startFrame + last.revealFrames}.`);

  // субтитри
  const timings = o.timings ?? (JSON.parse(readFileSync(paths.timings(o.story), 'utf8')) as { fragments: Array<{ words: TimedWord[] }> });
  const words = timings.fragments.flatMap((f) => f.words);
  const merges = countMerges(words);
  if (merges.contact !== 1 || merges.farba !== 1) fail(`у timings.json очікую по одному «"Контакт ту ю"» і «"Фарба Фабра"», знайшов ${merges.contact} і ${merges.farba}: правило злиття слів у аркуші розраховане на них.`);
  const norm = normalizeWords(words);
  const relaxed: string[] = [];
  const cards = cardFrames(buildCards(norm, sub.rules, relaxed), sub.timing);
  for (const r of relaxed) warnings.push(`субтитри: фразу ${r} не можна розкласти за правилом без порушень, взято розклад із найменшим числом порушень.`);
  const firstIn = cards[0]!.inFrame;
  if (firstIn < opening.releaseTo - sec2f(0.4) - 5) warnings.push(`перша картка субтитрів на кадрі ${firstIn} починається ще до кінця титру.`);
  const lastCard = cards[cards.length - 1]!;
  if (lastCard.outEnd > closing.grow.to) fail(`остання картка субтитрів зникає на кадрі ${lastCard.outEnd}, а фінальний титр уже в повній силі з ${closing.grow.to}.`);

  const audioExists = o.audioExists ?? existsSync(paths.workFile(o.story, 'mix.mp3'));
  const props: FilmProps = {
    width: 1080,
    height: 1920,
    fps: FPS,
    durationInFrames: total,
    background: card.background.paper,
    font: { family, stack: card.fontStack, url: card.font.url, checks },
    textShadow: card.textShadow ?? { blur: 20, color: card.background.paper, alpha: 0.7 },
    paper: { grain: card.background.grain, vignette: card.background.vignette },
    tone: {
      initial: opening.initial,
      phases: [
        { from: opening.releaseFrom, toFrame: opening.releaseTo, to: closing.from },
        { from: closing.grow.from, toFrame: closing.grow.to, to: closing.grow.to_state },
        { from: closing.cream.from, toFrame: closing.cream.to, to: { ...closing.grow.to_state, veil: 1 } },
      ],
    },
    opening: opening.spec,
    closing: closing.spec,
    shots,
    subtitles: { style: sub.style, cards: cards.map((c) => ({ text: c.text, inFrame: c.inFrame, inEnd: c.inEnd, outFrame: c.outFrame, outEnd: c.outEnd })) },
    audio: audioExists ? 'mix.mp3' : null,
  };
  if (!audioExists) warnings.push('work/<id>/mix.mp3 не знайдено: фільм буде без звуку.');
  return { props, warnings };
}

/** Додаткові масштаби кадрів із stories/<id>/film-bumps.json ({"8": 0.02}); без файлу порожньо. */
export function readBumps(story: string): Record<number, number> {
  const f = paths.storyFile(story, 'film-bumps.json');
  if (!existsSync(f)) return {};
  const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, number>;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [Number(k), Number(v)]));
}
