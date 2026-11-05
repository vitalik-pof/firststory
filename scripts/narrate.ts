// Крок 6: озвучення з stories/<id>/voice.md моделлю eleven_v4 через
// text-to-speech convert_with_timestamps → work/<id>/narration.mp3 і stories/<id>/timings.json.
//
//   npx tsx scripts/narrate.ts --story 01-natalia                                  сухий прогін
//   npx tsx scripts/narrate.ts --story 01-natalia --run --limit-credits 5000
//
// Рішення: увесь текст ОДНИМ викликом, фрагменти розділені порожнім рядком; межі фрагментів
// беремо з таймінгів символів. Деталі й наслідки для інтонації: scripts/README.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { checkVoiceAgainstScript, findVoice, parseScript, parseVoiceMd, parseVoices } from './lib/docs';
import { ElevenLabsClient, type TtsWithTimestamps } from './lib/elevenlabs';
import { probeDuration } from './lib/audio';
import { log } from './lib/log';
import { readManifest, updateManifest } from './lib/manifest';
import { assertStoryExists, paths } from './lib/paths';
import { estimateTts, fmt, ttsRate } from './lib/pricing';
import { RunContext } from './lib/run-context';
import { sha1 } from './lib/text';
import { buildFragmentTimings, buildSpeechText, checkTimings, type TimingsFile } from './lib/timings';

const MODEL_ID = 'eleven_v4';
const HELP = `Крок 6: озвучення з таймінгами.
Прапорці:
  --story <id>              історія (обов'язково)
  --run / --limit-credits N справжній запуск і загальний ліміт кредитів (без --run сухий прогін)
  --joiner "<рядок>"        чим розділяти фрагменти (за замовчуванням порожній рядок, \\n\\n)
  --language-code <uk>      мова (за замовчуванням з «Мова озвучення» у script.md: українська → uk)
  --no-language-code        не передавати language_code
  --stability/--similarity/--style/--speed <число>   налаштування голосу (за замовчуванням не передаються)
  --seed <ціле>             seed для відтворюваності
  --output-format <fmt>     mp3_44100_128 (за замовчуванням)
  --skip-script-check       не звіряти voice.md зі script.md (слова мають збігатися; відключати лише свідомо)
  --force                   озвучити заново, хоча текст або голос змінилися (знову платно)
  --rebuild-timings         лише перебудувати timings.json зі збереженої відповіді (безкоштовно)`;

const LANG: Record<string, string> = { українська: 'uk', англійська: 'en', польська: 'pl', німецька: 'de', російська: 'ru' };

