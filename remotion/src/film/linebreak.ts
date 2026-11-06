// Розрив тексту на два рядки: правило з edit.md (розділ «Початковий титр»), спільне для скрипта пропсів і для композиції.
// Розрив за пробілом, найближчим до середини рядка за кількістю символів (при однаковій відстані береться лівіший),
// без розриву після слова з 1–2 літер. Нерозривний пробіл (U+00A0, U+202F) розривом не вважається.

const letters = (w: string): number => (w.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Позиції звичайних пробілів, після слова з трьох і більше літер, у рядку. */
export function breakCandidates(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") continue;
    const before = text.slice(0, i).split(" ").pop() ?? "";
    if (letters(before) > 2) out.push(i);
  }
  return out;
}

/** Два рядки за правилом; якщо розриву немає (одне слово чи всі слова коротші за три літери), один рядок. */
export function splitTwoLines(text: string): string[] {
  const t = text.trim();
  const mid = t.length / 2;
  let best = -1;
  for (const i of breakCandidates(t)) {
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  if (best < 0) return [t];
  return [t.slice(0, best), t.slice(best + 1)];
}
