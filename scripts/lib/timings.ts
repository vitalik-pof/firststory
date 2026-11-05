// Побудова timings.json з відповіді convert_with_timestamps.
//
// Відповідь дає час кожного символу. Ми озвучуємо весь текст одним викликом, між фрагментами
// ставимо роздільник, а межі фрагментів рахуємо за позиціями символів фрагмента в надісланому тексті.
// Теги у квадратних дужках не озвучуються: у словах їх немає, а символи тегів (якщо API їх повернув)
// просто пропускаються.

import type { Alignment } from './elevenlabs';
import { TAG_RE, collapseWs, sha1, stripTags } from './text';

export interface SpeechFragmentInput {
  n: number;
  /** Текст фрагмента з тегами. */
  tagged: string;
}

export interface Span {
  n: number;
  start: number;
  end: number;
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface FragmentTiming {
  n: number;
  start: number;
  end: number;
  text: string;
  words: WordTiming[];
}

export interface TimingsPart {
  /** Частини озвучення (окремі виклики API) у порядку звучання. */
  index: number;
  /** Номери фрагментів, озвучених цією частиною. */
  fragments: number[];
  /** Зсув частини в narration.mp3, секунди. */
  offset: number;
  /** Тривалість аудіо частини без паузи після неї. */
  duration: number;
}

export interface TimingsFile {
  version: 1;
  story: string;
  model_id: string;
  voice_id: string;
  audio_file: string;
  /** Тривалість narration.mp3, секунди. */
  duration: number;
  /** Чим розділені фрагменти в надісланому тексті. */
  fragment_joiner: string;
  /** Пауза між частинами при склейці, секунди (якщо частин більше однієї). */
  part_gap: number;
  parts: TimingsPart[];
  /** Фрагменти сценарію без голосу (наприклад, титр): у fragments їх немає. */
  silent_fragments: number[];
  fragments: FragmentTiming[];
}

export class AlignmentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignmentMismatchError';
  }
}

export function buildSpeechText(fragments: SpeechFragmentInput[], joiner: string): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  fragments.forEach((f, i) => {
    if (i > 0) text += joiner;
    const start = text.length;
    text += f.tagged;
    spans.push({ n: f.n, start, end: text.length });
  });
  return { text, spans };
}

const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

function tagMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(TAG_RE)) {
    for (let k = m.index!; k < m.index! + m[0].length; k++) mask[k] = true;
  }
  return mask;
}

/**
 * Зіставляє символи відповіді з надісланим текстом. Повертає для кожного символу відповіді
 * індекс у надісланому тексті (або -1 для зайвого пробілу). Допускаємо тільки два розходження:
 * теги, яких немає у відповіді, і різницю в пробілах. Усе інше — помилка з контекстом.
 */
