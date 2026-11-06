// Зведення звуку за правилами розділу «Зведення» stories/<id>/sound.md, однаковими для всіх мовних версій.
//
// Правила прив'язані до слів, фрагментів і пауз `timings.json` тієї мови, яку зводять, а швидкість читання
// файлу музики залежить від довжини озвучення (формула нижче). Жодної секунди якоїсь однієї мови тут немає.
// Числа правил (рівні, пороги, точки кривої) задано в коді й звіряються з розділом «Зведення»:
// якщо композитор їх змінив, checkRulesAgainstDoc друкує УВАГА, і код треба оновити.
//
// Позначення (як у sound.md): O = 3.0 с початковий титр, S(n)/Z(n) = початок/кінець озвучення фрагмента n у фільмі,
// W1 = S(1), E = Z(17), D = duration файлу озвучення, L = довжина фільму, P1 = найдовша пауза всередині фрагмента 1.

import { UsageError } from './cli';
import { filmSecondsFromFrames } from './film-time';
import { dbAt, withPatches, type EnvPoint } from './mix';
import type { EnvPatch } from './mix-spec';

export const RULES = {
  /** O: початковий титр, озвучення стоїть у фільмі з цієї секунди; з тієї ж секунди файлу читається музика. */
  O: 3.0,
  underDb: -8,
  pauseDb: -2,
  /** Тривалість зміни гучності й підйому, секунди. */
  fade: 0.8,
  /** Паузою для підйому вважається лише проміжок строго довший за це число, секунди. */
  pauseMin: 1.2,
  /** v = speedNumerator / (O + D), округлено до 3 знаків. */
  speedNumerator: 114.0,
  speedMin: 0.8,
  speedMax: 1.08,
  /** Крива підсилення початку, у секундах файлу: [секунда файлу, дБ], лінійно в дБ, після останньої 0. */
  boost: [[3, 21], [4, 14], [5, 11], [6, 9], [7, 7], [8, 4], [10, 2], [12, 0]] as Array<[number, number]>,
  /** RMS музики рахується по оригінальному файлу від цієї до цієї секунди файлу. */
  rmsFrom: 12,
  rmsTo: 118,
  /** Вхід музики з нуля на початку (амплітуда лінійно) і згасання на останніх секундах фільму: лише проти клацання. */
  fadeIn: 0.3,
  endFade: 0.75,
  /** Пункт 1: на скільки секунд до першого слова музика починає спадати з -2 до -10 дБ. */
  openingFall: 1.28,
  openingDb: -2,
  firstWordsDb: -10,
  /** Пункт 2: підйом у P1 до -4 дБ за 0.5 с. */
  p1Db: -4,
  p1Rise: 0.5,
  /** Пункт 3: тонка нота. */
  noteDb: -4,
  /** Пункт 6: фрагмент 16. */
  fragment16Db: -10,
  /** Секунди файлу музики для звіряння на слух (mix.json). */
  fileEvents: [8, 13, 16, 20, 27, 57, 103, 113],
  /** Межі довжини озвучення, у яких вистачає наявного файлу музики (з розділу «Зведення»). */
  durationOkMin: 102.6,
  durationOkMax: 139.5,
  /** Секунда фільму, на якій закінчується гучне тіло файлу при v = 0.80 (142.5) — рахується від speedNumerator. */
  bodyEndFile: 117.0,
  chordOpensFile: 113.0,
} as const;

export interface TimedFragment {
  n: number;
  start: number;
  end: number;
  words: Array<{ start: number; end: number }>;
}
export interface TimingsForMix {
  duration: number;
  fragments: TimedFragment[];
}

export interface MusicSpeed {
  raw: number;
  v: number;
  /** 'min': озвучення довше за межу (v піднято до 0.80); 'max': коротше (v опущено до 1.08); null: у межах. */
  limited: 'min' | 'max' | null;
}

