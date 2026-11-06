// Пропси композиції `Film` (remotion/) з монтажного аркуша edit.md і таймінгів мови.
//
// Аркуш не мовний: він дає правила прив'язки кадрів до фрагментів озвучення (`Fn.start`, `Fn.end`, `Fn.Sk`,
// `Fn.Wk/N`), номінальні переходи, камеру числами й правила титрів та субтитрів. Кадри кожної мови рахуються
// з її timings.json за розділом «Алгоритм» (lib/film-frames.ts, цілі мілісекунди й кадри). Тексти титрів і
// написання назв для субтитрів: для української з edit.md, для інших мов із розділів «Титри» і «Назви»
// мовного script.md. Усе, що не розбирається однозначно чи не застосовується, дає помилку з поясненням,
// а не вгадується. Результат серіалізується в JSON.

import { existsSync, readFileSync } from 'node:fs';
import { blockText, readDoc, splitByHeading, type Doc, type Section } from './md';
import { parseScript, type ScriptDoc } from './docs';
import { FINAL_TITLE_FRAMES, FPS } from './film-time';
import { FrameRuleError, parseRule, planFrames, type AnchorRule, type ExceptionRow, type FramePlan, type TimingsT } from './film-frames';
import { DEFAULT_LANG, isDefaultLang, normalizeLang, paths } from './paths';
import { parseTitleCardDoc, type TitleCard } from './title-card';
import { buildCards, cardFrames, normalizeWordsLang, UK_NAMES, type NameRule, type SubtitleRules, type TimingRules } from './subtitles';
import { VARIANTS } from '../../remotion/src/variants';
import { splitTwoLines } from '../../remotion/src/film/linebreak';
import type { WatercolorOptions } from '../../remotion/src/types';
import type { CameraSpec, FilmProps, FilmShot, TitleElementSpec, TitleSpec, ToneState } from '../../remotion/src/film-types';

const N = '(\\d+(?:[.,]\\d+)?)';
const DASH = '[–-]';
const num = (s: string): number => Number(s.replace(',', '.'));
// З цієї тривалості (кадрів) і довше перехід «дихає» (breath): 2.5 с, як сказано в кроці 9 алгоритму.
const BREATH_FROM_FRAMES = 75;
const BREATH = 0.012;
/** Чисте вікно кадру не менше секунди (крок 7 алгоритму). */
const MIN_CLEAN_FRAMES = 30;
const FRAME_COUNT = 25;
const FRAGMENT_COUNT = 17;

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

/** Підрозділ рівня 3 у «Монтажному аркуші». */
function sheetSub(doc: Doc, re: RegExp, label: string): Section {
  const sheet = findSection(doc, 2, /^Монтажний аркуш$/i, 'Монтажний аркуш');
  const sub = splitByHeading(sheet.body, 3).sections.find((s) => re.test(s.title));
  if (!sub) return fail(`у «Монтажному аркуші» немає розділу «${label}».`);
  return sub;
}

function col(header: string[], re: RegExp, what: string): number {
  const i = header.findIndex((h) => re.test(h));
  if (i < 0) fail(`у таблиці немає колонки «${what}»; колонки в аркуші: ${header.join(' | ')}.`);
  return i;
}

// ---- таблиця прив'язок і переходів

export interface AnchorTable {
  /** Правила кадрів 2…25 (індекс = номер кадру). */
  rules: Array<AnchorRule | undefined>;
  /** Номінальні переходи D(N), N = 1…24 (індекс = N). */
  nominalD: number[];
  /** Скільки речень потрібно у фрагментах для правил Fn.Sk. */
  sentenceCounts: Record<number, number>;
}

