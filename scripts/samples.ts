// Етап 1а: зразки стилю за art/samples.md → work/<id>/samples/sample-NN.png.
// Запит = «Для генератора» зразка + текст стилю з art/style.md; референси героїв за тими самими
// правилами, що й у кадрів (рядок «Герої:», аркуші мають бути завантажені).
//
//   npx tsx scripts/samples.ts --story 01-natalia                                          сухий прогін
//   npx tsx scripts/samples.ts --story 01-natalia --run --limit-credits 5000 --image-credits 50
//   npx tsx scripts/samples.ts --story 01-natalia --run … --only 2,3
//   npx tsx scripts/samples.ts --story 01-natalia --run … --regen 2 --prompt "новий текст"

import { readFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { RESOLUTIONS, aspectFromFormat, checkSamplesAgainstScript, parseSamples, parseScript, parseStyle } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { CharacterCache, addPhotoRefs, composePrompt, resolveHeroList } from './lib/frame-refs';
import { MAX_REFS, expectedImageCredits, getRecord, planJob, runImageJob, type ImageJob } from './lib/image-job';
import { log } from './lib/log';
import { assertStoryExists } from './lib/paths';
import { estimateImage, fmt } from './lib/pricing';
import { RunContext } from './lib/run-context';
import { sampleFile, sampleKey } from './lib/samples-paths';

const HELP = `Етап 1а: зразки стилю.
Прапорці:
  --story <id>           історія (обов'язково)
  --run / --limit-credits N   справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --resolution r         512 | 1K (за замовчуванням) | 2K | 4K; зразок із полем «Роздільність:» використовує свою
  --image-credits N      очікувана ціна одної картинки (потрібна для кожної роздільності, поки в маніфесті немає виміряної для неї; виміряна ціна 512 і 1K ведеться окремо)
  --only 1,3             лише ці зразки
  --regen N              перегенерувати зразок N (не більше --max-regens разів, за замовчуванням 1)
  --prompt "текст" | --prompt-file f   новий «Для генератора» для --regen (стиль додається скриптом)
  --max-regens N         дозволена кількість перегенерацій на картинку (1)
  --upgrade              замінити наявні зразки іншої роздільності (не перегенерація)
  --ignore-pending       продовжити, хоча попередній запуск обірвався між запитом і відповіддю`;

async function main(): Promise<void> {
  const { values } = parseCli({
    resolution: { type: 'string' }, 'image-credits': { type: 'string' }, only: { type: 'string' }, regen: { type: 'string' },
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, 'max-regens': { type: 'string' }, upgrade: { type: 'boolean' }, 'ignore-pending': { type: 'boolean' },
  });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const sd = parseSamples();
  checkSamplesAgainstScript(sd, parseScript(story));
  const style = parseStyle().generatorText;
  const defaultResolution = values.resolution ?? '1K';
  if (!RESOLUTIONS.includes(defaultResolution)) throw new Error(`--resolution має бути ${RESOLUTIONS.join(', ')}.`);
  const maxRegens = Number(values['max-regens'] ?? 1);
  const imageFlag = values['image-credits'] !== undefined ? Number(values['image-credits']) : undefined;
  const nums = sd.samples.map((s) => s.n);
  const regenN = values.regen !== undefined ? Number(values.regen) : undefined;
  if (regenN !== undefined && !nums.includes(regenN)) throw new Error(`--regen ${values.regen}: такого зразка немає (є: ${nums.join(', ')}).`);
  if (values.prompt && values['prompt-file']) throw new Error('--prompt і --prompt-file разом не можна.');
  const newPrompt = values.prompt ?? (values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8').trim() : undefined);
  if (newPrompt !== undefined && regenN === undefined) throw new Error('--prompt/--prompt-file мають сенс тільки з --regen N.');
  const only = values.only ? new Set(values.only.split(',').map((x) => Number(x.trim()))) : undefined;
  if (only) for (const n of only) if (!nums.includes(n)) throw new Error(`--only: зразка ${n} немає (є: ${nums.join(', ')}).`);

  const cache = new CharacterCache();
  const client = new ElevenLabsClient();
  const ctx = new RunContext(client, story, 'samples', flags.run, flags.limit);
  log(`Зразків у art/samples.md: ${sd.samples.length}. Роздільність за замовчуванням ${defaultResolution} (зразок може мати власну в полі «Роздільність:»), модель gemini-3.1-flash-image. Ціна картинки без вимірювання: ${fmt(estimateImage(imageFlag))}.`);

  const jobs: Array<{ n: number; job: ImageJob; missing: string[] }> = [];
  for (const s of sd.samples) {
    if (regenN !== undefined ? s.n !== regenN : only && !only.has(s.n)) continue;
    const r = resolveHeroList(s.heroes, `Зразок ${s.n}, «Герої:»`, cache);
    addPhotoRefs(story, s.photoRefs, `Зразок ${s.n}`, r);
    if (r.refs.length + r.missing.length > MAX_REFS) throw new Error(`Зразок ${s.n}: референсів більше ${MAX_REFS}.`);
    const scene = regenN === s.n && newPrompt ? newPrompt : s.prompt;
    const resolution = s.resolution ?? defaultResolution;
    const job: ImageJob = {
      key: sampleKey(s.n), label: `зразок ${s.n}`, prompt: composePrompt(scene, s.style ?? style), refs: r.refs, aspect: aspectFromFormat(s.format), resolution,
      outFile: sampleFile(story, s.n), regen: regenN === s.n, maxRegens, ignorePending: Boolean(values['ignore-pending']), upgrade: Boolean(values.upgrade), expectedCredits: 0,
    };
    jobs.push({ n: s.n, job, missing: r.missing });
    const plan = planJob(story, job);
    log(`  зразок ${String(s.n).padStart(2)} ${s.format.padEnd(5)} ${resolution.padEnd(3)}${s.style ? ' свій стиль' : ''} фр. ${s.fragment ?? '—'}: ${plan.action.padEnd(8)} refs=${r.refs.length + r.missing.length}${r.missing.length ? ` (бракує: ${r.missing.join('; ')})` : ''} ${plan.action === 'skip' ? '' : '— ' + plan.why}`);
  }
  if (!flags.run) {
    const blocked = jobs.filter((j) => j.missing.length && planJob(story, j.job).action !== 'skip');
    log(`\nСУХИЙ ПРОГІН: нічого не викликано.${blocked.length ? ` Для справжнього запуску бракує референсів у ${blocked.length} зразках (спершу аркуші героїв: character-sheets.ts, upload-character-sheet.ts).` : ''}`);
    if (jobs[0]) log(`Приклад запиту (зразок ${jobs[0].n}):\n---\n${jobs[0].job.prompt}\n---`);
    return;
  }
  for (const res of new Set(jobs.map((j) => j.job.resolution))) expectedImageCredits(story, imageFlag, res); // ранній збій, якщо ціни для якоїсь роздільності немає
  await ctx.start();
  const refused: string[] = [];
  try {
    for (const { n, job } of jobs) {
      const s = sd.samples.find((x) => x.n === n)!;
      const r = resolveHeroList(s.heroes, `Зразок ${n}, «Герої:»`, cache);
      addPhotoRefs(story, s.photoRefs, `Зразок ${n}`, r);
      if (planJob(story, job).action !== 'skip' && r.missing.length) throw new Error(`Зразок ${n}: не можна генерувати, бракує референсів: ${r.missing.join('; ')}.`);
      job.refs = r.refs;
      job.expectedCredits = expectedImageCredits(story, imageFlag, job.resolution);
      if ((await runImageJob(ctx, job)) === 'refused') refused.push(job.label);
      const rec = getRecord(story, job.key);
      if (rec) log(`    зразок ${n}: перегенерацій ${rec.regen_count} з ${maxRegens}`);
    }
  } finally {
    await ctx.finish();
  }
  if (refused.length) throw new Error(`Відмовлено (ліміт перегенерацій чи попередній обрив): ${refused.join(', ')}. Див. повідомлення вище.`);
}

runMain(main);
