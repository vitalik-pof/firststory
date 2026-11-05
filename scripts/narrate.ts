// Крок 6: озвучення з stories/<id>/voice.md моделлю eleven_v4 через
// text-to-speech convert_with_timestamps → work/<id>/narration.mp3 і stories/<id>/timings.json.
//
//   npx tsx scripts/narrate.ts --story 01-natalia                                  сухий прогін
//   npx tsx scripts/narrate.ts --story 01-natalia --run --limit-credits 5000       два виклики (за замовчуванням)
//   npx tsx scripts/narrate.ts --story 01-natalia --run --limit-credits 5000 --without-first
//   npx tsx scripts/narrate.ts --story 01-natalia --assemble-only                   лише склейка й таймінги з уже наявних частин (безкоштовно)
//
// Рішення (деталі й наслідки для інтонації: scripts/README.md):
//  - частини озвучення — окремі виклики API; кожна частина зберігається під хешем запиту, тож
//    уже озвучене ніколи не платиться вдруге, навіть якщо режим змінився;
//  - за замовчуванням дві частини: перший фрагмент окремо, решта одним викликом (порожній рядок між
//    фрагментами); межі фрагментів беруться з таймінгів символів;
//  - --without-first: перший фрагмент сценарію без голосу (титр), одна частина з решти;
//  - --single-call: усе одним викликом.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { checkVoiceAgainstScript, findVoice, parseScript, parseVoiceMd, parseVoices, type VoiceFragment } from './lib/docs';
import { probeDuration, concatMp3, hasBinary } from './lib/audio';
import { ElevenLabsClient, type TtsWithTimestamps } from './lib/elevenlabs';
import { log } from './lib/log';
import { readManifest, updateManifest } from './lib/manifest';
import { assertStoryExists, paths } from './lib/paths';
import { estimateTts, fmt, ttsRate } from './lib/pricing';
import { RunContext } from './lib/run-context';
import { sha1 } from './lib/text';
import { buildFragmentTimings, buildSpeechText, checkTimings, shiftFragments, type FragmentTiming, type TimingsFile, type TimingsPart } from './lib/timings';

const MODEL_ID = 'eleven_v4';
const HELP = `Крок 6: озвучення з таймінгами.
Режими (взаємовиключні):
  (за замовчуванням)        два виклики: перший фрагмент окремо, решта одним
  --without-first           перший фрагмент без голосу (титр): озвучити лише решту одним викликом
  --single-call             усе одним викликом
Прапорці:
  --story <id>              історія (обов'язково)
  --run / --limit-credits N справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --assemble-only           нічого не викликати: зібрати narration.mp3 і timings.json з частин, що вже є (безкоштовно)
  --gap <секунди>           пауза між частинами при склейці (1.5 за замовчуванням)
  --joiner "<рядок>"        чим розділяти фрагменти в одному виклику (порожній рядок, \\n\\n)
  --language-code <uk>      мова (за замовчуванням з «Мова озвучення» у script.md: українська → uk)
  --no-language-code        не передавати language_code
  --stability/--similarity/--style/--speed <число>   налаштування голосу (за замовчуванням не передаються)
  --seed <ціле>             seed для відтворюваності
  --output-format <fmt>     mp3_44100_128 (за замовчуванням)
  --skip-script-check       не звіряти voice.md зі script.md (слова мають збігатися; відключати лише свідомо)
  --force                   озвучити заново частини, які вже є (знову платно)`;

const LANG: Record<string, string> = { українська: 'uk', англійська: 'en', польська: 'pl', німецька: 'de', російська: 'ru' };

interface PartPlan {
  index: number;
  fragments: VoiceFragment[];
  text: string;
  spans: ReturnType<typeof buildSpeechText>['spans'];
  body: Record<string, unknown>;
  hash: string;
  mp3: string;
  raw: string;
  chars: number;
}

interface CachedPart {
  hash: string;
  mp3: string;
  response_file: string;
  chars_sent: number;
  credits: number | null;
  fragments: number[];
  credits_source?: string;
  generated_at: string;
}