export function parseAnchorTable(doc: Doc): AnchorTable {
  const sub = sheetSub(doc, /^Таблиця прив['’]язок/i, 'Таблиця прив\'язок і переходів');
  const rows = tableRows(sub);
  if (rows.length < 2) return fail('таблиця прив\'язок порожня.');
  const header = rows[0]!;
  const cN = col(header, /^Кадр/i, 'Кадр');
  const cA = col(header, /^Прив['’]язка/i, 'Прив\'язка');
  const cT = col(header, /^Перех/i, 'Перехід у наступний');
  const token = (cell: string | undefined): string | undefined => /`([^`]+)`/.exec(cell ?? '')?.[1];
  const rules: Array<AnchorRule | undefined> = new Array<AnchorRule | undefined>(FRAME_COUNT + 1).fill(undefined);
  const nominalD: number[] = new Array<number>(FRAME_COUNT).fill(0);
  const seen = new Set<number>();
  for (const r of rows.slice(1)) {
    const n = Number(r[cN]);
    if (!Number.isInteger(n) || n < 1 || n > FRAME_COUNT) return fail(`у таблиці прив'язок кадр «${r[cN]}» поза 1…${FRAME_COUNT}.`);
    seen.add(n);
    const a = token(r[cA]);
    if (n === 1) {
      if (a !== 'START') fail(`у кадру 1 прив'язка має бути \`START\`, а є «${a ?? r[cA]}».`);
    } else {
      if (!a) fail(`у кадру ${n} колонка «Прив'язка» не починається з правила в зворотних лапках (\`Fn.…\`): «${r[cA]}».`);
      rules[n] = parseRule(a!);
    }
    if (n < FRAME_COUNT) {
      const d = /`D=(\d+)`/.exec(r[cT] ?? '')?.[1];
      if (!d) fail(`у кадру ${n} колонка «Перехід у наступний» не починається з \`D=<кадрів>\`: «${r[cT]}».`);
      nominalD[n] = Number(d);
    }
  }
  if (seen.size !== FRAME_COUNT) fail(`у таблиці прив'язок ${seen.size} кадрів, а має бути ${FRAME_COUNT}.`);
  const sentenceCounts: Record<number, number> = {};
  const line = blockText(sub.body).split('\n').find((l) => /Кількість речень, потрібна/i.test(l));
  if (line) for (const m of line.matchAll(/F(\d+)`?\s*[—-]\s*(\d+)/g)) sentenceCounts[Number(m[1])] = Number(m[2]);
  for (const r of rules) if (r?.kind === 'sentence' && sentenceCounts[r.n] === undefined) fail(`правило ${r.n} має \`Fn.Sk\`, а в рядку «Кількість речень, потрібна для Fn.Sk» немає F${r.n}.`);
  return { rules, nominalD, sentenceCounts };
}

/** «Мовні винятки»: рядки (мова, кадр, що замінюється, значення); заготовка «(порожньо)» ігнорується. */
export function parseExceptions(doc: Doc): ExceptionRow[] {
  const sheet = findSection(doc, 2, /^Монтажний аркуш$/i, 'Монтажний аркуш');
  const sub = splitByHeading(sheet.body, 3).sections.find((s) => /^Мовні винятки$/i.test(s.title));
  if (!sub) return [];
  const rows = tableRows(sub);
  const out: ExceptionRow[] = [];
  for (const r of rows.slice(1)) {
    const lang = (r[0] ?? '').replace(/`/g, '').trim();
    if (!lang || /^\(порожньо\)$/i.test(lang)) continue;
    const frame = Number(r[1]);
    const what = (r[2] ?? '').trim().charAt(0) === 'D' ? 'D' : 'A';
    const value = (r[3] ?? '').replace(/`/g, '').trim();
    if (!Number.isInteger(frame)) return fail(`у «Мовних винятках» кадр «${r[1]}» не число.`);
    if (what === 'D') out.push({ lang, frame, what, frames: Number(value) });
    else out.push({ lang, frame, what, rule: parseRule(value) });
  }
  return out;
}

// ---- камера числами

