// Етап 1б: зразки музики й шумів за stories/<id>/sound-samples.md → work/<id>/audio/samples/
// (music-N.mp3, sfx-NN.mp3). Межі API перевіряються при читанні документа.
//
//   npx tsx scripts/sound-samples.ts --story 01-natalia                                 сухий прогін
//   npx tsx scripts/sound-samples.ts --story 01-natalia --run --limit-credits 20000
//   npx tsx scripts/sound-samples.ts --story 01-natalia --run … --only music-2,sfx-1
//   npx tsx scripts/sound-samples.ts --story 01-natalia --run … --redo music-2

import { commonFlags, parseCli, runMain } from './lib/cli';
import { parseSoundSamples } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { assertStoryExists, paths } from './lib/paths';
import { RunContext } from './lib/run-context';
import { type SoundItem, parseIdList, planSoundItems, runSoundItems } from './lib/sound-run';
import { pad2 } from './lib/text';

const HELP = `Етап 1б: зразки музики й шумів.
Прапорці:
  --story <id>            історія (обов'язково)
  --run / --limit-credits N   справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --only music-1,sfx-2    лише ці елементи (id: music-N, sfx-N)
  --redo music-1          згенерувати заново (знову платно); старий файл стає .prev
  --music-model <id>      music_v1 | music_v2 | music_v2_5 (за замовчуванням не передається)
  --output-format <fmt>   mp3_44100_128 (за замовчуванням)`;

async function main(): Promise<void> {
  const { values } = parseCli({ only: { type: 'string' }, redo: { type: 'string' }, 'music-model': { type: 'string' }, 'output-format': { type: 'string' } });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const doc = parseSoundSamples(story);
  const dir = paths.workFile(story, 'audio', 'samples');
  const items: SoundItem[] = [
    ...doc.music.map((m): SoundItem => ({ id: `music-${m.n}`, label: `музика ${m.n}`, file: `${dir}/music-${m.n}.mp3`, seconds: m.seconds, prompt: m.prompt, kind: 'music', instrumental: m.instrumental })),
    ...doc.sfx.map((s): SoundItem => ({ id: `sfx-${s.n}`, label: `шум ${s.n}`, file: `${dir}/sfx-${pad2(s.n)}.mp3`, seconds: s.seconds, prompt: s.prompt, kind: 'sfx' })),
  ];
  // У маніфесті зразки лежать під префіксом sample-, щоб не плутатися з повним обсягом (music, sfx-N).
  const keyed = items.map((i) => ({ ...i, id: `sample-${i.id}` }));
  const known = new Set(items.map((i) => i.id));
  const strip = (v: string | undefined): string | undefined => v?.split(',').map((x) => `sample-${x.trim()}`).join(',');
  const check = (v: string | undefined) => parseIdList(v, known);
  check(values.only);
  check(values.redo);
  const { todo } = planSoundItems(story, keyed, parseIdList(strip(values.only), new Set(keyed.map((i) => i.id))), parseIdList(strip(values.redo), new Set(keyed.map((i) => i.id))));
  if (!flags.run) return void log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');
  const ctx = new RunContext(new ElevenLabsClient(), story, 'sound-samples', true, flags.limit);
  await ctx.start();
  try {
    await runSoundItems(ctx, todo, { outFmt: values['output-format'] ?? 'mp3_44100_128', musicModel: values['music-model'] });
  } finally {
    await ctx.finish();
  }
}

runMain(main);