async function main(): Promise<void> {
  const { values } = parseCli({
    joiner: { type: 'string' }, 'language-code': { type: 'string' }, 'no-language-code': { type: 'boolean' },
    stability: { type: 'string' }, similarity: { type: 'string' }, style: { type: 'string' }, speed: { type: 'string' }, seed: { type: 'string' },
    'output-format': { type: 'string' }, 'skip-script-check': { type: 'boolean' }, force: { type: 'boolean' },
    'without-first': { type: 'boolean' }, 'single-call': { type: 'boolean' }, 'assemble-only': { type: 'boolean' }, gap: { type: 'string' },
  });
  if (values.help) return void log(HELP);
  if (values['without-first'] && values['single-call']) throw new Error('--without-first і --single-call разом не потрібні: без першого фрагмента виклик і так один.');
  const assembleOnly = Boolean(values['assemble-only']);
  const flags = commonFlags(assembleOnly ? { ...values, run: false } : values, { paid: true });
  const run = flags.run && !assembleOnly;
  assertStoryExists(flags.story);
  const story = flags.story;
  const gap = Number(values.gap ?? 1.5);
  if (!Number.isFinite(gap) || gap < 0) throw new Error('--gap має бути невід’ємним числом секунд.');

  const script = parseScript(story);
  const voiceDoc = parseVoiceMd(story);
  const withoutFirst = Boolean(values['without-first']);
  const firstN = script.fragments[0]!.n;
  if (!values['skip-script-check']) checkVoiceAgainstScript(story, voiceDoc, script, withoutFirst ? [firstN] : []);
  const voices = parseVoices();
  const voice = findVoice(voices, voiceDoc.voiceId);
  if (!voice.voiceId) {
    if (run) throw new Error(`У voices.md голос «${voice.id}» без voice_id. Спершу крок 5: scripts/voice-previews.ts.`);
    log(`УВАГА: у voices.md голос «${voice.id}» ще без voice_id (крок 5). Для сухого прогону беремо заглушку.`);
    voice.voiceId = '<voice_id>';
  }
  const joiner = values.joiner !== undefined ? values.joiner.replace(/\\n/g, '\n') : '\n\n';
  const langCode = values['no-language-code'] ? undefined : values['language-code'] ?? LANG[script.language.toLowerCase()];
  const outputFormat = values['output-format'] ?? 'mp3_44100_128';
  const voiceSettings: Record<string, number> = {};
  if (values.stability !== undefined) voiceSettings.stability = Number(values.stability);
  if (values.similarity !== undefined) voiceSettings.similarity_boost = Number(values.similarity);
  if (values.style !== undefined) voiceSettings.style = Number(values.style);
  if (values.speed !== undefined) voiceSettings.speed = Number(values.speed);

  // Які фрагменти озвучуємо і як ділимо на виклики.
  const voiced = voiceDoc.fragments.filter((f) => !(withoutFirst && f.n === firstN));
  const silent = withoutFirst ? [firstN] : [];
  if (!voiced.length) throw new Error('Немає жодного фрагмента для озвучення.');
  const groups: VoiceFragment[][] = values['single-call'] || withoutFirst || voiced.length < 2 ? [voiced] : [[voiced[0]!], voiced.slice(1)];

  const plans: PartPlan[] = groups.map((fr, index) => {
    const { text, spans } = buildSpeechText(fr, joiner);
    const body: Record<string, unknown> = { text, model_id: MODEL_ID };
    if (langCode) body.language_code = langCode;
    if (Object.keys(voiceSettings).length) body.voice_settings = voiceSettings;
    if (values.seed !== undefined) body.seed = Number(values.seed);
    const hash = sha1(JSON.stringify({ body, voice: voice.voiceId, outputFormat })).slice(0, 10);
    return {
      index, fragments: fr, text, spans, body, hash, chars: text.length,
      mp3: paths.workFile(story, `narration.part-${hash}.mp3`), raw: paths.workFile(story, `narration.part-${hash}.response.json`),
    };
  });

  const client = new ElevenLabsClient();
  const rate = await ttsRate(client, MODEL_ID, story);
  for (const p of plans) {
    if (p.chars > rate.maxChars) throw new Error(`Частина ${p.index + 1} (${p.chars} знаків із тегами) довша за ліміт моделі ${MODEL_ID} (${rate.maxChars}).`);
  }
  const manifest = readManifest(story);
  const cache = (manifest.narration?.parts ?? {}) as Record<string, CachedPart>;
  const cached = (p: PartPlan): boolean => Boolean(cache[p.hash]) && existsSync(p.mp3) && existsSync(p.raw);
  const todo = plans.filter((p) => !cached(p) || values.force);
  const cost = estimateTts(todo.reduce((n, p) => n + p.chars, 0), rate);

  log(`Голос «${voice.id}» (${voice.voiceId}), модель ${MODEL_ID}, мова ${langCode ?? 'авто'}.`);
  log(`Режим: ${withoutFirst ? `без фрагмента ${firstN} (титр без голосу), один виклик` : plans.length === 1 ? 'один виклик' : 'два виклики: перший фрагмент окремо, решта разом'}.`);
  plans.forEach((p) =>
    log(`  Частина ${p.index + 1}: фрагменти ${p.fragments.map((f) => f.n).join(', ')}; ${p.chars} знаків із тегами; ${cached(p) && !values.force ? 'ВЖЕ Є (платити не треба)' : 'треба озвучити (платно)'}; хеш ${p.hash}`),
  );
  log(`Очікувана вартість (лише частини, яких ще немає): ${fmt(cost)} (${cost.note}). Теги, імовірно, теж рахуються як знаки.`);
  log(`Початок першої частини:\n---\n${plans[0]!.text.slice(0, 260)}\n---`);

  if (assembleOnly) {
    const missing = plans.filter((p) => !cached(p));
    if (missing.length) throw new Error(`--assemble-only: немає частин ${missing.map((p) => p.index + 1).join(', ')}: їх треба озвучити (--run).`);
    assemble(story, plans, silent, voice.voiceId, joiner, gap, script.fragments.map((f) => f.n));
    return;
  }
  if (!run) {
    log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');
    return;
  }

  const ctx = new RunContext(client, story, 'narrate', true, flags.limit);
  await ctx.start();
  try {
    for (const p of plans) {
      if (cached(p) && !values.force) continue;
      const cp = fmt(estimateTts(p.chars, rate));
      ctx.assertBudget(estimateTts(p.chars, rate).credits ?? 0, `озвучення, частина ${p.index + 1}`);
      log(`Озвучуємо частину ${p.index + 1} (${p.chars} знаків, ${cp})…`);
      const sp = await client.beginSpend();
      const sinceUnix = Math.floor(Date.now() / 1000) - 2;
      const response = await client.textToSpeechWithTimestamps(voice.voiceId, p.body, { output_format: outputFormat }, sp.guard);
      // Спершу зберігаємо сиру відповідь і звук: якщо розбір таймінгів упаде, платити вдруге не доведеться.
      mkdirSync(paths.workDir(story), { recursive: true });
      writeFileSync(p.raw, JSON.stringify(response));
      writeFileSync(p.mp3, Buffer.from(response.audio_base64, 'base64'));
      // Вартість озвучення беремо з історії (character_count_change_to мінус from): лічильник підписки відстає.
      let spent: number;
      let source: 'history' | 'counter';
      const h = await client.findTtsCost({ voiceId: voice.voiceId, text: p.text, sinceUnix });
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
      updateManifest(story, (m) => {
        const prev = (m.narration ?? {}) as Record<string, unknown>;
        const parts = { ...((prev.parts as Record<string, CachedPart>) ?? {}) };
        parts[p.hash] = {
          hash: p.hash, mp3: paths.rel(p.mp3), response_file: paths.rel(p.raw), chars_sent: p.chars, credits: spent, credits_source: source,
          fragments: p.fragments.map((f) => f.n), generated_at: new Date().toISOString(),
        };
        m.narration = { ...prev, model_id: MODEL_ID, voice_id: voice.voiceId, language_code: langCode ?? null, output_format: outputFormat, parts };
      });
      log(`  частину ${p.index + 1} збережено: ${paths.rel(p.mp3)} (витрачено ${spent} кредитів).`);
    }
    assemble(story, plans, silent, voice.voiceId, joiner, gap, script.fragments.map((f) => f.n));
  } finally {
    await ctx.finish();
  }
}

