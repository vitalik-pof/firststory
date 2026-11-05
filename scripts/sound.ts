// Крок 10: музика (music compose) і шуми (text-to-sound-effects) за stories/<id>/sound.md
// у work/<id>/audio/music.mp3 і sfx-NN.mp3.
//
//   npx tsx scripts/sound.ts --story 01-natalia                                сухий прогін
//   npx tsx scripts/sound.ts --story 01-natalia --run --limit-credits 20000
//   npx tsx scripts/sound.ts --story 01-natalia --run ... --only music,sfx-2
//   npx tsx scripts/sound.ts --story 01-natalia --run ... --redo sfx-2        (знову платно; старий файл лишається як .prev)

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { parseSound } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { updateManifest, readManifest } from './lib/manifest';
import { assertStoryExists, paths } from './lib/paths';
import { estimateMusic, estimateSfx, fmt } from './lib/pricing';
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

interface Item {
  id: string;
  label: string;
  file: string;
  seconds: number;
  prompt: string;
  cost: ReturnType<typeof estimateMusic>;
  kind: 'music' | 'sfx';
  instrumental?: boolean;
}

async function main(): Promise<void> {
  const { values } = parseCli({ only: { type: 'string' }, redo: { type: 'string' }, 'music-model': { type: 'string' }, 'output-format': { type: 'string' } });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const sound = parseSound(story);
  const outFmt = values['output-format'] ?? 'mp3_44100_128';
  const dir = paths.workFile(story, 'audio');

  const items: Item[] = [
    { id: 'music', label: 'музика', file: `${dir}/music.mp3`, seconds: sound.music.seconds, prompt: sound.music.prompt, cost: estimateMusic(sound.music.seconds), kind: 'music', instrumental: sound.music.instrumental },
    ...sound.sfx.map((s): Item => ({ id: `sfx-${s.n}`, label: `шум ${s.n}`, file: `${dir}/sfx-${pad2(s.n)}.mp3`, seconds: s.seconds, prompt: s.prompt, cost: estimateSfx(s.seconds), kind: 'sfx' })),
  ];
  const known = new Set(items.map((i) => i.id));
  const parseList = (v: string | undefined): Set<string> | undefined => {
    if (!v) return undefined;
    const set = new Set(v.split(',').map((x) => x.trim()).filter(Boolean));
    for (const id of set) if (!known.has(id)) throw new Error(`Невідомий елемент «${id}» (є: ${[...known].join(', ')}).`);
    return set;
  };
  const only = parseList(values.only);
  const redo = parseList(values.redo);
  const manifest = readManifest(story);

  const client = new ElevenLabsClient();
  const ctx = new RunContext(client, story, 'sound', flags.run, flags.limit);
  let total = 0;
  const todo: Item[] = [];
  for (const it of items) {
    if (only && !only.has(it.id) && !redo?.has(it.id)) continue;
    const done = existsSync(it.file) && manifest.audio[it.id];
    const action = done ? (redo?.has(it.id) ? 'redo' : 'skip') : 'generate';
    log(`  ${it.label.padEnd(8)} ${String(it.seconds).padStart(5)} с  ${action.padEnd(8)} ${fmt(it.cost)}  → ${paths.rel(it.file)}`);
    if (action !== 'skip') {
      todo.push(it);
      total += it.cost.credits ?? 0;
    }
  }
  log(`Разом до генерації: ${todo.length} шт., ~${total} кредитів (музика й шуми: оцінка з документації, фактичне число запишемо в маніфест).`);
  if (!flags.run) return void log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');

  await ctx.start();
  try {
    mkdirSync(dir, { recursive: true });
    for (const it of todo) {
      ctx.assertBudget(it.cost.credits ?? 0, it.label);
      const sp = await client.beginSpend();
      let extra: Record<string, unknown> = {};
      let audio: Buffer;
      if (it.kind === 'music') {
        const body: Record<string, unknown> = { prompt: it.prompt, music_length_ms: Math.round(it.seconds * 1000), force_instrumental: Boolean(it.instrumental) };
        if (values['music-model']) body.model_id = values['music-model'];
        const r = await client.composeMusic(body, { output_format: outFmt }, sp.guard);
        audio = r.audio;
        extra = { song_id: r.songId, model_id: values['music-model'] ?? null };
      } else {
        const r = await client.soundEffect({ text: it.prompt, duration_seconds: it.seconds }, { output_format: outFmt }, sp.guard);
        audio = r.audio;
        extra = { character_cost_header: r.characterCost };
      }
      if (existsSync(it.file)) renameSync(it.file, `${it.file}.prev`);
      writeFileSync(it.file, audio);
      const { spent } = await sp.finish();
      ctx.recordSpent(spent);
      updateManifest(story, (m) => {
        const regen = ((m.audio[it.id]?.regen_count as number | undefined) ?? 0) + (m.audio[it.id] ? 1 : 0);
        m.audio[it.id] = { file: paths.rel(it.file), kind: it.kind, seconds_requested: it.seconds, prompt: it.prompt, credits: spent, output_format: outFmt, regen_count: regen, generated_at: new Date().toISOString(), ...extra };
      });
      log(`  ${it.label}: готово → ${paths.rel(it.file)} (${spent} кредитів)`);
    }
  } finally {
    await ctx.finish();
  }
}

runMain(main);
