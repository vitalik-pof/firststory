// Етап 1а: зразок зведення. Бере work/<id>/narration.mp3 і timings.json, зразок музики й параметри
// з розділу «Зведення» файлу sound-samples.md, зводить через ffmpeg (декодування/кодування) і
// власну криву гучності: музика на рівні «під голосом» там, де звучать слова, і «в паузах» там,
// де голос мовчить, з лінійною (в дБ) зміною за «Час зміни гучності».
// Кредитів не витрачає і в API не ходить.
//
//   npx tsx scripts/mix-sample.ts --story 01-natalia
//   npx tsx scripts/mix-sample.ts --story 01-natalia --fragments 2-7 --under -20 --pause -8 --fade 0.8
//   npx tsx scripts/mix-sample.ts --story 01-natalia --dry-run

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { parseFragmentRange, parseSoundSamples } from './lib/docs';
import { UsageError, runMain } from './lib/cli';
import { log } from './lib/log';
import { updateManifest } from './lib/manifest';
import { decodeStereo, encodeStereoMp3, mixVoiceAndMusic, CH, SR } from './lib/mix';
import { readDoc } from './lib/md';
import { assertStoryExists, paths } from './lib/paths';
import type { TimingsFile } from './lib/timings';

const HELP = `Етап 1а: зразок зведення (безкоштовно).
Прапорці:
  --story <id>          історія (обов'язково)
  --dry-run             лише показати вікно й параметри
  --music N             номер зразка музики (за замовчуванням із розділу «Зведення»)
  --fragments 1-6       фрагменти для зразка
  --under <дБ>          музика під голосом, дБ відносно голосу
  --pause <дБ>          музика в паузах, дБ відносно голосу
  --fade <с>            час зміни гучності
  --lead <с>            скільки до першого слова (0.8 за замовчуванням)
  --tail <с>            скільки після останнього слова (2 за замовчуванням: чути рівень «в паузах»)
  --pause-min <с>       пауза між словами, довша за яку вважається паузою (0.5 за замовчуванням)
  --out <файл>          інший файл виводу (за замовчуванням work/<id>/audio/mix-sample.mp3)`;