export interface CameraRow {
  n: number;
  s0: number;
  s1: number;
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

export function parseCameraNumbers(doc: Doc): CameraRow[] {
  const sub = sheetSub(doc, /^Камера числами/i, 'Камера числами');
  const rows = tableRows(sub);
  const header = rows[0] ?? [];
  const idx = (re: RegExp, what: string): number => col(header, re, what);
  const [cN, cS0, cS1, cX0, cY0, cX1, cY1] = [idx(/^Кадр/i, 'Кадр'), idx(/^s0/i, 's0'), idx(/^s1/i, 's1'), idx(/^cx0/i, 'cx0'), idx(/^cy0/i, 'cy0'), idx(/^cx1/i, 'cx1'), idx(/^cy1/i, 'cy1')];
  const out = rows.slice(1).map((r) => ({ n: Number(r[cN]), s0: num(r[cS0] ?? 'NaN') / 100, s1: num(r[cS1] ?? 'NaN') / 100, cx0: num(r[cX0] ?? 'NaN'), cy0: num(r[cY0] ?? 'NaN'), cx1: num(r[cX1] ?? 'NaN'), cy1: num(r[cY1] ?? 'NaN') }));
  if (out.length !== FRAME_COUNT) fail(`у таблиці «Камера числами» ${out.length} кадрів, а має бути ${FRAME_COUNT}.`);
  out.forEach((r, i) => {
    if (r.n !== i + 1) fail(`у «Камері числами» на місці ${i + 1} стоїть кадр ${r.n}.`);
    for (const [k, v] of Object.entries(r)) if (!Number.isFinite(v)) fail(`у «Камері числами» кадр ${r.n}: поле ${k} не число.`);
  });
  return out;
}

/** Камера кадру: лінійно за кадрами від 0 до holdFrame (довжина вікна кадру), вікно не виходить за зображення. */
export function cameraSpec(row: CameraRow, holdFrame: number): CameraSpec {
  const label = `кадр ${row.n}, «Камера числами»`;
  if (row.s0 < 1 || row.s1 < 1) fail(`${label}: масштаб менший за 100% (${row.s0}, ${row.s1}).`);
  for (const [s, cx, cy] of [[row.s0, row.cx0, row.cy0], [row.s1, row.cx1, row.cy1]] as const) {
    const halfW = 0.5 / s;
    const halfH = (0.5 * 1920) / 1935 / s;
    const over = Math.max(halfW - cx, cx + halfW - 1, halfH - cy, cy + halfH - 1);
    // Дрібну неточність (до 0.01) компонент поправляє сам, більшу вважаємо помилкою аркуша.
    if (over > 0.01) fail(`${label}: вікно камери (масштаб ${s}, центр ${cx}; ${cy}) виходить за зображення на ${over.toFixed(3)} частки.`);
  }
  return { s0: row.s0, s1: row.s1, cx0: row.cx0, cy0: row.cy0, cx1: row.cx1, cy1: row.cy1, holdFrame };
}

// ---- шапка й константи

export interface SheetConstants {
  /** Фінальний титр після кінця файлу озвучення, кадрів (F = 157). */
  tailFrames: number;
  /** Кадр, на якому закінчується розфокус початкового титру (кадри 81–102 → 102). */
  releaseEnd: number;
  /** Вуаль фінального титру починає рости на кадрі tD + veilOffset (7). */
  veilOffset: number;
}

export function parseConstants(doc: Doc): SheetConstants {
  const head = blockText(doc.lines.slice(0, 12));
  const fmt = /(\d+)×(\d+),\s*(\d+)\s*кадр/.exec(head) ?? fail('у шапці немає «Формат: … 1080×1920, 30 кадрів на секунду».');
  if (Number(fmt[1]) !== 1080 || Number(fmt[2]) !== 1920 || Number(fmt[3]) !== FPS) fail(`формат ${fmt[1]}×${fmt[2]}, ${fmt[3]} к/с, а композиція зроблена під 1080×1920 при ${FPS} к/с.`);
  const f = /F\s*=\s*(\d+)\s*кадр/.exec(head) ?? fail('у шапці («Загальна тривалість») немає «F = N кадрів» (фінальний титр після кінця файлу озвучення).');
  const sec = findSection(doc, 3, /^Як переходить у перший кадр$/i, 'Як переходить у перший кадр');
  const rel = new RegExp(`кадри\\s+(\\d+)\\s*${DASH}\\s*(\\d+)`).exec(blockText(sec.body)) ?? fail('у «Як переходить у перший кадр» немає «(кадри A–B)» зняття розфокусу.');
  const closing = blockText(findSection(doc, 2, /^Фінальний титр$/i, 'Фінальний титр').body);
  const veil = /`tD\s*\+\s*(\d+)\s*…\s*tD\s*\+\s*\d+`[^:\n]*:\s*паперова вуаль росте/.exec(closing) ?? fail('у «Фінальному титрі» немає «`tD + A … tD + B`: паперова вуаль росте …».');
  return { tailFrames: Number(f[1]), releaseEnd: Number(rel[2]), veilOffset: Number(veil[1]) };
}

// ---- титри

export interface TitleTexts {
  title: string[];
  author: string;
  project: string;
}
export interface ClosingTexts {
  author: string;
  project: string;
  site: string;
}

/** Назва двома рядками: розрив «/» чи переніс, що дав сценарист, інакше правило розриву за пробілом. */
export function titleLines(title: string | string[]): string[] {
  const lines = Array.isArray(title) ? title : title.split(/\s*\/\s*/);
  if (lines.length >= 2) return lines.map((x) => x.trim()).filter(Boolean);
  return splitTwoLines(lines[0] ?? '');
}

/** Тексти початкового титру мови: для української з edit.md (card), для інших мов із «Титрів» script.md. */
export function openingTexts(card: TitleCard, script: ScriptDoc | undefined, lang: string): TitleTexts {
  if (isDefaultLang(lang)) {
    const t = card.elements.find((e) => e.kind === 'title');
    const a = card.elements.find((e) => e.kind === 'author');
    const s = card.elements.find((e) => e.kind === 'small');
    if (!t || !a || !s) fail('у «Початковому титрі» для української немає одного з текстів (назва, автор, рядок про проєкт).');
    return { title: titleLines(t!.lines), author: a!.lines.join(' '), project: s!.lines.join(' ') };
  }
  const o = script?.titles?.opening;
  const where = `stories/<id>/${lang}/script.md, «Титри», «Початковий титр»`;
  if (!script?.titles) fail(`мова ${lang}: у ${paths.rel(paths.langFile('_', lang, 'script.md')).replace('_', '<id>')} немає розділу «Титри» (початковий титр).`);
  if (!o?.title?.length) fail(`мова ${lang}: у ${where} немає «Назва…».`);
  if (!o?.author) fail(`мова ${lang}: у ${where} немає «Автор…».`);
  if (!o?.project) fail(`мова ${lang}: у ${where} немає «Рядок про проєкт…».`);
  return { title: titleLines(o!.title!), author: o!.author!, project: o!.project! };
}

/** Тексти фінального титру: для української із «Текст» розділу «Фінальний титр» edit.md, для інших мов зі script.md. */
export function closingTexts(doc: Doc, script: ScriptDoc | undefined, lang: string): ClosingTexts {
  if (isDefaultLang(lang)) {
    const sec = findSection(doc, 2, /^Фінальний титр$/i, 'Фінальний титр');
    const items = blockText(sec.body).split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\s/.test(l));
    const q = (re: RegExp, what: string): string => {
      const it = items.find((x) => re.test(x));
      return /«([^»]+)»/.exec(it ?? '')?.[1]?.trim() ?? fail(`у «Фінальному титрі» немає пункту «${what}» з текстом у «…».`);
    };
    return { author: q(/^\d+\.\s*Автор/i, 'Автор'), project: q(/^\d+\.\s*Рядок про проєкт/i, 'Рядок про проєкт'), site: q(/^\d+\.\s*Адреса/i, 'Адреса сайту') };
  }
  const c = script?.titles?.closing;
  const where = `stories/<id>/${lang}/script.md, «Титри», «Фінальний титр»`;
  if (!c) fail(`мова ${lang}: у ${where} немає розділу (фінальний титр).`);
  if (!c?.author) fail(`мова ${lang}: у ${where} немає «Автор…».`);
  if (!c?.project) fail(`мова ${lang}: у ${where} немає «Рядок про проєкт…».`);
  if (!c?.site) fail(`мова ${lang}: у ${where} немає «Адреса сайту…».`);
  return { author: c!.author!, project: c!.project!, site: c!.site! };
}

