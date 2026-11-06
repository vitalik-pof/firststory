// Кадри фільму з таймінгів мови за розділом «Алгоритм» монтажного аркуша edit.md. Чиста логіка без файлів.
//
// Усе в цілих мілісекундах і цілих кадрах (30 к/с), без повторного округлення. Час озвучення у фільмі зсунуто
// на +3.0 с початкового титру. Правила прив'язки кадрів до слів (`Fn.start`, `Fn.end`, `Fn.Sk`, `Fn.Wk/N`)
// не залежать від мови: вони вказують фрагмент і положення в ньому. Що не застосовується, дає FrameRuleError
// з поясненням (мова, кадр, числа, що робити), а не вгадується.

import { FPS, TITLE_MS, endOfNarrationFrame, filmFrames, ms } from './film-time';

export class FrameRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameRuleError';
  }
}

export interface WordT {
  text: string;
  start: number;
  end: number;
}
export interface FragT {
  n: number;
  start: number;
  end: number;
  words: WordT[];
}
export interface TimingsT {
  duration: number;
  fragments: FragT[];
}

// ------------------------------------------------------------------ правила прив'язки

export type AnchorRule =
  | { kind: 'start'; n: number }
  | { kind: 'end'; n: number }
  | { kind: 'sentence'; n: number; k: number }
  | { kind: 'word'; n: number; k: number; of: number }
  /** Виняток із «Мовних винятків»: абсолютний індекс слова j (з нуля) у фрагменті n. */
  | { kind: 'absWord'; n: number; j: number };

