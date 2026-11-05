// Крок 8: кадри за розкадровкою у work/<id>/frames/frame-NN.png.
// Запит = «Для генератора» кадру + текст стилю; референси = аркуші героїв із «Герої:» кадру
// (до 14) або винятки з stories/<id>/frame-refs.json (там же залежності кадр→кадр).
//
//   npx tsx scripts/frames.ts --story 01-natalia                               сухий прогін
//   npx tsx scripts/frames.ts --story 01-natalia --run --limit-credits 20000 --image-credits 100
//   npx tsx scripts/frames.ts --story 01-natalia --run ... --only 3,5
//   npx tsx scripts/frames.ts --story 01-natalia --run ... --regen 7 --prompt "новий текст кадру"

import { readFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { aspectFromFormat, checkStoryboardAgainstScript, parseScript, parseStoryboard, parseStyle } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { CharacterCache, composePrompt, frameFile, frameKey, loadFrameRefs, orderFrames, resolveFrameRefs } from './lib/frame-refs';
import { expectedImageCredits, getRecord, MAX_REFS, planJob, runImageJob, type ImageJob } from './lib/image-job';
import { log } from './lib/log';
import { assertStoryExists, paths } from './lib/paths';
import { estimateImage, fmt } from './lib/pricing';
import { RunContext } from './lib/run-context';

const HELP = `Крок 8: кадри.
Прапорці:
  --story <id>           історія (обов'язково)
  --run / --limit-credits N   справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --image-credits N      очікувана ціна однієї картинки (для ліміту; ціни в документації немає)
  --only 3,5,7           лише ці кадри
  --regen N              перегенерувати кадр N (не більше --max-regens разів, за замовчуванням 1)
  --prompt "текст" | --prompt-file f   новий текст «Для генератора» для --regen (стиль додається скриптом)
  --max-regens N         дозволена кількість перегенерацій на картинку (1 на Етапі 1)
  --aspect A:B           замість «Формат кадру» з розкадровки
  --resolution r         512 | 1K (за замовчуванням) | 2K | 4K
  --ignore-pending       продовжити, хоча попередній запуск обірвався між запитом і відповіддю`;

async function main(): Promise<void> {
  const { values } = parseCli({
    'image-credits': { type: 'string' }, only: { type: 'string' }, regen: { type: 'string' }, prompt: { type: 'string' },
    'prompt-file': { type: 'string' }, 'max-regens': { type: 'string' }, aspect: { type: 'string' }, resolution: { type: 'string' },
    'ignore-pending': { type: 'boolean' },
  });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const script = parseScript(story);
  const sb = parseStoryboard(story);
  checkStoryboardAgainstScript(story, sb, script);
  const style = parseStyle().generatorText;
  const aspect = values.aspect ?? aspectFromFormat(sb.format);
  const resolution = values.resolution ?? '1K';
  const maxRegens = Number(values['max-regens'] ?? 1);
  const imageCreditsFlag = values['image-credits'] !== undefined ? Number(values['image-credits']) : undefined;
  const nums = sb.frames.map((f) => f.n);
  const overrides = loadFrameRefs(story, nums);
  const cache = new CharacterCache();

  const regenN = values.regen !== undefined ? Number(values.regen) : undefined;
  if (regenN !== undefined && !nums.includes(regenN)) throw new Error(`--regen ${values.regen}: такого кадру немає (є ${nums[0]}–${nums[nums.length - 1]}).`);
  if (values.prompt && values['prompt-file']) throw new Error('--prompt і --prompt-file разом не можна.');
  const newPrompt = values.prompt ?? (values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8').trim() : undefined);
  if (newPrompt !== undefined && regenN === undefined) throw new Error('--prompt/--prompt-file мають сенс тільки з --regen N.');
  const only = values.only ? new Set(values.only.split(',').map((x) => Number(x.trim()))) : undefined;
  if (only) for (const n of only) if (!nums.includes(n)) throw new Error(`--only: кадру ${n} немає в розкадровці.`);

  // Референси й залежності рахуємо для всіх кадрів, щоб правильно впорядкувати.
  const resolved = new Map(sb.frames.map((f) => [f.n, resolveFrameRefs(story, f, overrides, cache)]));
  for (const f of sb.frames) {
    const r = resolved.get(f.n)!;
    if (r.refs.length + r.missing.length > MAX_REFS) throw new Error(`Кадр ${f.n}: референсів більше ${MAX_REFS}.`);
  }
  const ordered = orderFrames(sb.frames, (n) => resolved.get(n)!.deps);
  const selected = ordered.filter((f) => (regenN !== undefined ? f.n === regenN : only ? only.has(f.n) : true));

  const client = new ElevenLabsClient();
  const ctx = new RunContext(client, story, 'frames', flags.run, flags.limit);
  log(`Кадрів у розкадровці: ${sb.frames.length}, до обробки: ${selected.length}. Формат ${aspect}, роздільність ${resolution}. Ціна картинки: ${fmt(estimateImage(imageCreditsFlag))}.`);

  const jobs: Array<{ n: number; job: ImageJob; missing: string[] }> = [];
  for (const f of selected) {
    const r = resolved.get(f.n)!;
    const scene = regenN === f.n && newPrompt ? newPrompt : f.prompt;
    const job: ImageJob = {
      key: frameKey(f.n), label: `кадр ${f.n}`, prompt: composePrompt(scene, style), refs: r.refs, aspect, resolution,
      outFile: frameFile(story, f.n), regen: regenN === f.n, maxRegens, ignorePending: Boolean(values['ignore-pending']), expectedCredits: 0,
    };
    jobs.push({ n: f.n, job, missing: r.missing });
    const plan = planJob(story, job);
    log(`  кадр ${String(f.n).padStart(2)} (фр. ${f.fragment}): ${plan.action.padEnd(8)} refs=${r.refs.length + r.missing.length}${r.missing.length ? ` (бракує: ${r.missing.join('; ')})` : ''} ${plan.action === 'skip' ? '' : '— ' + plan.why}`);
  }
  const blocked = jobs.filter((j) => j.missing.length && planJob(story, j.job).action !== 'skip');
  if (!flags.run) {
    log(`\nСУХИЙ ПРОГІН: нічого не викликано.${blocked.length ? ` Для справжнього запуску бракує референсів у ${blocked.length} кадрах (завантажте аркуші: upload-character-sheet.ts).` : ''}`);
    if (jobs[0]) log(`Приклад запиту (кадр ${jobs[0].n}):\n---\n${jobs[0].job.prompt}\n---`);
    return;
  }
  const expected = expectedImageCredits(story, imageCreditsFlag);
  await ctx.start();
  const refused: string[] = [];
  try {
    for (const { n, job } of jobs) {
      // Референси могли з'явитися під час запуску (кадр-залежність): перераховуємо.
      const r = resolveFrameRefs(story, sb.frames.find((f) => f.n === n)!, overrides, cache);
      if (planJob(story, job).action !== 'skip' && r.missing.length) {
        throw new Error(`Кадр ${n}: не можна генерувати, бракує референсів: ${r.missing.join('; ')}.`);
      }
      job.refs = r.refs;
      job.expectedCredits = expected;
      if ((await runImageJob(ctx, job)) === 'refused') refused.push(job.label);
      const rec = getRecord(story, job.key);
      if (rec) log(`    кадр ${n}: перегенерацій ${rec.regen_count} з ${maxRegens}`);
    }
  } finally {
    await ctx.finish();
  }
  if (refused.length) throw new Error(`Відмовлено (ліміт перегенерацій чи попередній обрив): ${refused.join(', ')}. Див. повідомлення вище.`);
}

runMain(main);
