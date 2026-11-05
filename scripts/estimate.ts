// Кошторис кроків 5–10: скільки одиниць і скільки кредитів. Нічого не витрачає.
// Біля кожного числа позначка: [з API], [з документації ElevenLabs], [оцінка], [не знайдено].
//
//   npx tsx scripts/estimate.ts --story 01-natalia [--image-credits N]

import { parseArgs } from 'node:util';
import { parseCharacter, parseScript, parseSound, parseStoryboard, parseVoiceMd, parseVoices, findVoice } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log } from './lib/log';
import { runMain, UsageError } from './lib/cli';
import { assertStoryExists } from './lib/paths';
import { estimateImage, estimateMusic, estimateSfx, estimateTts, estimateVoiceDesign, fmt, ttsRate, type Priced } from './lib/pricing';
import { buildSpeechText } from './lib/timings';

interface Row {
  step: string;
  what: string;
  units: string;
  price: Priced;
  /** Верхня межа з перегенераціями (для картинок). */
  max?: Priced;
}

async function main(): Promise<void> {
  let values: { story?: string; 'image-credits'?: string; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, 'image-credits': { type: 'string' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log('Кошторис: --story <id> [--image-credits N]');
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  const story = values.story;
  assertStoryExists(story);
  const imageFlag = values['image-credits'] !== undefined ? Number(values['image-credits']) : undefined;
  const client = new ElevenLabsClient();
  const rows: Row[] = [];
  const notes: string[] = [];
  const attempt = (step: string, fn: () => void | Promise<void>): Promise<void> =>
    Promise.resolve()
      .then(fn)
      .catch((e: Error) => void notes.push(`${step}: не пораховано, ${e.message}`));

  const rate = await ttsRate(client, 'eleven_v4');
  const image = estimateImage(imageFlag);
  const imgTwice = (n: number): Priced => (image.credits === null ? image : { ...image, credits: image.credits * n * 2 });

  await attempt('Крок 5', () => {
    const v = findVoice(parseVoices(), parseVoiceMd(story).voiceId);
    rows.push({ step: '5', what: 'Проби голосу (Voice Design, 3 проби одним викликом)', units: `${v.probeText.length} знаків проби`, price: estimateVoiceDesign(v.probeText.length) });
  });
  await attempt('Крок 6', () => {
    const vm = parseVoiceMd(story);
    const groups = vm.fragments.length < 2 ? [vm.fragments] : [[vm.fragments[0]!], vm.fragments.slice(1)];
    const chars = groups.reduce((n, g) => n + buildSpeechText(g, '\n\n').text.length, 0);
    rows.push({ step: '6', what: `Озвучення eleven_v4 (${groups.length} виклики: перший фрагмент окремо, решта разом; без першого фрагмента дешевше)`, units: `${chars} знаків із тегами, ${vm.fragments.length} фрагментів`, price: estimateTts(chars, rate) });
  });
  let sheets = 0;
  await attempt('Крок 7', () => {
    const sb = parseStoryboard(story);
    const ids = [...new Set(sb.frames.flatMap((f) => f.heroes.map((h) => h.id)))];
    sheets = ids.reduce((n, id) => n + parseCharacter(id).sheets.length, 0);
    rows.push({ step: '7', what: `Аркуші героїв (${ids.length} героїв: ${ids.join(', ')})`, units: `${sheets} картинок`, price: { ...image, credits: image.credits === null ? null : image.credits * sheets }, max: imgTwice(sheets) });
  });
  let frames = 0;
  await attempt('Крок 8', () => {
    frames = parseStoryboard(story).frames.length;
    rows.push({ step: '8', what: 'Кадри розкадровки', units: `${frames} картинок`, price: { ...image, credits: image.credits === null ? null : image.credits * frames }, max: imgTwice(frames) });
  });
  await attempt('Крок 10', () => {
    const s = parseSound(story);
    rows.push({ step: '10', what: 'Музика', units: `${s.music.seconds} с`, price: estimateMusic(s.music.seconds) });
    const secs = s.sfx.reduce((n, x) => n + x.seconds, 0);
    const sfxCredits = s.sfx.reduce((n, x) => n + (estimateSfx(x.seconds).credits ?? 0), 0);
    rows.push({ step: '10', what: `Шуми (${s.sfx.length} шт.)`, units: `${secs} с`, price: { credits: sfxCredits, source: 'з документації ElevenLabs', note: '40 кредитів/с' } });
  });

  log(`Кошторис для ${story}\n`);
  for (const r of rows) {
    log(`Крок ${r.step.padEnd(2)} ${r.what}`);
    log(`         одиниць: ${r.units} [з документів]`);
    log(`         кредитів: ${fmt(r.price)}${r.price.note ? `  (${r.price.note})` : ''}`);
    if (r.max) log(`         верхня межа з однією перегенерацією кожної картинки: ${fmt(r.max)}`);
  }
  for (const n of notes) log(`\nУВАГА: ${n}`);

  const known = rows.reduce((n, r) => n + (r.price.credits ?? 0), 0);
  const knownMax = rows.reduce((n, r) => n + ((r.max ?? r.price).credits ?? 0), 0);
  log(`\nРазом (без картинок, якщо їхню ціну не задано): ~${known} кредитів.`);
  if (image.credits === null) {
    log(`Картинок: ${sheets + frames} (${sheets} аркушів + ${frames} кадрів), до ${2 * (sheets + frames)} з перегенераціями. Ціну картинки gemini-3.1-flash-image у документації ElevenLabs не знайдено,`);
    log('тому підсумок із картинками не порахувано. Задайте --image-credits N (подивіться ціну в інтерфейсі Image & Video) або згенеруйте одну картинку і візьміть фактичну з маніфесту.');
  } else {
    log(`Разом з картинками: ~${known} [оцінка], верхня межа з перегенераціями: ~${knownMax} [оцінка].`);
    log(`Пропонований ліміт: ~${Math.ceil(knownMax * 1.1)} (верхня межа + 10% запасу) [оцінка].`);
  }
  if (client.hasKey) {
    const sub = await client.getSubscription();
    log(`\nБаланс [з API]: витрачено ${sub.character_count} із ${sub.character_limit}, лишилось ${sub.character_limit - sub.character_count}.`);
  }
}

runMain(main);