/** Розбір токена правила: `F1.start`, `F2.end`, `F5.S2`, `F1.W12/20`, виняток `F5.W3`. */
export function parseRule(token: string): AnchorRule {
  const t = token.trim().replace(/`/g, '');
  let m = /^F(\d+)\.start$/.exec(t);
  if (m) return { kind: 'start', n: Number(m[1]) };
  m = /^F(\d+)\.end$/.exec(t);
  if (m) return { kind: 'end', n: Number(m[1]) };
  m = /^F(\d+)\.S(\d+)$/.exec(t);
  if (m) return { kind: 'sentence', n: Number(m[1]), k: Number(m[2]) };
  m = /^F(\d+)\.W(\d+)\/(\d+)$/.exec(t);
  if (m) return { kind: 'word', n: Number(m[1]), k: Number(m[2]), of: Number(m[3]) };
  m = /^F(\d+)\.W(\d+)$/.exec(t);
  if (m) return { kind: 'absWord', n: Number(m[1]), j: Number(m[2]) };
  throw new FrameRuleError(`Не розумію правило прив'язки «${token}»: очікую Fn.start, Fn.end, Fn.Sk або Fn.Wk/N.`);
}

export const ruleText = (r: AnchorRule): string =>
  r.kind === 'start' ? `F${r.n}.start` : r.kind === 'end' ? `F${r.n}.end` : r.kind === 'sentence' ? `F${r.n}.S${r.k}` : r.kind === 'word' ? `F${r.n}.W${r.k}/${r.of}` : `F${r.n}.W${r.j}`;

const SENTENCE_END = /[.!?…]$/;
const STRIP_TAIL = /["'’«»“”„)\]]+$/;

/** Речення фрагмента: слово закінчує речення, якщо після прибирання з кінця лапок і дужок воно закінчується на . ! ? … */
export function splitSentences(words: WordT[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  words.forEach((w, i) => {
    cur.push(i);
    if (SENTENCE_END.test(w.text.replace(STRIP_TAIL, ''))) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

const describeSplit = (words: WordT[], sentences: number[][]): string =>
  sentences.map((s, i) => `речення ${i + 1}: перше слово «${words[s[0]!]!.text}»`).join('; ');

/** Час прив'язки в секундах озвучення (як у timings.json). */
export function ruleSeconds(rule: AnchorRule, frags: FragT[], lang: string, frame: number, expectedSentences?: Record<number, number>): number {
  const f = frags.find((x) => x.n === rule.n);
  if (!f || !f.words.length) throw new FrameRuleError(`Мова ${lang}, кадр ${frame}: у таймінгах немає фрагмента ${rule.n} зі словами (правило ${ruleText(rule)}).`);
  const w = f.words;
  switch (rule.kind) {
    case 'start':
      return w[0]!.start;
    case 'end':
      return w[w.length - 1]!.end;
    case 'sentence': {
      const sents = splitSentences(w);
      const expect = expectedSentences?.[rule.n];
      if (expect !== undefined && sents.length !== expect) {
        throw new FrameRuleError(
          `Мова ${lang}, кадр ${frame}: правило ${ruleText(rule)} не застосовується: у фрагменті ${rule.n} ${sents.length} речень, а в аркуші очікується ${expect}. Скрипт поділив так: ${describeSplit(w, sents)}. Що робити: попросити сценариста зберегти кількість речень у фрагменті ${rule.n} або вписати виняток для цієї мови в «Мовні винятки» edit.md.`,
        );
      }
      const s = sents[rule.k - 1];
      if (!s) throw new FrameRuleError(`Мова ${lang}, кадр ${frame}: правило ${ruleText(rule)}: у фрагменті ${rule.n} лише ${sents.length} речень (${describeSplit(w, sents)}). Що робити: попросити сценариста зберегти кількість речень або вписати виняток у «Мовні винятки» edit.md.`);
      return w[s[0]!]!.start;
    }
    case 'word': {
      const M = w.length;
      const j = Math.min(Math.max(Math.floor((2 * rule.k * M + rule.of) / (2 * rule.of)), 1), M - 1);
      if (M < 2) throw new FrameRuleError(`Мова ${lang}, кадр ${frame}: у фрагменті ${rule.n} одне слово, правило ${ruleText(rule)} не застосовується.`);
      return w[j]!.start;
    }
    case 'absWord': {
      const x = w[rule.j];
      if (!x) throw new FrameRuleError(`Мова ${lang}, кадр ${frame}: виняток ${ruleText(rule)}: у фрагменті ${rule.n} лише ${w.length} слів.`);
      return x.start;
    }
  }
}

// ------------------------------------------------------------------ валідація таймінгів і плану кадрів

export interface ExceptionRow {
  lang: string;
  frame: number;
  /** 'A': замінити прив'язку; 'D': замінити номінальний перехід (кадрів). */
  what: 'A' | 'D';
  rule?: AnchorRule;
  frames?: number;
}

export interface FramePlanInput {
  lang: string;
  timings: TimingsT;
  /** Прив'язки кадрів 2…25 (індекс = номер кадру). Кадр 1 без прив'язки. */
  rules: Array<AnchorRule | undefined>;
  /** Номінальні переходи D(N) для N = 1…24 (індекс = N). */
  nominalD: number[];
  /** Скільки речень має бути у фрагментах для правил Fn.Sk. */
  sentenceCounts: Record<number, number>;
  exceptions?: ExceptionRow[];
  /** Кадр, на якому закінчується розфокус початкового титру (3.4 с = 102). */
  releaseEnd: number;
  /** Початок вуалі фінального титру: tD + цей зсув. */
  veilOffset: number;
  /** Фінальний титр після кінця файлу озвучення, кадрів. */
  tailFrames: number;
  /** Мінімум чистого вікна кадру, кадрів. */
  minClean: number;
  frameCount: number;
  fragmentCount: number;
}

export interface FramePlan {
  tD: number;
  total: number;
  /** A(N) у мілісекундах фільму, N = 2…25 (індекс = N; [1] не визначено). */
  A: number[];
  S: number[];
  E: number[];
  /** Остаточні переходи D(N), N = 1…24. */
  D: number[];
  clean: number[];
  /** Кадри, чиї переходи зменшувалися (з нуля), для звіту. */
  reduced: number[];
}

/** Перевірка таймінгів (крок 1 алгоритму): рівно N фрагментів по порядку, слова не порожні, не йдуть назад. */
export function checkTimings(t: TimingsT, lang: string, fragmentCount: number): void {
  const fail = (m: string): never => {
    throw new FrameRuleError(`Мова ${lang}: таймінги не проходять перевірку: ${m}.`);
  };
  if (t.fragments.length !== fragmentCount) fail(`фрагментів ${t.fragments.length}, а має бути ${fragmentCount}`);
  let prev = -1;
  t.fragments.forEach((f, i) => {
    if (f.n !== i + 1) fail(`на місці ${i + 1} стоїть фрагмент ${f.n}`);
    if (!f.words?.length) fail(`у фрагменті ${f.n} порожній words[]`);
    for (const w of f.words) {
      if (w.start > w.end) fail(`фрагмент ${f.n}, слово «${w.text}»: початок ${w.start} пізніше за кінець ${w.end}`);
      if (w.start < prev - 1e-9) fail(`фрагмент ${f.n}, слово «${w.text}» (${w.start} с): слова йдуть назад у часі`);
      prev = w.start;
    }
  });
  if (!Number.isFinite(t.duration) || t.duration <= 0) fail('немає поля duration');
}

/** Алгоритм кроків 1–8 edit.md: прив'язки, початки й кінці кадрів, зменшення переходів до мінімуму чистого кадру. */
export function planFrames(inp: FramePlanInput): FramePlan {
  const { lang, timings, frameCount: C } = inp;
  checkTimings(timings, lang, inp.fragmentCount);
  const exc = (frame: number, what: 'A' | 'D'): ExceptionRow | undefined => inp.exceptions?.find((e) => e.lang === lang && e.frame === frame && e.what === what);

  // 2. Прив'язки A_ms(N) = ms(t) + 3000.
  const A: number[] = new Array<number>(C + 1).fill(0);
  for (let n = 2; n <= C; n++) {
    const rule = (exc(n, 'A')?.rule ?? inp.rules[n]) as AnchorRule | undefined;
    if (!rule) throw new FrameRuleError(`У таблиці прив'язок немає правила для кадру ${n}.`);
    A[n] = ms(ruleSeconds(rule, timings.fragments, lang, n, inp.sentenceCounts)) + TITLE_MS;
  }
  for (let n = 3; n <= C; n++) {
    if (A[n]! <= A[n - 1]!) {
      throw new FrameRuleError(`Мова ${lang}: прив'язки не зростають: A(${n}) = ${A[n]} мс не пізніше за A(${n - 1}) = ${A[n - 1]} мс. Що робити: вписати виняток для кадру ${n} у «Мовні винятки» edit.md або повернути сценарист правку фрагментів.`);
    }
  }

  // 3. Кінець файлу озвучення.
  const tD = endOfNarrationFrame(timings.duration);
  const total = filmFrames(timings.duration, inp.tailFrames);
  const lastEnd = timings.fragments[inp.fragmentCount - 1]!.words.slice(-1)[0]!.end;
  if (ms(lastEnd) > ms(timings.duration) + 200) {
    throw new FrameRuleError(`Мова ${lang}: кінець останнього слова фрагмента ${inp.fragmentCount} (${lastEnd} с) пізніший за duration + 0.2 с (${timings.duration} с): таймінги не збігаються з файлом озвучення.`);
  }

  // 4. Номінальні переходи (з виняткових рядків, якщо є).
  const D: number[] = new Array<number>(C).fill(0);
  for (let n = 1; n < C; n++) D[n] = exc(n, 'D')?.frames ?? inp.nominalD[n]!;

  const startsFor = (): number[] => {
    const S: number[] = new Array<number>(C + 1).fill(0);
    for (let n = 1; n < C; n++) S[n + 1] = Math.floor((A[n + 1]! * FPS - D[n]! * 500 + 500) / 1000);
    return S;
  };
  const cleanOf = (S: number[], n: number): number => {
    if (n === 1) return S[2]! - inp.releaseEnd;
    if (n === C) return tD + inp.veilOffset - (S[C]! + D[C - 1]!);
    return S[n + 1]! - (S[n]! + D[n - 1]!);
  };

  // 5–7. Початки, чисте вікно, зменшення переходів: один прохід по кадрах 1…25.
  const reduced = new Set<number>();
  let S = startsFor();
  for (let n = 1; n <= C; n++) {
    let guard = 0;
    while (cleanOf(S, n) < inp.minClean) {
      const touching = [n > 1 ? n - 1 : 0, n < C ? n : 0].filter((x) => x > 0);
      for (const d of touching) {
        if (D[d]! - 1 < inp.minClean) {
          const next = n < C ? `A(${n}) = ${A[n]} мс, A(${n + 1}) = ${A[n + 1]} мс` : `A(${n}) = ${A[n]} мс, початок вуалі tD + ${inp.veilOffset} = ${tD + inp.veilOffset} кадрів`;
          throw new FrameRuleError(
            `Мова ${lang}, кадр ${n}: не вистачає місця: після зменшення переходів до ${inp.minClean} кадрів чисте вікно ${cleanOf(S, n)} кадрів, а потрібно ${inp.minClean} (${next}, D(${d}) = ${D[d]}). Що робити: вписати виняток у «Мовні винятки» edit.md чи змінити фрагмент у сценарії.`,
          );
        }
        D[d]!--;
        reduced.add(d);
      }
      S = startsFor();
      if (++guard > 500) throw new FrameRuleError(`Мова ${lang}, кадр ${n}: зменшення переходів не збігається.`);
    }
  }
  // 8. Кінці.
  const E: number[] = new Array<number>(C + 1).fill(0);
  for (let n = 1; n < C; n++) E[n] = S[n + 1]! + D[n]!;
  E[C] = total;
  const clean: number[] = new Array<number>(C + 1).fill(0);
  for (let n = 1; n <= C; n++) clean[n] = cleanOf(S, n);
  return { tD, total, A, S, E, D, clean, reduced: [...reduced].sort((a, b) => a - b) };
}
