// Крок 10: музика (music compose) і шуми (text-to-sound-effects) за stories/<id>/sound.md
// у work/<id>/audio/music.mp3 і sfx-NN.mp3.
//
//   npx tsx scripts/sound.ts --story 01-natalia                                сухий прогін
//   npx tsx scripts/sound.ts --story 01-natalia --run --limit-credits 20000
//   npx tsx scripts/sound.ts --story 01-natalia --run ... --only music,sfx-2
//   npx tsx scripts/sound.ts --story 01-natalia --run ... --redo sfx-2        (знову платно; старий файл лишається як .prev)

import { commonFlags, parseCli, runMain } from './lib/cli';
import { parseSound } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { assertStoryExists, paths } from './lib/paths';
import { type SoundItem, parseIdList, planSoundItems, runSoundItems } from './lib/sound-run';
import { RunContext } from './lib/run-context';
import { pad2 } from './lib/text';

const HELP = `Крок 10: музика і шуми.
Прапорці:
  --story <id>            історія (обов'язково)
  --run / --limit-credits N   справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --only music,sfx-2      лише ці елементи
  --redo music,sfx-2      згенерувати заново (знову платно); старий файл зберігається як .prev
  --music-model <id>      music_v1 | music_v2 | music_v2_5 (за замовчуванням не передається, діє типова модель API)
  --output-format <fmt>   mp3_44100_128 (за замовчуванням)`;

async function main(): Promise<void> {
  const { values } = parseCli({ only: { type: 'string' }, redo: { type: 'string' }, 'music-model': { type: 'string' }, 'output-format': { type: 'string' } });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const sound = parseSound(story);
  const outFmt = values['output-format'] ?? 'mp3_44100_128';
  const dir = paths.workFile(story, 'audio');

  const items: SoundItem[] = [
    { id: 'music', label: 'музика', file: `${dir}/music.mp3`, seconds: sound.music.seconds, prompt: sound.music.prompt, kind: 'music', instrumental: sound.music.instrumental },
    ...sound.sfx.map((s): SoundItem => ({ id: `sfx-${s.n}`, label: `шум ${s.n}`, file: `${dir}/sfx-${pad2(s.n)}.mp3`, seconds: s.seconds, prompt: s.prompt, kind: 'sfx' })),
  ];
  const known = new Set(items.map((i) => i.id));
  const { todo } = planSoundItems(story, items, parseIdList(values.only, known), parseIdList(values.redo, known));
  if (!flags.run) return void log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');
  const ctx = new RunContext(new ElevenLabsClient(), story, 'sound', true, flags.limit);
  await ctx.start();
  try {
    await runSoundItems(ctx, todo, { outFmt, musicModel: values['music-model'] });
  } finally {
    await ctx.finish();
  }
}

runMain(main);
