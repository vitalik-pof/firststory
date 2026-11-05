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

/** Слова озвучення з правками: зливає «Контакт ту ю» і «Фарба Фабра», міняє апостроф, прямі лапки на ялинки. */
export function normalizeWords(words: TimedWord[]): SubWord[] {
  const out: SubWord[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    const a = words[i + 1];
    const b = words[i + 2];
    if (w.text === '"Контакт' && a?.text === 'ту' && b && /^ю"([.,;:!?]*)$/.test(b.text)) {
      const tail = /^ю"([.,;:!?]*)$/.exec(b.text)![1]!;
      out.push({ text: `«Контакт2u»${tail}`, start: w.start, end: b.end });
      i += 3;
      continue;
    }
    if (w.text === '"Фарба' && a && /^Фабра"([.,;:!?]*)$/.test(a.text)) {
      const tail = /^Фабра"([.,;:!?]*)$/.exec(a.text)![1]!;
      out.push({ text: `«ФарбаФабра»${tail}`, start: w.start, end: a.end });
      i += 2;
      continue;
    }
    out.push({ text: w.text, start: w.start, end: w.end });
    i++;
  }
  const bad = out.filter((w) => /["“”„]/.test(w.text));
  if (bad.length) throw new Error(`Субтитри: у словах лишилися прямі лапки, правила їх заміни в аркуші немає: ${bad.map((w) => w.text).join(' ')}`);
  return out.map((w) => ({ ...w, text: w.text.replace(/'/g, '’') }));
}

/** Скільки разів у словах озвучення зустрілися «Контакт»/«Фарба»: для перевірки, що злиття не промовчало. */
export function countMerges(words: TimedWord[]): { contact: number; farba: number } {
  let contact = 0;
  let farba = 0;
  words.forEach((w, i) => {
    if (w.text === '"Контакт' && words[i + 1]?.text === 'ту' && /^ю"/.test(words[i + 2]?.text ?? '')) contact++;
    if (w.text === '"Фарба' && /^Фабра"/.test(words[i + 1]?.text ?? '')) farba++;
  });
  return { contact, farba };
}

const letters = (w: string): number => (w.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Фрази: розрив після слова, що закінчується на . , ? ! ; : , і там, де пауза до наступного слова не менша за поріг. */
export function splitPhrases(words: SubWord[], rules: SubtitleRules = DEFAULT_RULES): SubWord[][] {
  const phrases: SubWord[][] = [];
  let cur: SubWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const punct = /[.,?!;:]$/.test(w.text);
    const pause = next ? next.start - w.end >= rules.pauseSeconds - EPS : false;
    if (punct || pause || !next) {
      phrases.push(cur);
      cur = [];
    }
  });
  return phrases;
}

interface Score {
  count: number;
  sumSq: number;
  maxLen: number;
  cut: number;
}

const better = (a: Score, b: Score): boolean => (a.count !== b.count ? a.count < b.count : a.sumSq !== b.sumSq ? a.sumSq < b.sumSq : a.maxLen < b.maxLen);

/**
 * Розкладає фразу на мінімальну кількість карток (до maxWords слів і maxChars символів із пробілами), де жодна картка,
 * крім останньої, не закінчується словом із 1–2 літер. Серед розкладів обирає найрівніший: мінімум суми квадратів
 * кількості слів, далі мінімум найдовшої картки.
 */
export function splitPhrase(phrase: SubWord[], rules: SubtitleRules = DEFAULT_RULES): SubWord[][] {
  const n = phrase.length;
  const best: Array<Score | null> = Array.from({ length: n + 1 }, () => null);
  best[0] = { count: 0, sumSq: 0, maxLen: 0, cut: 0 };
  for (let end = 1; end <= n; end++) {
    for (let k = 1; k <= rules.maxWords && k <= end; k++) {
      const from = end - k;
      const prev = best[from];
      if (!prev) continue;
      const slice = phrase.slice(from, end);
      const text = slice.map((w) => w.text).join(' ');
      if (text.length > rules.maxChars) continue;
      if (end < n && letters(slice[slice.length - 1]!.text) <= 2) continue;
      const cand: Score = { count: prev.count + 1, sumSq: prev.sumSq + k * k, maxLen: Math.max(prev.maxLen, text.length), cut: from };
      const cur = best[end];
      if (!cur || better(cand, cur)) best[end] = cand;
    }
  }
  const last = best[n];
  if (!last) {
    throw new Error(`Субтитри: фразу «${phrase.map((w) => w.text).join(' ')}» не вдається розкласти за правилами (до ${rules.maxWords} слів, до ${rules.maxChars} символів, без картки, що закінчується словом із 1–2 літер).`);
  }
  const cards: SubWord[][] = [];
  for (let end = n; end > 0; ) {
    const s = best[end]!;
    cards.unshift(phrase.slice(s.cut, end));
    end = s.cut;
  }
  return cards;
}

export function buildCards(words: SubWord[], rules: SubtitleRules = DEFAULT_RULES): CardRaw[] {
  return splitPhrases(words, rules).flatMap((p) => splitPhrase(p, rules).map((c) => ({ words: c, text: c.map((w) => w.text).join(' ') })));
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
    const inFrame = f(c.words[0]!.start) - t.leadFrames;
    let outFrame = f(c.words[c.words.length - 1]!.end) + t.trailFrames;
    if (outFrame + t.fadeOutFrames - inFrame < t.minOnScreenFrames) outFrame = inFrame + t.minOnScreenFrames - t.fadeOutFrames;
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
