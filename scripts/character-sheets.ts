// Крок 7: аркуші героїв (flows image create, gemini-3.1-flash-image) у work/characters/.
// Завантаження затвердженого аркуша — окрема команда upload-character-sheet.ts.
//
//   npx tsx scripts/character-sheets.ts --story 01-natalia                              сухий прогін
//   npx tsx scripts/character-sheets.ts --story 01-natalia --run --limit-credits 20000 --image-credits 100
//   npx tsx scripts/character-sheets.ts --story 01-natalia --run ... --regen natalia:вагітна --prompt "новий текст"

import { readFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { aspectFromFormat, findSheet, parseCharacter, parseStoryboard, parseStyle, type CharacterDoc } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { composePrompt, sheetFile, sheetKey } from './lib/frame-refs';
import { expectedImageCredits, getRecord, planJob, runImageJob, type ImageJob } from './lib/image-job';
import { log } from './lib/log';
import { assertStoryExists, paths } from './lib/paths';
import { estimateImage, fmt } from './lib/pricing';
import { RunContext } from './lib/run-context';

const HELP = `Крок 7: аркуші героїв.
Прапорці:
  --story <id>           історія (обов'язково)
  --run / --limit-credits N   справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --image-credits N      очікувана ціна однієї картинки (для ліміту; ціни в документації немає)
  --character <список>   лише ці: natalia, natalia:вагітна, natalia-son (через кому). За замовчуванням усі герої з розкадровки
  --aspect <A:B>         співвідношення сторін (за замовчуванням 16:9, так просить art/style.md)
  --resolution <r>       512 | 1K (за замовчуванням) | 2K | 4K
  --regen <герой[:версія]>   перегенерувати один аркуш (не більше --max-regens разів, за замовчуванням 1)
  --prompt "текст" | --prompt-file f   новий текст для генератора при --regen (без стилю: його додає скрипт)
  --max-regens N         дозволена кількість перегенерацій на картинку (1 на Етапі 1)
  --ignore-pending       продовжити, хоча попередній запуск обірвався між запитом і відповіддю`;

interface SheetTarget {
  doc: CharacterDoc;
  label: string;
  slug: string;
  prompt: string;
}

async function main(): Promise<void> {
  const { values } = parseCli({
    'image-credits': { type: 'string' }, character: { type: 'string' }, aspect: { type: 'string' }, resolution: { type: 'string' },
    regen: { type: 'string' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, 'max-regens': { type: 'string' }, 'ignore-pending': { type: 'boolean' },
  });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const sb = parseStoryboard(story);
  const style = parseStyle().generatorText;
  const aspect = values.aspect ?? '16:9';
  aspectFromFormat(aspect);
  const resolution = values.resolution ?? '1K';
  const maxRegens = Number(values['max-regens'] ?? 1);
  const imageCreditsFlag = values['image-credits'] !== undefined ? Number(values['image-credits']) : undefined;

  // Які аркуші потрібні: усі версії героїв, згаданих у розкадровці (або те, що вказано в --character).
  const heroIds = [...new Set(sb.frames.flatMap((f) => f.heroes.map((h) => h.id)))];
  const wanted = values.character ? values.character.split(',').map((x) => x.trim()).filter(Boolean) : heroIds;
  const targets: SheetTarget[] = [];
  for (const w of wanted) {
    const [id, label] = splitRef(w);
    const doc = parseCharacter(id);
    const sheets = label ? [findSheet(doc, label, `--character ${w}`)] : doc.sheets;
    for (const s of sheets) targets.push({ doc, label: s.label, slug: s.slug, prompt: s.prompt });
  }

  let regenKey: string | undefined;
  let newPrompt: string | undefined;
  if (values.regen) {
    const [id, label] = splitRef(values.regen);
    const doc = parseCharacter(id);
    const sh = findSheet(doc, label, `--regen ${values.regen}`);
    regenKey = sheetKey(id, sh.slug);
    if (values.prompt && values['prompt-file']) throw new Error('--prompt і --prompt-file разом не можна.');
    newPrompt = values.prompt ?? (values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8').trim() : undefined);
  }

  const client = new ElevenLabsClient();
  const ctx = new RunContext(client, story, 'character-sheets', flags.run, flags.limit);
  const price = estimateImage(imageCreditsFlag);
  log(`Аркушів: ${targets.length}. Формат ${aspect}, роздільність ${resolution}, модель gemini-3.1-flash-image. Ціна картинки: ${fmt(price)}.`);

  const jobs: Array<{ t: SheetTarget; job: ImageJob }> = [];
  for (const t of targets) {
    const key = sheetKey(t.doc.id, t.slug);
    if (regenKey && key !== regenKey) continue;
    const scene = regenKey && newPrompt ? newPrompt : t.prompt;
    jobs.push({
      t,
      job: {
        key, label: `${t.doc.id}${t.label === 'main' ? '' : ` «${t.label}»`}`, prompt: composePrompt(scene, style), refs: [], aspect, resolution,
        outFile: sheetFile(t.doc.id, t.slug), regen: Boolean(regenKey), maxRegens, ignorePending: Boolean(values['ignore-pending']),
        expectedCredits: 0,
      },
    });
  }
  if (regenKey && !jobs.length) throw new Error(`--regen ${values.regen}: такого аркуша немає серед цілей.`);

  for (const { job } of jobs) {
    const plan = planJob(story, job);
    log(`  ${job.label}: ${plan.action} (${plan.why}) → ${paths.rel(job.outFile)}`);
  }
  if (!flags.run) {
    log(`\nСУХИЙ ПРОГІН: нічого не викликано. Приклад першого аркуша:\n---\n${jobs[0]?.job.prompt}\n---\nДодайте --run --limit-credits N --image-credits N.`);
    return;
  }
  const expected = expectedImageCredits(story, imageCreditsFlag);
  await ctx.start();
  const refused: string[] = [];
  try {
    for (const { job } of jobs) {
      job.expectedCredits = expected;
      const out = await runImageJob(ctx, job);
      if (out === 'refused') refused.push(job.label);
      if (out === 'generated' || out === 'regenerated') {
        const rec = getRecord(story, job.key)!;
        log(`    лічильник перегенерацій: ${rec.regen_count}. Після затвердження художником: upload-character-sheet.ts.`);
      }
    }
  } finally {
    await ctx.finish();
  }
  if (refused.length) throw new Error(`Відмовлено (ліміт перегенерацій чи попередній обрив): ${refused.join(', ')}. Див. повідомлення вище.`);
}

function splitRef(s: string): [string, string | undefined] {
  const i = s.indexOf(':');
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

runMain(main);
