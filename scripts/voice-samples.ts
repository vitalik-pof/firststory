// Проби жіночих голосів моделлю eleven_v4 з вирівнюванням до нашого голосу (темп і висота).
//
//   npx tsx scripts/voice-samples.ts --story 01-natalia                                  сухий прогін
//   npx tsx scripts/voice-samples.ts --story 01-natalia --run --limit-credits 20000      справжній запуск
//   npx tsx scripts/voice-samples.ts --story 01-natalia --assemble-only                  безкоштовно: вирівняти наявні проби й зібрати сторінку
//
// Вхід: stories/<id>/voice-samples.md (роль voice-director). Вихід: work/<id>/voice-samples/
// (raw/<slug>.mp3 сирі, <slug>.mp3 вирівняні, summary.json, index.html). Деталі: scripts/README.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commonFlags, parseCli, runMain, UsageError } from './lib/cli';
import { hasBinary } from './lib/audio';
import { ApiError, ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { assertStoryExists, paths } from './lib/paths';
import { estimateTts, fmt, ttsRate } from './lib/pricing';
import { RunContext } from './lib/run-context';
import { stripTags } from './lib/text';
import { parseVoiceSamples, planVoices, readTimings, type PlannedVoice } from './lib/voice-samples';
import {
  assembleSamples, cacheEntry, computeTargets, dirs, recordSample, ttsBody, ttsParams, type CachedSample,
} from './lib/voice-samples-run';

const HELP = `Проби голосів v4 з вирівнюванням до нашого голосу.
Прапорці:
  --story <id>          історія (обов'язково)
  --run                 справді викликати API (без нього сухий прогін, нічого не витрачається)
  --limit-credits N     загальний ліміт кредитів на історію (обов'язковий з --run)
  --assemble-only       нічого не викликати: вирівняти проби, що вже є, і зібрати summary.json та index.html (безкоштовно)
  --only <slug|id>      озвучити лише цей голос (можна повторювати); сторінка збирається з усіх наявних проб
  --stability <0..1>    налаштування голосу (за замовчуванням не передається; входить у хеш проби)
  --target-f0 <Гц>      висота, до якої вирівнювати (за замовчуванням медіана F0 в narration.mp3)
  --target-pace <зн/с>  темп, до якого вирівнювати (за замовчуванням з timings.json)`;

async function main(): Promise<void> {
  const { values } = parseCli({
    'assemble-only': { type: 'boolean' }, only: { type: 'string', multiple: true }, stability: { type: 'string' },
    'target-f0': { type: 'string' }, 'target-pace': { type: 'string' },
  });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;
  const num = (name: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} має бути додатним числом.`);
    return n;
  };
  const stability = values.stability === undefined ? undefined : Number(values.stability);
  if (stability !== undefined && !(stability >= 0 && stability <= 1)) throw new UsageError('--stability має бути від 0 до 1.');
  if (values['assemble-only'] && flags.run) throw new UsageError('--assemble-only і --run разом не можна.');
  for (const b of ['ffmpeg', 'ffprobe']) if (!hasBinary(b)) throw new Error(`Потрібен ${b} (його немає в PATH).`);

  const doc = parseVoiceSamples(story);
  const timings = readTimings(story);
  const params = ttsParams({ stability });
  const voices = planVoices(doc.voices, timings.voice_id, `наш голос (${story})`);
  const only = values.only?.length ? new Set(values.only) : undefined;
  if (only) {
    const unknown = [...only].filter((o) => !voices.some((v) => v.slug === o || v.voiceId === o));
    if (unknown.length) throw new UsageError(`--only: немає такого голосу: ${unknown.join(', ')} (є: ${voices.map((v) => v.slug).join(', ')}).`);
  }
  const selected = voices.filter((v) => !only || only.has(v.slug) || only.has(v.voiceId));
  const todo = selected.filter((v) => !cacheEntry(story, v, doc.text, params).item);

  const client = new ElevenLabsClient();
  const rate = await ttsRate(client, params.model_id, story);
  const chars = doc.text.length;
  if (chars > rate.maxChars) throw new Error(`Текст проби (${chars} знаків із тегами) довший за ліміт моделі ${params.model_id} (${rate.maxChars}).`);
  const cost = estimateTts(chars * todo.length, rate);
  const plain = stripTags(doc.text);

  log(`Проби голосів ${params.model_id}, мова ${params.language_code}. Текст: ${chars} знаків із тегами, ${plain.length} без тегів.`);
  voices.forEach((v, i) => {
    const hit = cacheEntry(story, v, doc.text, params).item;
    const mark = !selected.includes(v) ? 'поза --only' : hit ? 'ВЖЕ Є (платити не треба)' : 'треба озвучити (платно)';
    log(`  ${String(i + 1).padStart(2)}. ${v.slug} · ${v.voiceId} · ${v.name}${v.note ? ` (${v.note})` : ''}${v.current ? ' [наш нинішній]' : ''}: ${mark}`);
  });
  log(`Очікувана вартість: ${todo.length} з ${voices.length} голосів × ${chars} знаків: ${fmt(cost)} (${cost.note}).`);

  const overrides = { f0: num('target-f0', values['target-f0']), pace: num('target-pace', values['target-pace']) };
  const targets = await computeTargets(story, overrides);
  log(`Цілі вирівнювання: висота ${targets.f0Hz.toFixed(0)} Гц, темп ${targets.paceCps.toFixed(1)} зн/с (${targets.paceChars} знаків / ${targets.paceSeconds.toFixed(1)} с).`);

  if (!flags.run && !values['assemble-only']) {
    if (client.hasKey) await checkVoicesFree(client, voices);
    log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');
    return;
  }

  const failures = new Map<string, string>();
  if (flags.run) {
    const ctx = new RunContext(client, story, 'voice-samples', true, flags.limit);
    await ctx.start();
    try {
      const { raw } = dirs(story);
      mkdirSync(raw, { recursive: true });
      for (const [i, v] of todo.entries()) {
        const est = estimateTts(chars, rate).credits ?? 0;
        ctx.assertBudget(est, `проба «${v.name}»`);
        log(`Проба ${i + 1} з ${todo.length}: ${v.slug} (${v.name}), ${chars} знаків, ~${est} кредитів…`);
        try {
          await generate(client, ctx, story, v, doc.text, params, raw);
        } catch (e) {
          // 4xx (голос недоступний на акаунті тощо): кредитів не списано, решту голосів озвучуємо далі.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            failures.set(v.voiceId, `помилка ${e.status}`);
            log(`  ПРОПУЩЕНО ${v.slug}: ${e.message}`);
            continue;
          }
          throw e;
        }
      }
      log('\nВирівнюємо проби і збираємо сторінку (безкоштовно, локально)…');
      report(assembleSamples({ story, doc, voices, params, targets, failures }));
    } finally {
      await ctx.finish();
    }
  } else {
    log('\nВирівнюємо проби, що вже є, і збираємо сторінку (безкоштовно, локально)…');
    report(assembleSamples({ story, doc, voices, params, targets }));
  }
}

/** Безкоштовна перевірка в сухому прогоні: чи бачить акаунт голос (GET /v1/voices/{id}). */
async function checkVoicesFree(client: ElevenLabsClient, voices: PlannedVoice[]): Promise<void> {
  log('\nПеревірка голосів на акаунті (безкоштовний виклик voices get):');
  for (const v of voices) {
    try {
      const info = await client.getVoice(v.voiceId);
      log(`  ${v.slug}: є на акаунті («${info.name}»)`);
    } catch (e) {
      log(`  ${v.slug}: УВАГА, не вдалося прочитати голос (${e instanceof ApiError ? `код ${e.status}` : e instanceof Error ? e.message : String(e)}); озвучення може не вдатися`);
    }
  }
}

async function generate(client: ElevenLabsClient, ctx: RunContext, story: string, v: PlannedVoice, text: string, params: ReturnType<typeof ttsParams>, rawDir: string): Promise<void> {
  const { hash } = cacheEntry(story, v, text, params);
  const rawFile = join(rawDir, `${v.slug}.mp3`);
  const respFile = join(rawDir, `${v.slug}.response.json`);
  const sp = await client.beginSpend();
  const sinceUnix = Math.floor(Date.now() / 1000) - 2;
  const response = await client.textToSpeechWithTimestamps(v.voiceId, ttsBody(text, params), { output_format: params.output_format }, sp.guard);
  // Спершу зберігаємо звук і відповідь: якщо далі щось упаде, платити вдруге не доведеться.
  writeFileSync(rawFile, Buffer.from(response.audio_base64, 'base64'));
  writeFileSync(respFile, JSON.stringify({ alignment: response.alignment, normalized_alignment: response.normalized_alignment }));
  let spent: number;
  let source: 'history' | 'counter';
  const h = await client.findTtsCost({ voiceId: v.voiceId, text, sinceUnix });
  if (h) {
    spent = h.credits;
    source = 'history';
    client.lastStableCredits = undefined; // наступний виклик заново стабілізує базу
  } else {
    log('  УВАГА: запису в історії не знайдено, беремо різницю стабілізованого лічильника.');
    spent = (await sp.finish({ expectRise: true })).spent;
    source = 'counter';
  }
  ctx.recordSpent(spent);
  const item: CachedSample = {
    hash, slug: v.slug, voice_id: v.voiceId, name: v.name, raw_file: paths.rel(rawFile), response_file: paths.rel(respFile),
    chars_sent: text.length, credits: spent, credits_source: source, generated_at: new Date().toISOString(),
  };
  recordSample(story, item, params);
  log(`  збережено ${paths.rel(rawFile)} (витрачено ${spent} кредитів).`);
}

function report(r: ReturnType<typeof assembleSamples>): void {
  log(`\nГотово: проб ${r.voices.length}${r.skipped.length ? `, без проби ${r.skipped.length} (${r.skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})` : ''}.`);
  log(`Сторінка: ${paths.rel(r.indexFile)} (разом з файлами ${(r.pageBytes / 1048576).toFixed(1)} МБ з 16)${r.rawRecompressed ? ', сирі на сторінці стиснено до 64 кбіт/с' : ''}.`);
  log(`Підсумок: ${paths.rel(r.summaryFile)}.`);
}

runMain(main);
