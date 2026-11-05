// Розклад аніматика: який кадр показується в який момент озвучення.
//
// Правило режисера: кадр показується від початку свого фрагмента за timings.json; якщо на фрагмент
// кілька кадрів, час фрагмента ділиться між ними порівну. Вікно фрагмента — від його початку до
// початку наступного (так кадр не зникає в паузі між фрагментами); вікно першого фрагмента
// починається з 0 с, останнього закінчується в кінці аудіо. Фрагмент без кадру не дає слотів:
// на екрані лишається попередній кадр.

export interface FragmentWindowInput {
  n: number;
  start: number;
}
export interface FrameInput {
  n: number;
  fragment: number;
}
export interface Slot {
  start: number;
  end: number;
  frame: number;
  fragment: number;
}
export interface Schedule {
  slots: Slot[];
  fragmentsWithoutFrames: number[];
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function buildSchedule(fragments: FragmentWindowInput[], frames: FrameInput[], duration: number): Schedule {
  for (let i = 1; i < fragments.length; i++) {
    if (fragments[i]!.start < fragments[i - 1]!.start) throw new Error(`timings.json: фрагмент ${fragments[i]!.n} починається раніше за попередній.`);
  }
  const known = new Set(fragments.map((f) => f.n));
  for (const f of frames) if (!known.has(f.fragment)) throw new Error(`Кадр ${f.n} посилається на фрагмент ${f.fragment}, якого немає в timings.json.`);
  const slots: Slot[] = [];
  const without: number[] = [];
  fragments.forEach((frag, i) => {
    const mine = frames.filter((f) => f.fragment === frag.n).sort((a, b) => a.n - b.n);
    if (!mine.length) {
      without.push(frag.n);
      return;
    }
    const from = i === 0 ? 0 : frag.start;
    const to = i === fragments.length - 1 ? duration : fragments[i + 1]!.start;
    const len = Math.max(0, to - from);
    mine.forEach((f, k) => {
      slots.push({ start: r3(from + (len * k) / mine.length), end: r3(from + (len * (k + 1)) / mine.length), frame: f.n, fragment: frag.n });
    });
  });
  // Зазор перед першим слотом (якщо перші фрагменти без кадрів) і між слотами закриває «останній слот, що почався».
  return { slots, fragmentsWithoutFrames: without };
}

/** Слот, активний у момент t: останній, що почався (бінарний пошук). Те саме робить код сторінки. */
export function slotAt(slots: Slot[], t: number): Slot | undefined {
  if (!slots.length) return undefined;
  let lo = 0;
  let hi = slots.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid]!.start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return slots[ans];
}