async function main(): Promise<void> {
  const { values } = parseCli({
    joiner: { type: 'string' }, 'language-code': { type: 'string' }, 'no-language-code': { type: 'boolean' },
    stability: { type: 'string' }, similarity: { type: 'string' }, style: { type: 'string' }, speed: { type: 'string' }, seed: { type: 'string' },
    'output-format': { type: 'string' }, 'skip-script-check': { type: 'boolean' }, force: { type: 'boolean' }, 'rebuild-timings': { type: 'boolean' },
  });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: true });
  assertStoryExists(flags.story);
  const story = flags.story;

  const script = parseScript(story);
  const voiceDoc = parseVoiceMd(story);
  if (!values['skip-script-check']) checkVoiceAgainstScript(story, voiceDoc, script);
  const voices = parseVoices();
  const voice = findVoice(voices, voiceDoc.voiceId);
  if (!voice.voiceId) {
    if (flags.run) throw new Error(`У voices.md голос «${voice.id}» без voice_id. Спершу крок 5: scripts/voice-previews.ts.`);
    log(`УВАГА: у voices.md голос «${voice.id}» ще без voice_id (крок 5). Для сухого прогону беремо заглушку.`);
    voice.voiceId = '<voice_id>';
  }
  const joiner = values.joiner !== undefined ? values.joiner.replace(/\\n/g, '\n') : '\n\n';
  const { text, spans } = buildSpeechText(voiceDoc.fragments, joiner);
  const langCode = values['no-language-code'] ? undefined : values['language-code'] ?? LANG[script.language.toLowerCase()];

  const client = new ElevenLabsClient();
  const rate = await ttsRate(client, MODEL_ID);
  if (text.length > rate.maxChars) {
    throw new Error(`Текст (${text.length} знаків із тегами) довший за ліміт моделі ${MODEL_ID} (${rate.maxChars}). Потрібне озвучення частинами: поки не реалізовано.`);
  }
  const cost = estimateTts(text.length, rate);
  const outputFormat = values['output-format'] ?? 'mp3_44100_128';
  const voiceSettings: Record<string, number> = {};
  if (values.stability !== undefined) voiceSettings.stability = Number(values.stability);
  if (values.similarity !== undefined) voiceSettings.similarity_boost = Number(values.similarity);
  if (values.style !== undefined) voiceSettings.style = Number(values.style);
  if (values.speed !== undefined) voiceSettings.speed = Number(values.speed);
  const body: Record<string, unknown> = { text, model_id: MODEL_ID };
  if (langCode) body.language_code = langCode;
  if (Object.keys(voiceSettings).length) body.voice_settings = voiceSettings;
  if (values.seed !== undefined) body.seed = Number(values.seed);

  const reqHash = sha1(JSON.stringify({ body, voice: voice.voiceId, outputFormat }));
  const mp3 = paths.workFile(story, 'narration.mp3');
  const rawFile = paths.workFile(story, 'narration.response.json');
  const manifest = readManifest(story);
  const prev = manifest.narration as { request_hash?: string } | undefined;
  const haveAudio = existsSync(mp3) && existsSync(rawFile) && Boolean(prev);

  log(`Голос «${voice.id}» (${voice.voiceId}), модель ${MODEL_ID}, мова ${langCode ?? 'авто'}, фрагментів ${spans.length}.`);
  log(`Текст: ${text.length} знаків (із тегами). Очікувана вартість: ${fmt(cost)} (${cost.note}). Теги, імовірно, теж рахуються як знаки.`);
  log(`Перші 300 знаків запиту:\n---\n${text.slice(0, 300)}\n---`);
  const needGenerate = !haveAudio || (prev?.request_hash !== reqHash && Boolean(values.force));
  if (haveAudio && prev?.request_hash !== reqHash && !values.force) {
    log('УВАГА: озвучення вже є, але текст/голос/налаштування змінилися. Без --force лишаємо наявне (щоб не платити вдруге); timings.json перебудуємо з нього.');
  }
  log(`Дія: ${needGenerate ? 'озвучити (платно)' : 'озвучення вже є, платного виклику не буде'}.`);

  const rebuild = (response: TtsWithTimestamps): void => {
    const al = response.alignment;
    if (!al) throw new Error('У відповіді немає alignment (таймінгів символів).');
    const fragments = buildFragmentTimings(text, spans, al, voiceDoc.fragments);
    const lastEnd = al.character_end_times_seconds[al.character_end_times_seconds.length - 1] ?? 0;
    const duration = probeDuration(mp3) ?? lastEnd;
    for (const p of checkTimings(fragments, duration)) log(`УВАГА (таймінги): ${p}`);
    const timings: TimingsFile = {
      version: 1, story, model_id: MODEL_ID, voice_id: voice.voiceId, audio_file: paths.rel(mp3),
      duration: Math.round(duration * 1000) / 1000, fragment_joiner: joiner, fragments,
    };
    writeFileSync(paths.timings(story), JSON.stringify(timings, null, 2) + '\n');
    log(`timings.json записано: ${fragments.length} фрагментів, ${fragments.reduce((n, f) => n + f.words.length, 0)} слів, ${timings.duration} с.`);
  };

  if (!flags.run) {
    if (haveAudio && !needGenerate) {
      log('\nСУХИЙ ПРОГІН. Збережену відповідь знайдено: перебудовую timings.json (безкоштовно).');
      rebuild(JSON.parse(readFileSync(rawFile, 'utf8')) as TtsWithTimestamps);
    } else log('\nСУХИЙ ПРОГІН: нічого не викликано. Додайте --run --limit-credits N.');
    return;
  }
  if (values['rebuild-timings'] && !haveAudio) throw new Error('--rebuild-timings: збереженої відповіді немає.');

  const ctx = new RunContext(client, story, 'narrate', true, flags.limit);
  await ctx.start();
  try {
    if (needGenerate && !values['rebuild-timings']) {
      ctx.assertBudget(cost.credits ?? 0, 'озвучення');
      const sp = await client.beginSpend();
      const response = await client.textToSpeechWithTimestamps(voice.voiceId, body, { output_format: outputFormat }, sp.guard);
      // Спершу зберігаємо сиру відповідь і звук: якщо розбір таймінгів упаде, платити вдруге не доведеться.
      mkdirSync(paths.workDir(story), { recursive: true });
      writeFileSync(rawFile, JSON.stringify(response));
      writeFileSync(mp3, Buffer.from(response.audio_base64, 'base64'));
      const { spent } = await sp.finish();
      ctx.recordSpent(spent);
      updateManifest(story, (m) => {
        m.narration = {
          file: paths.rel(mp3), response_file: paths.rel(rawFile), model_id: MODEL_ID, voice_id: voice.voiceId, chars_sent: text.length,
          language_code: langCode ?? null, output_format: outputFormat, request_hash: reqHash, credits: spent, generated_at: new Date().toISOString(),
        };
      });
      log(`Озвучення збережено: ${paths.rel(mp3)} (витрачено ${spent} кредитів).`);
    }
    rebuild(JSON.parse(readFileSync(rawFile, 'utf8')) as TtsWithTimestamps);
  } finally {
    await ctx.finish();
  }
}

runMain(main);