interface ClosingParse {
  spec: TitleSpec;
  grow: { from: number; to: number; to_state: ToneState };
  cream: { from: number; to: number };
  from: ToneState;
  /** Початок вуалі: tD + зсув (кадри відносно tD). */
  veilOffset: number;
}

const bulletsOf = (sec: Section): string[] =>
  blockText(sec.body)
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().slice(2));

/** Фінальний титр: стиль і положення з edit.md, час у кадрах від tD, тексти мови. */
/** maxBottom: найнижча допустима точка групи (y 1536), та сама, що в початковому титрі: «ті самі правила розміру, переносу й падіння». */
export function parseClosing(doc: Doc, base: TitleCard, texts: ClosingTexts, tD: number, total: number, lang: string, maxBottom: number): ClosingParse {
  const sec = findSection(doc, 2, /^Фінальний титр$/i, 'Фінальний титр');
  const text = blockText(sec.body);
  const items = text.split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\s/.test(l));
  if (items.length !== 4) fail(`у «Фінальному титрі» очікую 4 пронумеровані пункти (автор, риска, рядок про проєкт, адреса), знайшов ${items.length}.`);
  const color = (s: string): string => /#[0-9A-Fa-f]{6}/.exec(s)?.[0] ?? fail(`у пункті «${s}» немає кольору #RRGGBB.`);
  const textSpec = (s: string, kind: 'author' | 'small' | 'site', value: string): Omit<TitleElementSpec, 'topPx' | 'fromFrame' | 'toFrame' | 'rise' | 'lineHeight'> => {
    const w = /Lora\s+(\d{3})/.exec(s)?.[1] ?? fail(`у пункті «${s}» немає «Lora NNN».`);
    const size = new RegExp(`${N}\\s*піксел`).exec(s)?.[1] ?? fail(`у пункті «${s}» немає розміру «N пікселів».`);
    const ls = new RegExp(`розрідження\\s+${N}\\s*em`).exec(s)?.[1];
    const al = new RegExp(`на\\s+${N}\\s*%\\s*(?:не)?прозорості`).exec(s)?.[1];
    return { kind, lines: [value], size: num(size), width: 0, weight: Number(w), color: color(s), alpha: al ? num(al) / 100 : 1, letterSpacing: ls ? num(ls) : 0 };
  };
  const [i1, i2, i3, i4] = items as [string, string, string, string];
  if (!/^\d+\.\s*Автор/i.test(i1) || !/риск/i.test(i2) || !/Рядок про проєкт/i.test(i3) || !/Адреса/i.test(i4)) fail('порядок пунктів «Фінального титру» має бути: автор, риска, рядок про проєкт, адреса.');
  const author = textSpec(i1, 'author', texts.author);
  const small = textSpec(i3, 'small', texts.project);
  const site = textSpec(i4, 'site', texts.site);
  const ruleThick = new RegExp(`${N}\\s*піксел\\S*\\s*завтовшки`).exec(i2)?.[1] ?? fail('у пункті про риску немає «N пікселів завтовшки».');
  const ruleWide = new RegExp(`${N}\\s*завширшки`).exec(i2)?.[1] ?? fail('у пункті про риску немає «N завширшки».');
  const rule: TitleElementSpec = { kind: 'rule', lines: [], size: num(ruleThick), width: num(ruleWide), weight: 400, lineHeight: 1, color: color(i2), alpha: 1, letterSpacing: 0, topPx: 0, fromFrame: 0, toFrame: 0, rise: 0 };

  // Найменші розміри й межа групи: «від 64 до 54 пікселів кроком у 2», «не менш як 38», «низ групи нижчий за y 1536».
  const minAuthor = Number(/автор:\s*від\s+\d+\s+до\s+(\d+)\s+піксел\S*\s+кроком/i.exec(text)?.[1] ?? fail('у «Фінальному титрі» немає «автор: від N до M пікселів кроком у K».'));
  const minSmall = Number(/не менш як\s+(\d+)/i.exec(text)?.[1] ?? fail('у «Фінальному титрі» немає «не менш як N» (найменший розмір дрібних рядків).'));

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
  const a: TitleElementSpec = { ...author, lineHeight: lh(yAuthor, author.size), topPx: yAuthor[0], minSize: minAuthor, fromFrame: 0, toFrame: 0, rise: 0 };
  rule.topPx = yRule[0];
  const sm: TitleElementSpec = { ...small, lineHeight: lh(ySmall, small.size), topPx: ySmall[0], minSize: minSmall, fromFrame: 0, toFrame: 0, rise: 0 };
  const st: TitleElementSpec = { ...site, lineHeight: lh(ySite, site.size), topPx: ySite[0], minSize: minSmall, fromFrame: 0, toFrame: 0, rise: 0 };

  // Час у кадрах від tD: «- `tD + 28 … tD + 37`: автор проявляється …».
  const tb = bulletsOf(sec)
    .map((b) => /^`tD\s*\+\s*(\d+)\s*…\s*tD\s*\+\s*(\d+)`[^:]*:\s*(.*)$/s.exec(b))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ f0: Number(m[1]), f1: Number(m[2]), text: m[3]! }));
  const pick = (re: RegExp, what: string): (typeof tb)[number] => {
    const hit = tb.filter((t) => re.test(t.text));
    if (hit.length !== 1) return fail(`у «Як з'являється і зникає» очікую рівно один пункт про «${what}» у вигляді «\`tD + A … tD + B\`: …», знайшов ${hit.length}.`);
    return hit[0]!;
  };
  const grow = pick(/^паперова вуаль росте/i, 'вуаль росте');
  const tAuthor = pick(/^автор проявляється/i, 'автор проявляється');
  const tRule = pick(/^риска виростає/i, 'риска виростає');
  const tSmall = pick(/^проявляється рядок про проєкт/i, 'проявляється рядок про проєкт');
  const tSite = pick(/^проявляється адреса/i, 'проявляється адреса');
  const out = pick(/гаснуть/i, 'текст гасне і вуаль росте до 100%');
  a.fromFrame = tD + tAuthor.f0;
  a.toFrame = tD + tAuthor.f1;
  a.rise = Number(new RegExp(`піднімається на\\s+${N}\\s*піксел`).exec(tAuthor.text)?.[1] ?? 0);
  rule.fromFrame = tD + tRule.f0;
  rule.toFrame = tD + tRule.f1;
  sm.fromFrame = tD + tSmall.f0;
  sm.toFrame = tD + tSmall.f1;
  st.fromFrame = tD + tSite.f0;
  st.toFrame = tD + tSite.f1;
  const fadeRel = /за\s+`tD\s*\+\s*(\d+)\s*…\s*tD\s*\+\s*(\d+)`/.exec(out.text);
  if (!fadeRel) fail('у пункті про зникнення немає «за `tD + A … tD + B`» (кадри, коли гаснуть текст і риска).');
  const hideFrom = tD + Number(fadeRel![1]);
  const hideTo = tD + Number(fadeRel![2]);
  if (!/вуаль росте від\s+\d+\s*%\s+до\s+100\s*%/.test(out.text)) fail('у пункті про зникнення немає «вуаль росте від N% до 100%».');
  const creamTo = tD + out.f1;
  if (tD + out.f1 !== total) fail(`фінальний титр закінчується на tD + ${out.f1} = ${tD + out.f1}, а фільм має ${total} кадрів (tD + F).`);

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
      activeFrom: tD + grow.f0,
      activeTo: total,
      blockWidth: base.blockWidth,
      fitStep: base.fitStep,
      lang,
      maxBottom,
      hideFrom,
      hideTo,
      glow: { width: num(glowM![2]!), height: num(glowM![3]!), feather: num(glowM![4]!), centerY },
      elements: els,
    },
    grow: { from: tD + grow.f0, to: tD + grow.f1, to_state: full },
    cream: { from: tD + out.f0, to: creamTo },
    from: clear,
    veilOffset: grow.f0,
  };
}