async function main(): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      options: {
        story: { type: 'string' }, 'dry-run': { type: 'boolean' }, music: { type: 'string' }, fragments: { type: 'string' }, under: { type: 'string' },
        pause: { type: 'string' }, fade: { type: 'string' }, lead: { type: 'string' }, tail: { type: 'string' }, 'pause-min': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
      },
      strict: true,
    }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log(HELP);
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  const story = values.story as string;
  assertStoryExists(story);
  const num = (k: string, def: number): number => {
    const v = values[k] === undefined ? def : Number(String(values[k]).replace(/[−–]/g, '-').replace(',', '.'));
    if (!Number.isFinite(v)) throw new UsageError(`--${k} має бути числом.`);
    return v;
  };

  const ss = parseSoundSamples(story);
  const musicN = values.music !== undefined ? Number(values.music) : ss.mix.musicSample;
  if (!ss.music.some((m) => m.n === musicN)) throw new Error(`Зразка музики ${musicN} немає (є: ${ss.music.map((m) => m.n).join(', ')}).`);
  const doc = readDoc(paths.soundSamplesDoc(story), 'composer');
  const fragNumbers = values.fragments ? parseFragmentRange(doc, String(values.fragments), 0) : ss.mix.fragments;
  const underDb = num('under', ss.mix.underDb);
  const pauseDb = num('pause', ss.mix.pauseDb);
  const fade = num('fade', ss.mix.fadeSeconds);
  const lead = num('lead', 0.8);
  const tail = num('tail', 2);
  const pauseMin = num('pause-min', 0.5);

  const timingsFile = paths.timings(story);
  if (!existsSync(timingsFile) && values['dry-run']) {
    log(`Зразок зведення: фрагменти ${fragNumbers.join(', ')}, музика зразок ${musicN}; під голосом ${underDb} дБ, в паузах ${pauseDb} дБ, зміна гучності ${fade} с.`);
    return void log('СУХИЙ ПРОГІН: документ розібрано. Вікно не пораховано: немає timings.json (narrate.ts); файл не створено.');
  }
  if (!existsSync(timingsFile)) throw new Error('Немає timings.json: спершу озвучення (narrate.ts).');
  const timings = JSON.parse(readFileSync(timingsFile, 'utf8')) as TimingsFile;
  const narration = paths.workFile(story, 'narration.mp3');
  if (!existsSync(narration)) throw new Error(`Немає ${paths.rel(narration)}.`);
  const musicFile = paths.workFile(story, 'audio', 'samples', `music-${musicN}.mp3`);
  if (!existsSync(musicFile)) throw new Error(`Немає ${paths.rel(musicFile)}: спершу sound-samples.ts.`);

  const chosen = fragNumbers.map((n) => {
    const f = timings.fragments.find((x) => x.n === n);
    if (!f) throw new Error(`Фрагмента ${n} немає в timings.json${(timings.silent_fragments ?? []).includes(n) ? ' (він без голосу)' : ''}. Оберіть інші «Фрагменти для зразка».`);
    return f;
  });
  const first = chosen[0]!;
  const last = chosen[chosen.length - 1]!;
  const t0 = Math.max(0, first.start - lead);
  const t1 = Math.min(timings.duration, last.end + tail);
  const out = (values.out as string | undefined) ?? paths.workFile(story, 'audio', 'mix-sample.mp3');
  log(`Зразок зведення: фрагменти ${fragNumbers.join(', ')}, вікно ${t0.toFixed(2)}–${t1.toFixed(2)} с (${(t1 - t0).toFixed(1)} с), музика зразок ${musicN}.`);
  log(`Рівні відносно голосу: під голосом ${underDb} дБ, в паузах ${pauseDb} дБ, зміна гучності ${fade} с, пауза = проміжок між словами > ${pauseMin} с.`);
  if (values['dry-run']) return void log('\nСУХИЙ ПРОГІН: файл не створено.');

  const voiceAll = decodeStereo(narration);
  const voice = voiceAll.slice(Math.floor(t0 * SR) * CH, Math.floor(t1 * SR) * CH);
  const music = decodeStereo(musicFile);
  const words = chosen.flatMap((f) => f.words).map((w) => ({ start: w.start - t0, end: w.end - t0 }));
  const r = mixVoiceAndMusic(voice, music, { underDb, pauseDb, fade, pauseMin, words, musicFadeIn: 0.3, musicFadeOut: 1.0 });
  mkdirSync(dirname(out), { recursive: true });
  encodeStereoMp3(r.pcm, out);
  log(`RMS голосу ${r.voiceRmsDb.toFixed(1)} дБFS, RMS музичного зразка ${r.musicRmsDb.toFixed(1)} дБFS (до вирівнювання); інтервалів мовлення ${r.intervals.length}.`);
  if (r.musicShorterBy > 0.05) log(`УВАГА: музичний зразок коротший за вікно на ${r.musicShorterBy.toFixed(1)} с: наприкінці музики немає (потрібен довший зразок або менше фрагментів).`);
  if (r.peakScale < 1) log(`УВАГА: щоб уникнути кліпінгу, загальну гучність зменшено на ${(-20 * Math.log10(r.peakScale)).toFixed(1)} дБ.`);
  log(`Готово: ${paths.rel(out)}`);
  updateManifest(story, (m) => {
    m.mix_sample = {
      file: paths.rel(out), music_sample: musicN, fragments: fragNumbers, window: [Math.round(t0 * 1000) / 1000, Math.round(t1 * 1000) / 1000],
      under_db: underDb, pause_db: pauseDb, fade_seconds: fade, pause_min: pauseMin, credits: 0, generated_at: new Date().toISOString(),
    };
  });
}

runMain(main);