/** v = 114.0 / (O + D), 3 знаки, у межах 0.80…1.08. */
export function musicSpeed(duration: number): MusicSpeed {
  const raw = Math.round((RULES.speedNumerator / (RULES.O + duration)) * 1000) / 1000;
  if (raw < RULES.speedMin) return { raw, v: RULES.speedMin, limited: 'min' };
  if (raw > RULES.speedMax) return { raw, v: RULES.speedMax, limited: 'max' };
  return { raw, v: raw, limited: null };
}

/** Підсилення початку за секундою ФАЙЛУ музики, дБ: лінійно в дБ між точками, до першої точки перша, після останньої 0. */
export function boostFileDb(fileSec: number, curve: Array<[number, number]> = RULES.boost): number {
  const pts: EnvPoint[] = curve.map(([t, db]) => ({ t, db }));
  return dbAt(pts, fileSec);
}

/** Підсилення у фільмі в момент t: крива(O + v·t). */
export const boostFilmDb = (t: number, v: number): number => boostFileDb(RULES.O + v * t);

/** Секунда фільму, на якій звучить подія файлу на секунді f: (f − O) / v. */
export const fileEventAtFilm = (f: number, v: number): number => (f - RULES.O) / v;

export interface Pause {
  /** Початок і кінець паузи, секунди фільму. */
  a: number;
  b: number;
  g: number;
}

export interface MixWindow {
  /** Номер пункту «Відхилення від загального правила» (1–7). */
  item: number;
  label: string;
  from: number;
  to: number;
}

export interface LangMixPlan {
  O: number;
  /** duration файлу озвучення. */
  D: number;
  L: number;
  W1: number;
  E: number;
  P1?: { a: number; b: number };
  speed: MusicSpeed;
  windows: MixWindow[];
  /** Усі паузи довші за 1.2 с, секунди фільму. */
  pauses: Pause[];
  /** Слова у фільмі (з O), для крива-пауз і RMS. */
  words: Array<{ start: number; end: number }>;
  /** Ділянки, що замінюють загальну криву. */
  patches: EnvPatch[];
  /** Основна крива: точки (секунда фільму, дБ відносно голосу). */
  base: EnvPoint[];
  fileEvents: Array<{ file: number; film: number }>;
  notes: string[];
  warnings: string[];
}

const NEEDED = [1, 2, 4, 8, 9, 12, 13, 16, 17];
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Основна крива музики для мови: -8 дБ під голосом, у паузах > 1.2 с підйом до -2 за 0.8 с, повернення з кінця паузи за 0.8 с. */
export function baseEnvelope(pauses: Pause[]): EnvPoint[] {
  const { underDb, pauseDb, fade } = RULES;
  const pts: EnvPoint[] = [{ t: 0, db: underDb }];
  const push = (t: number, db: number): void => {
    const last = pts[pts.length - 1]!;
    pts.push({ t: Math.max(t, last.t), db });
  };
  for (const p of pauses) {
    const k = Math.min(1, p.g / fade);
    const peak = underDb + (pauseDb - underDb) * k; // коротка пауза (1.2…1.6 с) не доходить до -2
    push(p.a, underDb);
    push(p.a + Math.min(p.g, fade), peak);
    push(p.b, peak);
    push(p.b + fade, underDb);
  }
  return pts;
}

/**
 * Будує зведення для мови: вікна пунктів 1–7, паузи, швидкість музики. Кидає помилку з поясненням,
 * якщо правило не можна застосувати (немає потрібних фрагментів, L коротша за озвучення).
 */