export function alignToSentText(sent: string, chars: string[]): number[] {
  const mask = tagMask(sent);
  const map: number[] = new Array<number>(chars.length).fill(-1);
  let i = 0;
  let j = 0;
  const context = (): string =>
    `надіслано «…${sent.slice(Math.max(0, i - 15), i + 15).replace(/\n/g, '⏎')}…» (позиція ${i}), у відповіді «…${chars.slice(Math.max(0, j - 15), j + 15).join('').replace(/\n/g, '⏎')}…» (символ ${j})`;
  while (j < chars.length) {
    const el = chars[j]!;
    if (el === '') {
      j++;
      continue;
    }
    if (sent.startsWith(el, i)) {
      map[j] = i;
      i += el.length;
      j++;
    } else if (i < sent.length && mask[i]) {
      i++; // тег, якого немає у відповіді
    } else if (i < sent.length && isWs(sent[i]) && !isWs(el)) {
      i++; // пробіл, якого немає у відповіді
    } else if (isWs(el) && !isWs(sent[i])) {
      j++; // зайвий пробіл у відповіді
    } else if (isWs(el) && isWs(sent[i])) {
      map[j] = i; // пробіл замість переносу рядка чи навпаки
      i++;
      j++;
    } else {
      throw new AlignmentMismatchError(`Символи відповіді не збігаються з надісланим текстом: ${context()}`);
    }
  }
  while (i < sent.length) {
    if (!mask[i] && !isWs(sent[i])) {
      throw new AlignmentMismatchError(`Частину тексту не озвучено: з позиції ${i} («${sent.slice(i, i + 40)}»), відповідь закінчилась.`);
    }
    i++;
  }
  return map;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function buildFragmentTimings(
  sent: string,
  spans: Span[],
  alignment: Alignment,
  fragments: SpeechFragmentInput[],
): FragmentTiming[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (characters.length !== starts.length || characters.length !== ends.length) {
    throw new AlignmentMismatchError('Довжини масивів characters / start / end у відповіді різні.');
  }
  const map = alignToSentText(sent, characters);
  const retIdx = new Map<number, number>();
  map.forEach((s, j) => {
    if (s >= 0) retIdx.set(s, j);
  });
  const mask = tagMask(sent);

  return spans.map((span, k) => {
    const words: WordTiming[] = [];
    let cur: { text: string; start: number; end: number } | null = null;
    const flush = (): void => {
      if (cur) words.push({ text: cur.text, start: r3(cur.start), end: r3(cur.end) });
      cur = null;
    };
    for (let s = span.start; s < span.end; s++) {
      const ch = sent[s]!;
      if (mask[s] || isWs(ch)) {
        flush();
        continue;
      }
      const j = retIdx.get(s);
      if (j === undefined) continue; // недосяжно після alignToSentText, але не падаємо
      const st = starts[j]!;
      const en = ends[j]!;
      if (!cur) cur = { text: ch, start: st, end: en };
      else {
        cur.text += ch;
        cur.end = Math.max(cur.end, en);
        cur.start = Math.min(cur.start, st);
      }
    }
    flush();
    if (!words.length) throw new AlignmentMismatchError(`Фрагмент ${span.n}: у відповіді немає жодного озвученого слова.`);
    return {
      n: span.n,
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: stripTags(fragments[k]!.tagged),
      words,
    };
  });
}

export function shiftFragments(fragments: FragmentTiming[], offset: number): FragmentTiming[] {
  if (!offset) return fragments;
  return fragments.map((f) => ({
    ...f,
    start: r3(f.start + offset),
    end: r3(f.end + offset),
    words: f.words.map((w) => ({ ...w, start: r3(w.start + offset), end: r3(w.end + offset) })),
  }));
}

/** Перевірки здорового глузду. Повертає список попереджень (порожній, якщо все гаразд). */
export function checkTimings(fragments: FragmentTiming[], duration: number): string[] {
  const problems: string[] = [];
  let prevEnd = 0;
  for (const f of fragments) {
    if (f.end < f.start) problems.push(`фрагмент ${f.n}: кінець раніше за початок`);
    if (f.start < prevEnd - 0.05) problems.push(`фрагмент ${f.n} починається (${f.start}) раніше за кінець попереднього (${prevEnd})`);
    for (const w of f.words) if (w.end < w.start) problems.push(`фрагмент ${f.n}, слово «${w.text}»: кінець раніше за початок`);
    prevEnd = Math.max(prevEnd, f.end);
  }
  if (fragments.length && prevEnd > duration + 0.5) problems.push(`останнє слово закінчується на ${prevEnd} с, а аудіо триває ${duration} с`);
  return problems;
}

export { collapseWs };

/**
 * Хеш частини озвучення: ім'я файлів narration.part-<хеш>.mp3 і ключ у manifest.narration.parts.
 * Спільний для narrate.ts і restore-media.ts: за ним відновлена з історії відповідь упізнається однозначно.
 */
export function narrationPartHash(body: Record<string, unknown>, voiceId: string, outputFormat: string): string {
  return sha1(JSON.stringify({ body, voice: voiceId, outputFormat })).slice(0, 10);
}
