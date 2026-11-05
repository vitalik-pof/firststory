// Крок 5: три проби голосу (text-to-voice design), створення голосу з обраної проби
// (text-to-voice create), запис voice_id у voices.md.
//
//   npx tsx scripts/voice-previews.ts --story 01-natalia                       сухий прогін
//   npx tsx scripts/voice-previews.ts --story 01-natalia --run --limit-credits 5000

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCli, commonFlags, runMain } from './lib/cli';
import { findVoice, parseVoiceMd, parseVoices, writeVoiceId, type VoiceEntry } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { readManifest, updateManifest } from './lib/manifest';
import { assertStoryExists, getRoot, paths } from './lib/paths';
import { estimateVoiceDesign, fmt } from './lib/pricing';
import { RunContext } from './lib/run-context';

const HELP = `Крок 5: проби голосу.
Прапорці:
  --story <id>          історія (обов'язково)
  --run                 справді викликати API (без нього сухий прогін, нічого не витрачається)
  --limit-credits N     загальний ліміт кредитів на історію (обов'язковий з --run)
  --voice <id>          голос із voices.md (за замовчуванням з voice.md, інакше за «Для історії»)
  --pick N              з якої проби створити голос (за замовчуванням 1)
  --design-model <id>   eleven_multilingual_ttv_v2 (за замовчуванням) або eleven_ttv_v3
  --force               створити голос знову, навіть якщо voice_id уже є (потрібно на Етапі 2, коли режисер обирає іншу пробу)`;

function resolveVoice(story: string, override: string | undefined): VoiceEntry {
  const voices = parseVoices();
  if (override) return findVoice(voices, override);
  try {
    return findVoice(voices, parseVoiceMd(story).voiceId);
  } catch (e) {
    if (e instanceof Error && e.name === 'MissingDocError') {
      const m = voices.voices.filter((v) => v.story === story);
      if (m.length === 1) return m[0]!;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const { values } = parseCli({
    voice: { type: 'string' }, pick: { type: 'string' }, 'design-model': { type: 'string' }, force: { type: 'boolean' },
  });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const entry = resolveVoice(story, values.voice);
  const pick = Number(values.pick ?? 1);
  if (!Number.isInteger(pick) || pick < 1) throw new Error('--pick має бути цілим числом від 1.');
  const designModel = values['design-model'] ?? 'eleven_multilingual_ttv_v2';

  const desc = entry.designPrompt;
  const probe = entry.probeText;
  const problems: string[] = [];
  if (desc.length < 20 || desc.length > 1000) problems.push(`«Опис для Voice Design» має ${desc.length} знаків, API приймає 20–1000 (роль voice-director, voices.md)`);
  if (probe.length < 100 || probe.length > 1000) problems.push(`«Текст проби» має ${probe.length} знаків, API приймає 100–1000 (роль voice-director, voices.md)`);
  if (problems.length) throw new Error('voices.md не підходить для Voice Design:\n  - ' + problems.join('\n  - '));

  const previewsDir = paths.workFile(story, 'voice-previews');
  const manifest = readManifest(story);
  const prevDone = (manifest.voice?.previews as Array<{ file: string }> | undefined)?.every((p) => existsSync(join(getRoot(), p.file)));
  const have = Boolean(manifest.voice?.previews) && prevDone;
  const voiceCreated = typeof manifest.voice?.voice_id === 'string' ? (manifest.voice.voice_id as string) : '';

  const client = new ElevenLabsClient();
  const cost = estimateVoiceDesign(probe.length);
  log(`Голос «${entry.id}» (історія ${entry.story}). Проби: ${probe.length} знаків, опис: ${desc.length} знаків, модель дизайну: ${designModel}.`);
  log(`Вартість трьох проб: ${fmt(cost)}. Створення голосу з проби: кредити не очікуються.`);
  log(`Проби: ${have ? 'вже є, повторно не генеруємо' : 'буде згенеровано 3 шт. у ' + paths.rel(previewsDir)}`);
  log(`Створення голосу: ${voiceCreated && !values.force ? `вже є (${voiceCreated}), пропуск` : `з проби ${pick}`}`);

  if (!flags.run) {
    log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');
    return;
  }
  const ctx = new RunContext(client, story, 'voice-previews', true, flags.limit);
  await ctx.start();
  try {
    if (!have) {
      ctx.assertBudget(cost.credits ?? 0, 'Voice Design');
      const sp = await client.beginSpend();
      const res = await client.designVoice({ voice_description: desc, text: probe, model_id: designModel }, sp.guard);
      mkdirSync(previewsDir, { recursive: true });
      const previews = res.previews.map((p, i) => {
        const file = paths.workFile(story, 'voice-previews', `preview-${i + 1}.mp3`);
        writeFileSync(file, Buffer.from(p.audio_base_64, 'base64'));
        return { n: i + 1, generated_voice_id: p.generated_voice_id, file: paths.rel(file), duration_secs: p.duration_secs };
      });
      const { spent } = await sp.finish({ expectRise: true });
      ctx.recordSpent(spent);
      updateManifest(story, (m) => {
        m.voice = { ...(m.voice ?? {}), voice_entry: entry.id, design_model: designModel, probe_text: probe, previews, design_credits: spent, designed_at: new Date().toISOString() };
      });
      log(`Проби збережено: ${previews.length} шт. (витрачено ${spent} кредитів).`);
      if (previews.length !== 3) log(`УВАГА: API повернув ${previews.length} проб замість трьох.`);
    }

    const m = readManifest(story);
    const previews = m.voice!.previews as Array<{ n: number; generated_voice_id: string }>;
    const chosen = previews.find((p) => p.n === pick);
    if (!chosen) throw new Error(`Проби ${pick} немає (є: ${previews.map((p) => p.n).join(', ')}).`);
    const existing = typeof m.voice?.voice_id === 'string' ? (m.voice.voice_id as string) : '';
    if (existing && !values.force) {
      log(`Голос уже створено: ${existing}. Для іншої проби: --pick N --force.`);
      if (entry.voiceId !== existing) {
        writeVoiceId(entry, existing);
        log('voice_id дописано у voices.md.');
      }
    } else {
      if (entry.voiceId && !existing && !values.force) {
        throw new Error(`У voices.md уже є voice_id (${entry.voiceId}), але в маніфесті голосу немає. Щоб не затерти його, запустіть з --force.`);
      }
      const name = `${entry.id} ${story}${existing ? ` проба ${pick}` : ''}`;
      const created = await client.createVoice({ generated_voice_id: chosen.generated_voice_id, voice_name: name, voice_description: desc });
      writeVoiceId(entry, created.voice_id);
      updateManifest(story, (mm) => {
        mm.voice = { ...(mm.voice ?? {}), voice_id: created.voice_id, voice_name: name, picked_preview: pick, created_at: new Date().toISOString() };
      });
      log(`Голос створено з проби ${pick}: ${created.voice_id}. Записано у voices.md і маніфест.`);
    }
  } finally {
    await ctx.finish();
  }
}

runMain(main);