export function planLangMix(timings: TimingsForMix, filmLength: number): LangMixPlan {
  const { O, fade, pauseMin } = RULES;
  const warnings: string[] = [];
  const notes: string[] = [];
  const frag = new Map(timings.fragments.map((f) => [f.n, f]));
  for (const n of NEEDED) {
    const f = frag.get(n);
    if (!f || !f.words.length) throw new Error(`У таймінгах немає фрагмента ${n} (або в ньому немає слів): правила «Зведення» прив'язані до фрагментів 1, 2, 4, 8, 9, 12, 13, 16, 17.`);
  }
  const S = (n: number): number => frag.get(n)!.words[0]!.start + O;
  const Z = (n: number): number => frag.get(n)!.words[frag.get(n)!.words.length - 1]!.end + O;
  const D = timings.duration;
  const W1 = S(1);
  const E = Z(17);
  const L = filmLength;
  if (!(L >= O + D - 1e-6)) throw new Error(`Довжина фільму L = ${r3(L)} с коротша за O + D = ${r3(O + D)} с: голос обрізався б.`);
  if (!(L >= E + RULES.endFade - 1e-6)) throw new Error(`Довжина фільму L = ${r3(L)} с менша за E + 0.75 = ${r3(E + RULES.endFade)} с: музиці не вистачає місця на згасання після останнього слова.`);

  const words = timings.fragments.flatMap((f) => f.words).map((w) => ({ start: w.start + O, end: w.end + O })).sort((x, y) => x.start - y.start);
  const pauses: Pause[] = [];
  let maxEnd = words[0]!.end;
  for (const w of words.slice(1)) {
    const g = w.start - maxEnd;
    if (g > pauseMin) pauses.push({ a: r3(maxEnd), b: r3(w.start), g: r3(g) });
    maxEnd = Math.max(maxEnd, w.end);
  }

  // P1: найдовший проміжок між сусідніми словами всередині фрагмента 1 (перший, якщо однакових кілька).
  const w1 = frag.get(1)!.words;
  let p1: { a: number; b: number } | undefined;
  for (let i = 0; i + 1 < w1.length; i++) {
    const a = w1[i]!.end + O;
    const b = w1[i + 1]!.start + O;
    if (!p1 || b - a > p1.b - p1.a + 1e-9) p1 = { a, b };
  }

  const patches: EnvPatch[] = [];
  const windows: MixWindow[] = [];
  const { underDb, pauseDb } = RULES;

  // 1. Початок (титр).
  const fallFrom = Math.max(W1 - RULES.openingFall, RULES.fadeIn);
  patches.push({ label: `1. початок: ${RULES.openingDb} дБ до ${r3(fallFrom)} с, спад до ${RULES.firstWordsDb} дБ на W1`, points: [{ t: 0, db: RULES.openingDb }, { t: fallFrom, db: RULES.openingDb }, { t: W1, db: RULES.firstWordsDb }] });
  windows.push({ item: 1, label: 'початок (титр)', from: 0, to: W1 });

  // 2. Фрагмент 1 до P1.
  if (p1 && p1.b - p1.a >= RULES.p1Rise) {
    patches.push({
      label: `2. фрагмент 1 до P1: ${RULES.firstWordsDb} дБ, у P1 ${r3(p1.a)}–${r3(p1.b)} с до ${RULES.p1Db} дБ, далі ${underDb} дБ`,
      points: [{ t: W1, db: RULES.firstWordsDb }, { t: p1.a, db: RULES.firstWordsDb }, { t: p1.a + RULES.p1Rise, db: RULES.p1Db }, { t: p1.b, db: RULES.p1Db }, { t: p1.b + fade, db: underDb }],
    });
    windows.push({ item: 2, label: 'фрагмент 1 до P1', from: r3(W1), to: r3(p1.a) });
  } else {
    warnings.push(p1 ? `P1 (${r3(p1.a)}–${r3(p1.b)} с) коротша за 0.5 с: пункт 2 діє без підйому (-10 дБ від W1 до Z(1), далі за 0.8 с на -8 дБ).` : 'У фрагменті 1 немає жодної паузи між словами (P1): пункт 2 діє без підйому (-10 дБ від W1 до Z(1), далі за 0.8 с на -8 дБ).');
    patches.push({ label: `2. фрагмент 1: ${RULES.firstWordsDb} дБ до Z(1), далі ${underDb} дБ`, points: [{ t: W1, db: RULES.firstWordsDb }, { t: Z(1), db: RULES.firstWordsDb }, { t: Z(1) + fade, db: underDb }] });
    windows.push({ item: 2, label: 'фрагмент 1 (без P1)', from: r3(W1), to: r3(Z(1)) });
  }

  // 3. Кадр 4, «Але не судилося»: вікно [Z(2); S(4)].
  const z2 = Z(2);
  const s4 = S(4);
  if (!(s4 > z2)) throw new Error(`Пункт 3: S(4) = ${r3(s4)} с не пізніше за Z(2) = ${r3(z2)} с: вікно кадру 4 порожнє.`);
  patches.push({
    label: `3. кадр 4: тонка нота ${RULES.noteDb} дБ від Z(2) ${r3(z2)} до S(4) ${r3(s4)} с`,
    points: [{ t: z2, db: 'base' }, { t: Math.min(z2 + fade, s4), db: RULES.noteDb }, { t: s4, db: RULES.noteDb }, { t: s4 + fade, db: 'base' }],
  });
  windows.push({ item: 3, label: 'кадр 4, «Але не судилося»', from: r3(z2), to: r3(s4) });
  const f3 = frag.get(3);
  const s3 = f3 && f3.words.length ? f3.words[0]!.start + O : s4;
  if (!pauses.some((p) => p.a >= z2 - 1e-6 && p.b <= s3 + 1e-6)) warnings.push(`Між Z(2) = ${r3(z2)} с і S(3) = ${r3(s3)} с немає паузи довшої за ${pauseMin} с: очікується пауза перед «Але не судилося» (вікно пункту 3 ${r3(z2)}–${r3(s4)} с усе одно діє).`);

  // 4. Кадр 11: [S(8); S(9)], -8 дБ, підйом пауз вимкнено.
  const s8 = S(8);
  const s9 = S(9);
  patches.push({ label: `4. кадр 11: ${underDb} дБ без підйому пауз, від S(8) ${r3(s8)} до S(9) ${r3(s9)} с`, points: [{ t: s8, db: 'base' }, { t: s8 + fade, db: underDb }, { t: s9, db: underDb }, { t: s9 + fade, db: 'base' }] });
  windows.push({ item: 4, label: 'кадр 11, «Страх залишитися…»', from: r3(s8), to: r3(s9) });

  // 5. Кадр 18: друга третина фрагмента 12 (S(12)…S(13)).
  const s12 = S(12);
  const s13 = S(13);
  const t5a = s12 + (s13 - s12) / 3;
  const t5b = s12 + (2 * (s13 - s12)) / 3;
  patches.push({ label: `5. кадр 18: ${underDb} дБ без підйому пауз, ${r3(t5a)}–${r3(t5b)} с`, points: [{ t: t5a, db: 'base' }, { t: t5a + fade, db: underDb }, { t: t5b, db: underDb }, { t: t5b + fade, db: 'base' }] });
  windows.push({ item: 5, label: 'кадр 18, «букет» (середня третина фрагмента 12)', from: r3(t5a), to: r3(t5b) });

  // 6. Фрагмент 16: [S(16); Z(16)], -10 дБ, вхід за 0.8 с до S(16), вихід на -8 за 0.8 с після Z(16).
  const s16 = S(16);
  const z16 = Z(16);
  patches.push({ label: `6. фрагмент 16: ${RULES.fragment16Db} дБ без підйому пауз, ${r3(s16)}–${r3(z16)} с`, points: [{ t: Math.max(0, s16 - fade), db: 'base' }, { t: s16, db: RULES.fragment16Db }, { t: z16, db: RULES.fragment16Db }, { t: z16 + fade, db: underDb }] });
  windows.push({ item: 6, label: 'фрагмент 16', from: r3(s16), to: r3(z16) });

  // 7. Кінець: [E; L]. Рівень лінійно від рівня в E до -2 дБ у L; музика доживає власним спадом.
  patches.push({ label: `7. кінець: від E ${r3(E)} с рівень до ${pauseDb} дБ у L ${r3(L)} с`, points: [{ t: E, db: 'base' }, { t: L, db: pauseDb }] });
  windows.push({ item: 7, label: 'кінець (фінальний титр)', from: r3(E), to: r3(L) });

  // Вікна не мають перекриватися (інакше пізніший пункт мовчки замінив би частину раніших).
  const sorted = [...windows].sort((x, y) => x.from - y.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.from < sorted[i - 1]!.to - 1e-6) {
      throw new Error(`Вікна пунктів ${sorted[i - 1]!.item} (${sorted[i - 1]!.from}–${sorted[i - 1]!.to} с) і ${sorted[i]!.item} (${sorted[i]!.from}–${sorted[i]!.to} с) перекриваються: за таймінгами цієї мови правила зведення не вкладаються в послідовність. Роль: composer.`);
    }
  }

  const speed = musicSpeed(D);
  const v = speed.v;
  if (speed.limited === 'min') {
    const bodyEnd = (RULES.bodyEndFile - O) / v;
    warnings.push(
      `Озвучення довше за ${RULES.durationOkMax} с (D = ${r3(D)} с): швидкість за формулою ${speed.raw}, взято межу ${v}. Гучне тіло файлу музики закінчується на ${r3(bodyEnd)} с фільму, тож останні ${r3(O + D - bodyEnd)} с голосу йдуть без музики з тілом, лише хвіст файлу. Потрібна нова музика довша за 123 с (близько 1900 кредитів): рішення за продюсером.`,
    );
  } else if (speed.limited === 'max') {
    const chord = fileEventAtFilm(RULES.chordOpensFile, v);
    warnings.push(
      `Озвучення коротше за ${RULES.durationOkMin} с (D = ${r3(D)} с): швидкість за формулою ${speed.raw}, взято межу ${v}. Фінальний акорд відкривається на ${r3(chord)} с фільму, ближче до кінця голосу, ніж звичайні 3.5% від O + D${chord > O + D ? ' (уже після кінця озвучення)' : ''}. Потрібна коротша нова музика: рішення за продюсером.`,
    );
  }
  const fileEvents = RULES.fileEvents.map((f) => ({ file: f, film: r3(fileEventAtFilm(f, v)) }));
  notes.push(`Швидкість читання музики v = ${v} (формула ${RULES.speedNumerator} / (${O} + ${r3(D)}) = ${speed.raw}${speed.limited ? `, обмежено до ${v}` : ''}); секунда фільму t читає секунду файлу ${O} + ${v}·t.`);

  for (const pt of patches) for (const q of pt.points) q.t = r3(q.t);
  return { O, D, L, W1: r3(W1), E: r3(E), P1: p1 ? { a: r3(p1.a), b: r3(p1.b) } : undefined, speed, windows, pauses, words, patches, base: baseEnvelope(pauses), fileEvents, notes, warnings };
}

