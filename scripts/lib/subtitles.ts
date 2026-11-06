// Субтитри для фільму: слова з timings.json → картки → кадри появи й зникнення. Алгоритм із edit.md, розділ «Субтитри».
// Чиста логіка без файлів, тому її легко перевірити тестом.

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface SubWord {
  text: string;
  /** Секунди озвучення (без зсуву титру). */
  start: number;
  end: number;
}

export interface CardRaw {
  words: SubWord[];
  text: string;
}

export interface SubtitleRules {
  maxWords: number;
  maxChars: number;
  /** Пауза між словами (с), з якої починається нова фраза. */
  pauseSeconds: number;
}

export const DEFAULT_RULES: SubtitleRules = { maxWords: 3, maxChars: 22, pauseSeconds: 0.4 };

const EPS = 1e-9;

/** Звучання → написання назви для субтитрів (розділ «Назви» мовного script.md; для української список у edit.md). */
export interface NameRule {
  spoken: string;
  shown: string;
}

/** Українські назви: як їх слова стоять у voice.md і як їх пишуть у субтитрах (з лапками, як у джерелі). */
export const UK_NAMES: NameRule[] = [
  { spoken: 'Контакт ту ю', shown: '«Контакт2u»' },
  { spoken: 'Фарба Фабра', shown: '«ФарбаФабра»' },
];