// ---- початковий титр (розбір у title-card.ts, той самий, що в аніматику) + тексти мови

export function openingSpec(card: TitleCard, texts: TitleTexts, doc: Doc, lang: string): { spec: TitleSpec; initial: ToneState; releaseFrom: number; releaseTo: number } {
  const bg = card.background;
  const sec = findSection(doc, 2, /^Початковий титр$/i, 'Початковий титр');
  const t = blockText(sec.body);
  // Найменші розміри: «нижче 72 пікселів не спускати, інакше скрипт падає», «до 44, потім переносити», «нижче 38 пікселів не спускати:».
  const minTitle = Number(/нижче\s+(\d+)\s+піксел\S*\s+не спускати,\s+інакше/i.exec(t)?.[1] ?? fail('у «Початковому титрі» немає «нижче N пікселів не спускати, інакше скрипт падає» (найменший розмір назви).'));
  const minAuthor = Number(/кроком у\s+\d+\s+піксел\S*\s+до\s+(\d+),\s*потім переносити/i.exec(t)?.[1] ?? fail('у «Початковому титрі» немає «кроком у N пікселі до M, потім переносити» (найменший розмір автора).'));
  const minSmall = Number(/нижче\s+(\d+)\s+піксел\S*\s+не спускати:/i.exec(t)?.[1] ?? fail('у «Початковому титрі» немає «нижче N пікселів не спускати:» (найменший розмір рядка про проєкт).'));
  const maxBottom = Number(/низ групи нижчий за y\s+(\d+)/i.exec(t)?.[1] ?? fail('у «Початковому титрі» немає «низ групи нижчий за y N».'));
  const els: TitleElementSpec[] = card.elements.map((e) => ({
    kind: e.kind,
    lines: e.kind === 'title' ? texts.title : e.kind === 'author' ? [texts.author] : e.kind === 'small' ? [texts.project] : e.lines,
    size: e.size,
    width: e.width,
    weight: e.weight,
    lineHeight: e.lineHeight,
    color: e.color,
    alpha: e.alpha,
    letterSpacing: e.letterSpacing,
    topPx: e.topPx,
    ...(e.kind === 'title' ? { minSize: minTitle } : e.kind === 'author' ? { minSize: minAuthor } : e.kind === 'small' ? { minSize: minSmall } : {}),
    fromFrame: Math.round(e.from * FPS),
    toFrame: Math.round(e.to * FPS),
    rise: e.rise,
  }));
  const top = Math.min(...els.map((e) => e.topPx));
  const bottom = Math.max(...els.map((e) => (e.kind === 'rule' ? e.topPx + e.size : e.topPx + e.lines.length * e.size * e.lineHeight)));
  return {
    spec: {
      activeFrom: 0,
      activeTo: Math.round(card.release.to * FPS),
      blockWidth: card.blockWidth,
      fitStep: card.fitStep,
      lang,
      maxBottom,
      hideFrom: Math.round(card.hide.from * FPS),
      hideTo: Math.round(card.hide.to * FPS),
      glow: { width: bg.glow.width, height: bg.glow.height, feather: bg.glow.feather, centerY: (top + bottom) / 2 },
      elements: els,
    },
    initial: { veil: bg.veil, glow: bg.glow.alpha, blur: bg.blur, saturation: bg.saturation, scale: bg.scale },
    releaseFrom: Math.round(card.release.from * FPS),
    releaseTo: Math.round(card.release.to * FPS),
  };
}