/** Склейка частин у narration.mp3 і побудова timings.json (безкоштовно, лише локальні файли). */
function assemble(story: string, plans: PartPlan[], silent: number[], voiceId: string, joiner: string, gap: number, scriptNumbers: number[]): void {
  const mp3 = paths.workFile(story, 'narration.mp3');
  const fragments: FragmentTiming[] = [];
  const parts: TimingsPart[] = [];
  let offset = 0;
  for (const p of plans) {
    const response = JSON.parse(readFileSync(p.raw, 'utf8')) as TtsWithTimestamps;
    if (!response.alignment) throw new Error(`У відповіді частини ${p.index + 1} немає alignment (таймінгів символів).`);
    const al = response.alignment;
    const lastEnd = al.character_end_times_seconds[al.character_end_times_seconds.length - 1] ?? 0;
    const duration = probeDuration(p.mp3) ?? lastEnd;
    const local = buildFragmentTimings(p.text, p.spans, al, p.fragments);
    parts.push({ index: p.index, fragments: p.fragments.map((f) => f.n), offset: Math.round(offset * 1000) / 1000, duration: Math.round(duration * 1000) / 1000 });
    fragments.push(...shiftFragments(local, offset));
    offset += duration + gap;
  }
  const expected = offset - gap;
  if (plans.length === 1) copyFileSync(plans[0]!.mp3, mp3);
  else {
    if (!hasBinary('ffmpeg')) throw new Error('Для склейки частин потрібен ffmpeg (його немає в PATH).');
    concatMp3(plans.map((p) => p.mp3), gap, mp3);
  }
  const duration = probeDuration(mp3) ?? expected;
  if (Math.abs(duration - expected) > 0.25) log(`УВАГА: склеєний файл триває ${duration.toFixed(3)} с, а за частинами очікувалось ${expected.toFixed(3)} с: таймінги пізніх частин можуть зсунутись.`);
  for (const pr of checkTimings(fragments, duration)) log(`УВАГА (таймінги): ${pr}`);
  const absent = scriptNumbers.filter((n) => !fragments.some((f) => f.n === n) && !silent.includes(n));
  if (absent.length) throw new Error(`У таймінгах немає фрагментів сценарію ${absent.join(', ')}, хоча їх не позначено як беззвучні.`);
  const timings: TimingsFile = {
    version: 1, story, model_id: MODEL_ID, voice_id: voiceId, audio_file: paths.rel(mp3), duration: Math.round(duration * 1000) / 1000,
    fragment_joiner: joiner, part_gap: plans.length > 1 ? gap : 0, parts, silent_fragments: silent, fragments,
  };
  writeFileSync(paths.timings(story), JSON.stringify(timings, null, 2) + '\n');
  updateManifest(story, (m) => {
    m.narration = { ...(m.narration ?? {}), file: paths.rel(mp3), active_parts: plans.map((p) => p.hash), silent_fragments: silent, duration: timings.duration, assembled_at: new Date().toISOString() };
  });
  log(`narration.mp3 і timings.json записано: частин ${plans.length}, фрагментів ${fragments.length}, слів ${fragments.reduce((n, f) => n + f.words.length, 0)}, тривалість ${timings.duration} с${silent.length ? `, без голосу: ${silent.join(', ')}` : ''}.`);
}

runMain(main);