const hasLetter = (t: string): boolean => /[\p{L}\p{N}]/u.test(t);
const OPENERS = /^[«„“(\[]+$/;
const QUOTES_EDGE_L = /^[«»“”„"'’‘(\[]+/;
const QUOTES_EDGE_R = /[«»“”„"'’‘)\]]+$/;
const PUNCT_EDGE_R = /[.,;:!?…]+$/;
const PUNCT_EDGE_L = /^[.,;:!?…]+/;

/** Токен для порівняння з назвою: без лапок і розділових знаків на початку й в кінці, без урахування регістру. */
const bare = (t: string): string => t.replace(QUOTES_EDGE_L, '').replace(PUNCT_EDGE_L, '').replace(QUOTES_EDGE_R, '').replace(PUNCT_EDGE_R, '').replace(QUOTES_EDGE_R, '').toLocaleLowerCase();

/** Розділові знаки з кінця токена (після останньої літери чи цифри), без лапок. */
const tailPunct = (t: string): string => {
  const i = [...t].map((c) => hasLetter(c)).lastIndexOf(true);
  return [...t].slice(i + 1).join('').replace(/["'’‘«»“”„)\]]/g, '');
};

/**
 * Слова озвучення → слова субтитрів (правки з розділу «Субтитри» edit.md, однакові для всіх мов):
 * 1) токен без літер і цифр приклеюється до попереднього без пробілу, а відкриваючі «, „, “, (, [ до наступного
 *    (час зливається: початок першого, кінець останнього);
 * 2) назви: послідовність токенів, що збігається зі звучанням, замінюється одним словом: написання зі списку
 *    плюс розділові знаки з кінця останнього токена; запис, якого не знайдено жодного разу, дає помилку;
 * 3) прямий апостроф між літерами стає ’ (U+2019);
 * 4) прямі лапки " після цього в словах лишитися не мають: помилка.
 */
export function normalizeWordsLang(words: TimedWord[], names: NameRule[], where = '', strict = true): SubWord[] {
  // 1. Токени без літер.
  const toks: SubWord[] = [];
  let carry: SubWord | null = null; // відкриваюча лапка, що чекає на наступний токен
  for (const w of words) {
    if (!hasLetter(w.text)) {
      if (OPENERS.test(w.text) || (!toks.length && !carry)) {
        carry = carry ? { text: carry.text + w.text, start: carry.start, end: w.end } : { text: w.text, start: w.start, end: w.end };
      } else if (toks.length) {
        const prev = toks[toks.length - 1]!;
        prev.text += w.text;
        prev.end = Math.max(prev.end, w.end);
      }
      continue;
    }
    if (carry) {
      toks.push({ text: carry.text + w.text, start: carry.start, end: w.end });
      carry = null;
    } else toks.push({ text: w.text, start: w.start, end: w.end });
  }
  if (carry && toks.length) {
    const prev = toks[toks.length - 1]!;
    prev.text += carry.text;
    prev.end = Math.max(prev.end, carry.end);
  }

  // 2. Назви.
  let cur = toks;
  for (const name of names) {
    const spoken = name.spoken.split(/\s+/).map((x) => x.toLocaleLowerCase());
    const out: SubWord[] = [];
    let found = 0;
    for (let i = 0; i < cur.length; ) {
      const hit = spoken.every((sw, k) => cur[i + k] !== undefined && bare(cur[i + k]!.text) === sw);
      if (hit) {
        const last = cur[i + spoken.length - 1]!;
        out.push({ text: `${name.shown}${tailPunct(last.text)}`, start: cur[i]!.start, end: last.end });
        i += spoken.length;
        found++;
      } else out.push(cur[i++]!);
    }
    if (!found && strict) throw new Error(`Субтитри${where ? ` (${where})` : ''}: запис із «Назв» «${name.spoken}» → «${name.shown}» не знайдено в словах озвучення жодного разу.`);
    cur = out;
  }

  // 4. Прямі лапки, 3. апостроф.
  const bad = cur.filter((w) => /"/.test(w.text));
  if (bad.length) throw new Error(`Субтитри${where ? ` (${where})` : ''}: у словах лишилися прямі лапки, правила їх заміни в аркуші немає (сценарист додає їх у «Назви»): ${bad.map((w) => w.text).join(' ')}`);
  return cur.map((w) => ({ ...w, text: w.text.replace(/(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '’') }));
}

/** Українські правила: «Контакт ту ю» і «Фарба Фабра» зливаються (див. UK_NAMES). */
export function normalizeWords(words: TimedWord[]): SubWord[] {
  return normalizeWordsLang(words, UK_NAMES, 'uk', false);
}

const letters = (w: string): number => (w.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Фрази: розрив після слова, що закінчується на . , ? ! ; : , і там, де пауза до наступного слова не менша за поріг. */
export function splitPhrases(words: SubWord[], rules: SubtitleRules = DEFAULT_RULES): SubWord[][] {
  const phrases: SubWord[][] = [];
  let cur: SubWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const punct = /[.,?!;:…]$/.test(w.text.replace(/["'’«»“”„)\]]+$/, ''));
    const pause = next ? next.start - w.end >= rules.pauseSeconds - EPS : false;
    if (punct || pause || !next) {
      phrases.push(cur);
      cur = [];
    }
  });
  return phrases;
}

interface Score {
  violations: number;
  count: number;
  sumSq: number;
  maxLen: number;
  cut: number;
}

const better = (a: Score, b: Score): boolean =>
  a.violations !== b.violations ? a.violations < b.violations : a.count !== b.count ? a.count < b.count : a.sumSq !== b.sumSq ? a.sumSq < b.sumSq : a.maxLen < b.maxLen;

export interface PhraseSplit {
  cards: SubWord[][];
  /** Скільки карток закінчуються словом із 1–2 літер не в кінці фрази: 0, якщо правило виконано повністю. */
  violations: number;
}

/**
 * Розкладає фразу на мінімальну кількість карток (до maxWords слів і maxChars символів із пробілами), де жодна картка,
 * крім останньої, не закінчується словом із 1–2 літер. Серед розкладів обирає найрівніший: мінімум суми квадратів
 * кількості слів, далі мінімум найдовшої картки. Якщо розкладу без порушень правила про короткі слова немає
 * (наприклад «Знаю це не з чуток,»: будь-який розклад на картки до трьох слів лишає «це», «не» чи «з» наприкінці картки),
 * береться розклад із найменшим числом порушень, а далі за тими самими критеріями; кількість порушень повертається.
 */
export function splitPhraseDetailed(phrase: SubWord[], rules: SubtitleRules = DEFAULT_RULES): PhraseSplit {
  const n = phrase.length;
  const best: Array<Score | null> = Array.from({ length: n + 1 }, () => null);
  best[0] = { violations: 0, count: 0, sumSq: 0, maxLen: 0, cut: 0 };
  for (let end = 1; end <= n; end++) {
    for (let k = 1; k <= rules.maxWords && k <= end; k++) {
      const from = end - k;
      const prev = best[from];
      if (!prev) continue;
      const slice = phrase.slice(from, end);
      const text = slice.map((w) => w.text).join(' ');
      // Одне слово довше за maxChars утворює окрему картку (німецькі складні слова): обмеження для нього не діє.
      if (text.length > rules.maxChars && k > 1) continue;
      const bad = end < n && letters(slice[slice.length - 1]!.text) <= 2 ? 1 : 0;
      const cand: Score = { violations: prev.violations + bad, count: prev.count + 1, sumSq: prev.sumSq + k * k, maxLen: Math.max(prev.maxLen, text.length), cut: from };
      const cur = best[end];
      if (!cur || better(cand, cur)) best[end] = cand;
    }
  }
  const last = best[n];
  if (!last) {
    throw new Error(`Субтитри: фразу «${phrase.map((w) => w.text).join(' ')}» не вдається розкласти навіть без правила про короткі слова (до ${rules.maxWords} слів, до ${rules.maxChars} символів).`);
  }
  const cards: SubWord[][] = [];
  for (let end = n; end > 0; ) {
    const s = best[end]!;
    cards.unshift(phrase.slice(s.cut, end));
    end = s.cut;
  }
  return { cards, violations: last.violations };
}

export function splitPhrase(phrase: SubWord[], rules: SubtitleRules = DEFAULT_RULES): SubWord[][] {
  return splitPhraseDetailed(phrase, rules).cards;
}

export function buildCards(words: SubWord[], rules: SubtitleRules = DEFAULT_RULES, relaxed?: string[]): CardRaw[] {
  return splitPhrases(words, rules).flatMap((p) => {
    const r = splitPhraseDetailed(p, rules);
    if (r.violations > 0 && relaxed) relaxed.push(`«${p.map((w) => w.text).join(' ')}» (порушень правила про короткі слова: ${r.violations})`);
    return r.cards.map((c) => ({ words: c, text: c.map((w) => w.text).join(' ') }));
  });
}

export interface TimingRules {
  fps: number;
  /** Зсув озвучення у фільмі, с (титр). */
  offsetSeconds: number;
  leadFrames: number;
  fadeInFrames: number;
  trailFrames: number;
  fadeOutFrames: number;
  minOnScreenFrames: number;
  /** Жодна картка не стартує раніше за цей кадр (кінець початкового титру, 90). */
  minInFrame?: number;
  /** Остання картка не зникає пізніше за цей кадр (tD + 12). */
  maxOutEnd?: number;
}

export const DEFAULT_TIMING: TimingRules = { fps: 30, offsetSeconds: 3, leadFrames: 2, fadeInFrames: 3, trailFrames: 6, fadeOutFrames: 3, minOnScreenFrames: 15 };

export interface CardFrames {
  text: string;
  inFrame: number;
  inEnd: number;
  outFrame: number;
  outEnd: number;
}

/**
 * Кадри появи й зникнення. Старт за leadFrames до першого слова, поява fadeInFrames; зникнення через trailFrames після
 * кінця останнього слова, за fadeOutFrames, але на екрані не менше minOnScreenFrames. Якщо наступна картка починається,
 * поки ця ще не зникла, ця лишається, доки наступна не дійде до 100%: вони розчиняються одна в одну.
 */
export function cardFrames(cards: CardRaw[], t: TimingRules = DEFAULT_TIMING): CardFrames[] {
  const f = (sec: number): number => Math.round((sec + t.offsetSeconds) * t.fps);
  const out: CardFrames[] = cards.map((c) => {
    let inFrame = f(c.words[0]!.start) - t.leadFrames;
    if (t.minInFrame !== undefined && inFrame < t.minInFrame) inFrame = t.minInFrame;
    let outFrame = f(c.words[c.words.length - 1]!.end) + t.trailFrames;
    if (outFrame + t.fadeOutFrames - inFrame < t.minOnScreenFrames) outFrame = inFrame + t.minOnScreenFrames - t.fadeOutFrames;
    if (t.maxOutEnd !== undefined && outFrame + t.fadeOutFrames > t.maxOutEnd) outFrame = Math.max(inFrame + t.fadeInFrames, t.maxOutEnd - t.fadeOutFrames);
    return { text: c.text, inFrame, inEnd: inFrame + t.fadeInFrames, outFrame, outEnd: outFrame + t.fadeOutFrames };
  });
  for (let i = 0; i + 1 < out.length; i++) {
    const cur = out[i]!;
    const next = out[i + 1]!;
    if (next.inFrame < cur.outEnd && next.inFrame < cur.outFrame) {
      cur.outFrame = next.inFrame;
      cur.outEnd = next.inFrame + t.fadeInFrames;
    }
  }
  return out;
}
