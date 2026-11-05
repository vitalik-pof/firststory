// Відновлення медіа в work/, записаних у stories/<id>/manifest.json, але відсутніх на цій машині.
// Нічого не коштує: лише читання з ElevenLabs (історія, збережені голоси, генерації картинок).
//
//   npx tsx scripts/restore-media.ts --story 01-natalia            сухий прогін: що бракує, що знайдено
//   npx tsx scripts/restore-media.ts --story 01-natalia --run      завантажити й зібрати narration.mp3
//
// Деталі й обмеження: scripts/README.md, розділ «Відновлення медіа».

import { commonFlags, parseCli, runMain } from './lib/cli';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { assertStoryExists } from './lib/paths';
import { buildPlan, executePlan, renderReport } from './lib/restore-media';

const HELP = `Відновлення медіа з work/ за маніфестом (безкоштовно, лише читання з ElevenLabs).
Прапорці:
  --story <id>      історія (обов'язково)
  --run             справді завантажити (без нього сухий прогін: що бракує, що знайдено в історії)
  --accept-weak     брати запис історії, коли хеш тексту не збігся, але збігаються довжина тексту й час
  --allow-lossy     покласти стиснену JPEG-копію фото-референсу (оригінал ElevenLabs не зберігає)
  --max-candidates N  скільки найближчих за часом записів історії перевіряти на частину (10)
Файли, що вже є, не перезаписуються. У маніфест дописується лише history_item_id частин озвучення.`;

async function main(): Promise<void> {
  const { values } = parseCli({ 'accept-weak': { type: 'boolean' }, 'allow-lossy': { type: 'boolean' }, 'max-candidates': { type: 'string' } });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: false });
  assertStoryExists(flags.story);
  const maxCandidates = values['max-candidates'] !== undefined ? Number(values['max-candidates']) : 10;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new Error('--max-candidates має бути цілим числом від 1.');

  const client = new ElevenLabsClient();
  if (!client.hasKey) throw new Error('Не задано ELEVENLABS_API_KEY: без нього не можна шукати в історії (виклики безкоштовні).');
  const plan = await buildPlan(client, { story: flags.story, acceptWeak: Boolean(values['accept-weak']), allowLossy: Boolean(values['allow-lossy']), maxCandidates });
  if (!flags.run) {
    log(renderReport(plan, false));
    return;
  }
  const result = await executePlan(plan);
  log(renderReport(plan, true, result));
  if (result.failed.length) process.exitCode = 1;
}

runMain(main);