/** Рівень музики відносно голосу в момент t фільму (дБ), без підсилення початку: основна крива з ділянками пунктів. */
export function musicLevelFn(plan: LangMixPlan): (t: number) => number {
  const base = plan.base;
  return withPatches((t) => dbAt(base, t), plan.patches);
}

// ------------------------------------------------------------------ звіряння з документом

const NUM = '(\\d+(?:[.,]\\d+)?)';
const num = (s: string): number => Number(s.replace(',', '.'));

/** Чи це новий розділ «Зведення» з правилами для будь-якої мови (а не старий із секундами української). */
export function isLanguageIndependentMix(mixText: string): boolean {
  return /Швидкість читання v обчислюється/i.test(mixText);
}

/**
 * Звіряє числа, закладені в код, з розділом «Зведення». Повертає попередження для розбіжностей: якщо композитор
 * змінив рівень, поріг чи точку кривої, код треба оновити (так розбіжність не лишається мовчки).
 */
export function checkRulesAgainstDoc(mixText: string): string[] {
  const text = mixText.replace(/−/g, '-');
  const out: string[] = [];
  const chk = (what: string, doc: number | undefined, code: number): void => {
    if (doc === undefined) out.push(`У «Зведенні» не знайдено ${what}: код працює з ${code}, перевірте документ.`);
    else if (Math.abs(doc - code) > 1e-9) out.push(`У «Зведенні» ${what} = ${doc}, а в коді ${code}: оновіть scripts/lib/mix-rules.ts (RULES).`);
  };
  const f = (re: RegExp): number | undefined => {
    const m = re.exec(text);
    return m ? num(m[1]!) : undefined;
  };
  chk('рівень музики під голосом (дБ)', f(new RegExp(`Музика під голосом\\s+(-\\d+(?:[.,]\\d+)?)\\s*дБ`, 'i')), RULES.underDb);
  chk('рівень у паузах (дБ)', f(new RegExp(`піднімається до\\s+(-\\d+(?:[.,]\\d+)?)\\s*дБ\\s+за\\s+${NUM}\\s*с`, 'i')), RULES.pauseDb);
  chk('поріг паузи (с)', f(new RegExp(`Паузою для підйому музики вважається лише\\s+\`?g\`?\\s*>\\s*${NUM}`, 'i')), RULES.pauseMin);
  chk('чисельник швидкості читання', f(new RegExp(`v\\s*=\\s*${NUM}\\s*/\\s*\\(O\\s*\\+\\s*D\\)`, 'i')), RULES.speedNumerator);
  const lim = new RegExp(`${NUM}\\s*≤\\s*v\\s*≤\\s*${NUM}`).exec(text);
  chk('нижня межа швидкості', lim ? num(lim[1]!) : undefined, RULES.speedMin);
  chk('верхня межа швидкості', lim ? num(lim[2]!) : undefined, RULES.speedMax);
  const line = text.split('\n').find((l) => /Крива підсилення початку, у секундах файлу/i.test(l));
  if (!line) out.push('У «Зведенні» немає рядка «Крива підсилення початку, у секундах файлу…»: старий рядок із секундами фільму не приймається, код працює з кривою з RULES.boost.');
  else {
    const body = line.slice(line.indexOf(':') + 1).split(/далі/i)[0]!;
    const pts: Array<[number, number]> = [];
    for (const m of body.matchAll(new RegExp(`${NUM}\\s*(?:с файлу)?\\s*(?:дБ\\s*)?([+-]\\d+(?:[.,]\\d+)?|0)(?![\\d.])`, 'g'))) pts.push([num(m[1]!), num(m[2]!)]);
    const same = pts.length === RULES.boost.length && pts.every((p, i) => p[0] === RULES.boost[i]![0] && p[1] === RULES.boost[i]![1]);
    if (!same) out.push(`Крива підсилення початку в «Зведенні» (${pts.map((p) => `${p[0]}:${p[1]}`).join(', ')}) не збігається з кодом (${RULES.boost.map((p) => `${p[0]}:${p[1]}`).join(', ')}).`);
  }
  return out;
}