// ---- субтитри: правила з розділу «Субтитри»

export interface SubtitleSpecParsed {
  rules: SubtitleRules;
  timing: TimingRules;
  style: FilmProps['subtitles']['style'];
  /** Остання картка не зникає пізніше за tD + цей зсув (кадрів). */
  lastOutOffset: number;
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
  const offsetMs = Number(need(/ms\(start\)\s*\+\s*(\d+)/i, '`ms(start) + N` (час слова у фільмі)')[1]);
  const lead = Number(need(/за\s+(\d+)\s+кадр\S*\s+до початку свого першого слова/i, 'за N кадри до початку свого першого слова')[1]);
  const fin = Number(need(/від 0% до 100% за\s+(\d+)\s+кадр/i, 'від 0% до 100% за N кадри')[1]);
  const trail = Number(need(/через\s+(\d+)\s+кадр\S*\s+після кінця свого останнього слова/i, 'через N кадрів після кінця останнього слова')[1]);
  const fout = Number(need(/за\s+(\d+)\s+кадр\S*\s+від 100% до 0%/i, 'за N кадри від 100% до 0%')[1]);
  const min = Number(need(/не коротше ніж\s+(\d+)\s+кадр/i, 'не коротше ніж N кадрів')[1]);
  const firstFrame = Number(need(/не стартує раніше за кадр\s+(\d+)/i, 'жодна картка не стартує раніше за кадр N')[1]);
  const lastOffset = Number(need(/не зникає пізніше за кадр\s*`?tD\s*\+\s*(\d+)/i, 'остання картка не зникає пізніше за кадр tD + N')[1]);
  const block = Number(need(/блок завширшки\s+(\d+)\s+піксел/i, 'блок завширшки N пікселів')[1]);
  const bottom = Number(need(/Низ блоку на y\s+(\d+)/i, 'низ блоку на y N')[1]);
  const weight = Number(need(/Lora\s+(\d{3})/i, 'Lora NNN')[1]);
  const size = Number(need(new RegExp(`Lora\\s+\\d{3}(?:\\s*\\([^)]*\\))?,\\s*${N}\\s*піксел`, 'i'), 'Lora NNN (…), N пікселів')[1]);
  const lh = num(need(new RegExp(`міжрядковий інтервал\\s+${N}`, 'i'), 'міжрядковий інтервал N')[1]!);
  const ls = num(need(new RegExp(`розрідження\\s+${N}\\s*em`, 'i'), 'розрідження N em')[1]!);
  const fill = need(/заливки\s*`(#[0-9A-Fa-f]{6})`/i, 'колір заливки `#…`')[1]!;
  const strokeM = need(new RegExp(`обведення\\s*\`(#[0-9A-Fa-f]{6})\`\\s*завтовшки\\s+${N}\\s*піксел`, 'i'), 'обведення `#…` завтовшки N пікселів');
  const shM = need(/тінь\s*`([^`]+)`\s*кольору\s*`#([0-9A-Fa-f]{6})`\s*на\s+(\d+)\s*%/i, 'тінь `0 3px 14px` кольору `#…` на N%');
  const fitM = need(/кроком у\s+(\d+)\s+піксел\S*\s+до\s+(\d+)/i, 'шрифт картки зменшують кроком у N пікселі до M');
  const rgb = Number.parseInt(shM[2]!, 16);
  return {
    rules: { maxWords, maxChars, pauseSeconds: pause },
    timing: { fps: FPS, offsetSeconds: offsetMs / 1000, leadFrames: lead, fadeInFrames: fin, trailFrames: trail, fadeOutFrames: fout, minOnScreenFrames: min, minInFrame: firstFrame },
    lastOutOffset: lastOffset,
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
      fitStep: Number(fitM[1]),
      minSize: Number(fitM[2]),
    },
  };
}

