// Час фільму в цілих мілісекундах і кадрах (монтажний аркуш edit.md, «Як читати цей файл» і «Алгоритм»).
// Спільне для зведення звуку (довжина фільму L) і пропсів фільму: обидва мають бути згодні з точністю до кадра.

export const FPS = 30;
/** Початковий титр, секунди: озвучення стоїть у фільмі з цієї секунди (O у sound.md). */
export const TITLE_SECONDS = 3.0;
export const TITLE_MS = 3000;
/** Фінальний титр після кінця файлу озвучення, кадри: F = 157 кадрів = 5.2333 с (edit.md, «Фінальний титр»). */
export const FINAL_TITLE_FRAMES = 157;

/** Секунди з timings.json (до трьох знаків після коми) у цілі мілісекунди. */
export const ms = (seconds: number): number => Math.round(seconds * 1000);

/** Мілісекунди в кадри, округлення до найближчого, половина вгору: floor((x·30 + 500) / 1000). */
export const msToFrames = (x: number): number => Math.floor((x * FPS + 500) / 1000);

/** Кінець файлу озвучення у фільмі, кадри: tD = floor(((ms(duration) + 3000)·30 + 500) / 1000). */
export function endOfNarrationFrame(duration: number): number {
  return msToFrames(ms(duration) + TITLE_MS);
}

/** Довжина фільму в кадрах: tD + довжина фінального титру (за замовчуванням 157 кадрів). */
export function filmFrames(duration: number, tailFrames = FINAL_TITLE_FRAMES): number {
  return endOfNarrationFrame(duration) + tailFrames;
}

/** Довжина фільму в секундах за кадрами: F_total / 30. Саме така довжина mix.mp3 кожної мови. */
export function filmSecondsFromFrames(duration: number, tailFrames = FINAL_TITLE_FRAMES): number {
  return filmFrames(duration, tailFrames) / FPS;
}