// ------------------------------------------------------------------ довжина фільму

/** Довжина фільму L із параметрів; без жодного з трьох помилка: нічого не вгадуємо. */
export function filmLengthFromArgs(duration: number, v: { 'film-length'?: string; tail?: string; 'tail-frames'?: string }): { L: number; how: string } {
  const given = (['film-length', 'tail', 'tail-frames'] as const).filter((k) => v[k] !== undefined);
  if (given.length !== 1) {
    throw new UsageError(
      `Потрібен рівно один параметр довжини фільму: --tail-frames N (фінальний титр у кадрах, 157 за edit.md; L = (tD + N) / 30), --tail F (секунди після кінця озвучення) або --film-length L (секунди). ${given.length ? `Задано кілька: ${given.join(', ')}.` : 'Не задано жодного.'} Довжину скрипт не вгадує: вона залежить від фінального титру монтажера.`,
    );
  }
  const key = given[0]!;
  const x = Number(v[key]);
  if (!Number.isFinite(x) || x <= 0) throw new UsageError(`--${key} має бути додатним числом, а є «${v[key]}».`);
  if (key === 'film-length') return { L: x, how: `--film-length ${x}` };
  if (key === 'tail') return { L: Math.round((RULES.O + duration + x) * 1000) / 1000, how: `--tail ${x}: L = ${RULES.O} + ${duration} + ${x}` };
  if (!Number.isInteger(x)) throw new UsageError('--tail-frames має бути цілим числом кадрів.');
  return { L: filmSecondsFromFrames(duration, x), how: `--tail-frames ${x}: L = (tD + ${x}) / 30` };
}

