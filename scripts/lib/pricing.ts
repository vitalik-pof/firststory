// Ціни кредитів. Кожне число має позначку, звідки воно. Перевірено 4 листопада 2026 року.
//
// - множник за знак моделі озвучення: безкоштовний виклик `models list` (model_rates.character_cost_multiplier);
// - Voice Design: довідковий центр ElevenLabs (How much does Voice Design cost): списується
//   за кількість знаків тексту проби, один раз за три проби. Множник для моделей Voice Design у API не віддається,
//   тому беремо 1 і чесно позначаємо як оцінку;
// - шуми: сторінка Sound effects у документації: 40 кредитів за секунду при заданій тривалості (0.1–30 с);
//   сторінка тарифів згадує ~200 кредитів за генерацію, тобто джерела розходяться (беремо 40/с, це верхня межа для коротких шумів,
//   фактичне число скрипт бере із заголовка character-cost);
// - музика: сторінка тарифів ElevenLabs, «приблизно 900 кредитів за хвилину» (приблизне число, API рахується в доларах);
// - картинки: ціну для gemini-3.1-flash-image у документації ElevenLabs НЕ знайдено (сторінки лише кажуть, що вона залежить
//   від моделі й роздільності та показується в інтерфейсі). Тому число задається прапорцем --image-credits N,
//   а після першої згенерованої картинки скрипт бере фактичну вартість із маніфесту.

import type { ElevenLabsClient } from './elevenlabs';
import { narrationKeys, readManifest } from './manifest';

export type PriceSource = 'з API' | 'з документації ElevenLabs' | 'оцінка' | 'не знайдено' | 'виміряно в маніфесті';

export interface Priced {
  credits: number | null;
  source: PriceSource;
  note?: string;
}

export const SFX_CREDITS_PER_SECOND = 40;
export const MUSIC_CREDITS_PER_MINUTE = 900;

export interface TtsRate {
  /** Кредитів за знак. */
  multiplier: number;
  source: PriceSource;
  maxChars: number;
  note: string;
}

/**
 * Фактична ціна eleven_v4 на цьому акаунті, виміряна 5 листопада 2026 за історією озвучення:
 * 970 кредитів за 1999 знаків (разом із тегами) ≈ 0.485 кредита на знак. Множник model_rates
 * з API (1) цього не відображає, тому як ціну його не використовуємо.
 */
export const V4_OBSERVED_CREDITS_PER_CHAR = 970 / 1999;

/** Виміряна ціна знака за маніфестом: сума кредитів частин з історії на суму знаків. */
export function measuredTtsRate(story: string | undefined): { perChar: number; chars: number } | undefined {
  if (!story) return undefined;
  let credits = 0;
  let chars = 0;
  const m = readManifest(story);
  // Ціна знака однакова для всіх мов: беремо частини озвучення з усіх мовних записів (narration, narration_en, …).
  for (const key of narrationKeys(m)) {
    const parts = ((m[key] as { parts?: unknown } | undefined)?.parts ?? {}) as Record<string, { credits?: number; chars_sent?: number; credits_source?: string }>;
    for (const p of Object.values(parts)) {
      if (p.credits_source === 'history' && p.credits && p.chars_sent) {
        credits += p.credits;
        chars += p.chars_sent;
      }
    }
  }
  return chars > 0 ? { perChar: credits / chars, chars } : undefined;
}

/**
 * Ціна знака озвучення: виміряна в маніфесті (перевага) → спостережена на акаунті (оцінка) →
 * множник з API лише для довідки. Ліміт знаків і доступність моделі беремо з models list.
 */
export async function ttsRate(client: ElevenLabsClient, modelId: string, story?: string): Promise<TtsRate> {
  let maxChars = 10_000;
  let apiMultiplier: number | undefined;
  if (client.hasKey) {
    try {
      const m = (await client.listModels()).find((x) => x.model_id === modelId);
      if (!m) throw new Error(`Моделі ${modelId} немає у відповіді models list.`);
      maxChars = m.maximum_text_length_per_request;
      apiMultiplier = (m.model_rates?.character_cost_multiplier ?? 1) * (m.model_rates?.cost_discount_multiplier ?? 1);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Моделі ')) throw e;
    }
  }
  const measured = measuredTtsRate(story);
  if (measured) {
    return { multiplier: measured.perChar, source: 'виміряно в маніфесті', maxChars, note: `${measured.perChar.toFixed(3)} кредита/знак за історією озвучення (${measured.chars} знаків)${apiMultiplier !== undefined ? `; множник API ${apiMultiplier} цього не відображає` : ''}` };
  }
  return {
    multiplier: V4_OBSERVED_CREDITS_PER_CHAR, source: 'оцінка', maxChars,
    note: `${V4_OBSERVED_CREDITS_PER_CHAR.toFixed(3)} кредита/знак: спостережено на цьому акаунті (970 за 1999 знаків, 5 листопада 2026)${apiMultiplier !== undefined ? `; множник API (${apiMultiplier}) цього не відображає` : ''}`,
  };
}

export function estimateTts(chars: number, rate: TtsRate): Priced {
  return { credits: Math.ceil(chars * rate.multiplier), source: rate.source, note: `${chars} знаків × ${rate.multiplier.toFixed(3)}; ${rate.note}` };
}

export function estimateVoiceDesign(probeChars: number): Priced {
  return { credits: probeChars, source: 'з документації ElevenLabs', note: `${probeChars} знаків проби, один раз за три проби; множник моделі Voice Design невідомий, взято 1` };
}

export function estimateSfx(seconds: number): Priced {
  return { credits: Math.ceil(seconds * SFX_CREDITS_PER_SECOND), source: 'з документації ElevenLabs', note: `${seconds} с × ${SFX_CREDITS_PER_SECOND} кредитів/с` };
}

export function estimateMusic(seconds: number): Priced {
  return { credits: Math.ceil((seconds / 60) * MUSIC_CREDITS_PER_MINUTE), source: 'з документації ElevenLabs', note: `${seconds} с × ~${MUSIC_CREDITS_PER_MINUTE} кредитів/хв (приблизно)` };
}

export function estimateImage(imageCredits: number | undefined): Priced {
  return imageCredits === undefined
    ? { credits: null, source: 'не знайдено', note: 'ціну картинки в документації не знайдено; задайте --image-credits N' }
    : { credits: imageCredits, source: 'оцінка', note: 'значення з --image-credits' };
}

export function fmt(p: Priced): string {
  return p.credits === null ? `невідомо [${p.source}]` : `~${p.credits} [${p.source}]`;
}
