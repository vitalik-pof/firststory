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

export type PriceSource = 'з API' | 'з документації ElevenLabs' | 'оцінка' | 'не знайдено' | 'виміряно в маніфесті';

export interface Priced {
  credits: number | null;
  source: PriceSource;
  note?: string;
}

export const SFX_CREDITS_PER_SECOND = 40;
export const MUSIC_CREDITS_PER_MINUTE = 900;

export interface TtsRate {
  multiplier: number;
  source: PriceSource;
  maxChars: number;
}

/** Множник за знак для моделі: з API; без ключа чи збої мережі — 1 з позначкою «оцінка». */
export async function ttsRate(client: ElevenLabsClient, modelId: string): Promise<TtsRate> {
  if (!client.hasKey) return { multiplier: 1, source: 'оцінка', maxChars: 10_000 };
  try {
    const models = await client.listModels();
    const m = models.find((x) => x.model_id === modelId);
    if (!m) throw new Error(`Моделі ${modelId} немає у відповіді models list.`);
    return {
      multiplier: (m.model_rates?.character_cost_multiplier ?? 1) * (m.model_rates?.cost_discount_multiplier ?? 1),
      source: 'з API',
      maxChars: m.maximum_text_length_per_request,
    };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Моделі ')) throw e;
    return { multiplier: 1, source: 'оцінка', maxChars: 10_000 };
  }
}

export function estimateTts(chars: number, rate: TtsRate): Priced {
  return { credits: Math.ceil(chars * rate.multiplier), source: rate.source === 'з API' ? 'з API' : 'оцінка', note: `${chars} знаків × ${rate.multiplier}` };
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