/** Назви для субтитрів мови: для української список з UK_NAMES (звірений з edit.md), для інших із «Назв» script.md. */
export function subtitleNames(doc: Doc, script: ScriptDoc | undefined, lang: string): NameRule[] {
  if (isDefaultLang(lang)) {
    const text = blockText(findSection(doc, 2, /^Субтитри$/i, 'Субтитри').body);
    for (const n of UK_NAMES) if (!text.includes(n.spoken)) fail(`у «Субтитрах» немає запису «${n.spoken}» зі списку для uk: код працює зі старим списком, оновіть UK_NAMES у scripts/lib/subtitles.ts.`);
    return UK_NAMES;
  }
  if (!script) return fail(`мова ${lang}: немає script.md.`);
  const names = script!.names;
  if (!names.length) fail(`мова ${lang}: у stories/<id>/${lang}/script.md немає розділу «Назви» (звучання → написання для субтитрів).`);
  return names.filter((n) => n.rename).map((n) => ({ spoken: n.spoken, shown: n.shown }));
}

// ---- збирання

export interface BuildOptions {
  story: string;
  /** Код мовної версії; без нього українська. */
  lang?: string;
  /** Додатковий масштаб до окремих кадрів (+2% тощо), якщо на стоп-кадрі видно край паперу. */
  bumps?: Record<number, number>;
  /** Перекрити читання з диска в тестах. */
  doc?: Doc;
  timings?: TimingsT;
  script?: ScriptDoc;
  audioExists?: boolean;
}

export interface BuildResult {
  props: FilmProps;
  warnings: string[];
  plan: FramePlan;
}

/** Унікальні символи текстів для перевірки, що накреслення шрифту має всі потрібні літери (діакритика, кирилиця). */
const sampleChars = (texts: string[]): string => [...new Set([...texts.join('')])].filter((c) => !/\s/.test(c)).join('');

export function buildFilmProps(o: BuildOptions): BuildResult {
  const lang = normalizeLang(o.lang);
  const warnings: string[] = [];
  const doc = o.doc ?? readDoc(paths.storyFile(o.story, 'edit.md'), 'editor');
  const consts = parseConstants(doc);
  const table = parseAnchorTable(doc);
  const camera = parseCameraNumbers(doc);
  const exceptions = parseExceptions(doc);

  const timingsFile = paths.timings(o.story, lang);
  if (!o.timings && !existsSync(timingsFile)) fail(`мова ${lang}: немає ${paths.rel(timingsFile)}: спершу озвучення цієї мови (narrate.ts${isDefaultLang(lang) ? '' : ` --lang ${lang}`}).`);
  const timings = o.timings ?? (JSON.parse(readFileSync(timingsFile, 'utf8')) as TimingsT);
  const script = o.script ?? (isDefaultLang(lang) ? undefined : parseScript(o.story, lang));

  // кадри за алгоритмом
  const plan = planFrames({ lang, timings, rules: table.rules, nominalD: table.nominalD, sentenceCounts: table.sentenceCounts, exceptions, releaseEnd: consts.releaseEnd, veilOffset: consts.veilOffset, tailFrames: consts.tailFrames, minClean: MIN_CLEAN_FRAMES, frameCount: FRAME_COUNT, fragmentCount: FRAGMENT_COUNT });
  const veilOffset = consts.veilOffset;
  const { tD, total } = plan;

  // титри
  const opened = parseTitleCardDoc(doc);
  if (!opened.card) fail(`не вдалося розібрати «Початковий титр»${opened.warnings.length ? `: ${opened.warnings.join(' ')}` : ''}.`);
  if (opened.warnings.length) fail(`«Початковий титр» розібрано з припущеннями, а я не вгадую: ${opened.warnings.join(' ')}`);
  const card = opened.card!;
  const opening = openingSpec(card, openingTexts(card, script, lang), doc, lang);
  const closing = parseClosing(doc, card, closingTexts(doc, script, lang), tD, total, lang, opening.spec.maxBottom ?? 1536);
  const sub = parseSubtitleSpec(doc);

  // шрифт
  if (!card.font.url) fail('у «Початковому титрі» немає посилання Google Fonts.');
  const family = card.font.family;
  const checks = [...opening.spec.elements, ...closing.spec.elements]
    .filter((e) => e.kind !== 'rule')
    .map((e) => ({ spec: `${e.weight} ${e.size}px "${family}"`, text: e.lines.join(' ') }));

  // кадри
  const wc = VARIANTS.find((v) => v.id === 'wc-blots');
  if (!wc || wc.transition.kind !== 'watercolor') fail('у remotion/src/variants.ts немає варіанта wc-blots.');
  const baseOpts = (wc!.transition as { kind: 'watercolor'; options: WatercolorOptions }).options;
  const shots: FilmShot[] = [];
  for (let n = 1; n <= FRAME_COUNT; n++) {
    const reveal = n > 1 ? plan.D[n - 1]! : 0;
    const i = n - 1;
    const opts: WatercolorOptions | null =
      n > 1 ? { ...baseOpts, seed: i === 1 ? baseOpts.seed : `${baseOpts.seed}-${i}`, ...(reveal >= BREATH_FROM_FRAMES ? { breath: BREATH } : {}) } : null;
    // Камера лінійна між S(N) і E(N); у кадру 25 від'їзд закінчується на початку вуалі фінального титру (tD + зсув).
    const hold = n === FRAME_COUNT ? tD + veilOffset - plan.S[n]! : plan.E[n]! - plan.S[n]!;
    shots.push({
      n,
      src: `frames/frame-${String(n).padStart(2, '0')}.png`,
      startFrame: plan.S[n]!,
      endFrame: plan.E[n]!,
      revealFrames: reveal,
      reveal: opts,
      camera: cameraSpec(camera[i]!, hold),
      scaleBump: o.bumps?.[n] ?? 0,
    });
  }
  const last = shots[shots.length - 1]!;
  if (closing.grow.from < last.startFrame + last.revealFrames) fail(`вуаль фінального титру починає рости на кадрі ${closing.grow.from}, а кадр ${last.n} ще проступає до ${last.startFrame + last.revealFrames}.`);

  // субтитри
  const words = timings.fragments.flatMap((f) => f.words);
  const names = subtitleNames(doc, script, lang);
  const norm = normalizeWordsLang(words, names, lang);
  const relaxed: string[] = [];
  const cards = cardFrames(buildCards(norm, sub.rules, relaxed), { ...sub.timing, maxOutEnd: tD + sub.lastOutOffset });
  for (const r of relaxed) warnings.push(`субтитри: фразу ${r} не можна розкласти за правилом без порушень, взято розклад із найменшим числом порушень.`);
  const firstIn = cards[0]!.inFrame;
  if (firstIn < opening.releaseTo - Math.round(0.4 * FPS) - 5) warnings.push(`перша картка субтитрів на кадрі ${firstIn} починається ще до кінця титру.`);
  const lastCard = cards[cards.length - 1]!;
  if (lastCard.outEnd > closing.grow.to) fail(`остання картка субтитрів зникає на кадрі ${lastCard.outEnd}, а фінальний титр уже в повній силі з ${closing.grow.to}.`);
  checks.push({ spec: `${sub.style.weight} ${sub.style.size}px "${family}"`, text: sampleChars(cards.map((c) => c.text)) });

  const audioExists = o.audioExists ?? existsSync(paths.workLangFile(o.story, lang, 'mix.mp3'));
  const props: FilmProps = {
    lang,
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
    meta: { lang, tD, total, A_ms: plan.A.slice(2), S: plan.S.slice(1), E: plan.E.slice(1), D: plan.D.slice(1, FRAME_COUNT), clean: plan.clean.slice(1), reduced_transitions: plan.reduced },
  };
  if (!audioExists) warnings.push(`${paths.rel(paths.workLangFile(o.story, lang, 'mix.mp3'))} не знайдено: фільм буде без звуку.`);
  return { props, warnings, plan };
}

/** Додаткові масштаби кадрів із stories/<id>/film-bumps.json ({"8": 0.02}); без файлу порожньо. Кадри однакові в усіх мовах. */
export function readBumps(story: string): Record<number, number> {
  const f = paths.storyFile(story, 'film-bumps.json');
  if (!existsSync(f)) return {};
  const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, number>;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [Number(k), Number(v)]));
}

export { DEFAULT_LANG, FINAL_TITLE_FRAMES };
