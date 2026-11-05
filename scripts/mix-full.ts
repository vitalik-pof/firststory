// Повне зведення фільму: озвучення + музика + шуми за звуковим брифом (stories/<id>/sound.md).
// Кредитів не витрачає і в API не ходить: лише ffmpeg (декодування/кодування) і власна крива гучності
// з lib/mix.ts (та сама, що в зразку зведення, плюс шуми й ділянки-винятки).
//
//   npx tsx scripts/mix-full.ts --story 01-natalia            # work/<id>/mix.mp3 (+ mix.json)
//   npx tsx scripts/mix-full.ts --story 01-natalia --dry-run  # лише розібрати sound.md й показати план
//
// Маніфест не чіпається: нічого, крім файлів у work/<id>/, скрипт не пише.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSound } from './lib/docs';
import { UsageError, runMain } from './lib/cli';
import { log } from './lib/log';
import { CH, SR, baseMusicEnvelope, decodeStereo, encodeStereoMp3, lowpass, mixFilm, speechIntervals, withPatches, type FilmSfx } from './lib/mix';
import { parseFilmMix } from './lib/mix-spec';
import { assertStoryExists, paths } from './lib/paths';
import type { TimingsFile } from './lib/timings';

const HELP = `Повне зведення фільму (безкоштовно).
Прапорці:
  --story <id>   історія (обов'язково)
  --dry-run      лише розібрати sound.md і показати план, файлів не створювати
  --out <файл>   інший файл виводу (за замовчуванням work/<id>/mix.mp3)
  --kbps N       бітрейт MP3 (128 за замовчуванням)`;

const fmt = (x: number): string => (Math.round(x * 100) / 100).toString();

async function main(): Promise<void> {
  let values: { story?: string; 'dry-run'?: boolean; out?: string; kbps?: string; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, 'dry-run': { type: 'boolean' }, out: { type: 'string' }, kbps: { type: 'string' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log(HELP);
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  const story = values.story;
  assertStoryExists(story);
  const kbps = Number(values.kbps ?? 128);
  if (!Number.isFinite(kbps) || kbps < 32) throw new UsageError('--kbps має бути числом не менше 32.');

  const timingsFile = paths.timings(story);
  if (!existsSync(timingsFile)) throw new Error('Немає timings.json: спершу озвучення (narrate.ts).');
  const timings = JSON.parse(readFileSync(timingsFile, 'utf8')) as TimingsFile;
  const words = timings.fragments.flatMap((f) => f.words).map((w) => ({ start: w.start, end: w.end }));
  const lastWordEnd = Math.max(...words.map((w) => w.end));

  const sound = parseSound(story);
  const spec = parseFilmMix(sound.mix, sound.sfx, { filmEnd: timings.duration, lastWordEnd });
  log(`Зведення фільму ${story}: тривалість ${fmt(timings.duration)} с (як озвучення), мовлення до ${fmt(lastWordEnd)} с.`);
  log(`Музика: під голосом ${spec.underDb} дБ, у паузах довших за ${spec.pauseMin} с ${spec.pauseDb} дБ, зміна гучності ${spec.fade} с; ділянок-винятків ${spec.musicPatches.length}, на кінці згасання ${spec.endFade} с.`);
  for (const p of spec.musicPatches) log(`  ділянка музики: ${p.label}`);
  log('Шуми (файл починається на «Де», рівень відносно голосу):');
  for (const s of spec.sfx) {
    log(`  шум ${s.n}${s.frame ? ` (кадр ${s.frame})` : ''}: з ${fmt(s.start)} с, ${s.levelDb} дБ${s.levelFromDoc ? '' : ' (стандартний)'}, вхід ${fmt(s.fadeIn)} с, згасання ${fmt(s.fadeOutLen)} с${s.fadeOutEnd !== undefined ? ` до ${fmt(s.fadeOutEnd)} с` : ' наприкінці файлу'}${s.muffled ? ', приглушено' : ''}${s.patches.map((p) => `; ${p.label}`).join('')}`);
  }
  for (const n of spec.notes) log(`ПРОЧИТАНО: ${n}`);
  for (const w of spec.warnings) log(`УВАГА: ${w}`);

  const narration = paths.workFile(story, 'narration.mp3');
  const musicFile = paths.workFile(story, 'audio', 'music.mp3');
  const sfxFile = (n: number): string => paths.workFile(story, 'audio', `sfx-${String(n).padStart(2, '0')}.mp3`);
  const missing = [narration, musicFile, ...spec.sfx.map((s) => sfxFile(s.n))].filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`Немає файлів: ${missing.map((f) => paths.rel(f)).join(', ')}.`);
  const out = values.out ?? paths.workFile(story, 'mix.mp3');
  if (values['dry-run']) return void log(`\nСУХИЙ ПРОГІН: файл ${paths.rel(out)} не створено.`);

  log('\nДекодую озвучення й музику…');
  const voice = decodeStereo(narration);
  const music = decodeStereo(musicFile);
  const filmSec = voice.length / CH / SR;
  const intervals = speechIntervals(words, spec.pauseMin);
  const musicDb = withPatches(baseMusicEnvelope(intervals, spec.underDb, spec.pauseDb, spec.fade), spec.musicPatches);
  const sfx: FilmSfx[] = spec.sfx.map((s) => {
    log(`Декодую шум ${s.n}…`);
    let pcm = decodeStereo(sfxFile(s.n));
    if (s.muffled) pcm = lowpass(pcm, 3000);
    const fileEnd = s.start + pcm.length / CH / SR;
    const fadeOutEnd = Math.min(s.fadeOutEnd ?? Infinity, fileEnd, filmSec);
    return { label: `шум ${s.n}`, pcm, start: s.start, levelDb: withPatches(() => s.levelDb, s.patches), fadeIn: s.fadeIn, fadeOutLen: s.fadeOutLen, fadeOutEnd };
  });

  log('Зводжу…');
  const r = mixFilm(voice, music, { words, pauseMin: spec.pauseMin, musicDb, endFade: spec.endFade, sfx });
  mkdirSync(dirname(out), { recursive: true });
  log('Кодую MP3…');
  encodeStereoMp3(r.pcm, out, kbps);
  log(`RMS голосу ${r.voiceRmsDb.toFixed(1)} дБFS, музики ${r.musicRmsDb.toFixed(1)} дБFS (до вирівнювання); шуми: ${r.sfxRmsDb.map((x) => `${x.label} ${x.rmsDb.toFixed(1)}`).join(', ')}.`);
  if (r.musicShorterBy > 0.05) log(`УВАГА: музика коротша за фільм на ${r.musicShorterBy.toFixed(1)} с: наприкінці музики немає.`);
  if (r.peakScale < 1) log(`УВАГА: щоб уникнути кліпінгу, загальну гучність зменшено на ${(-20 * Math.log10(r.peakScale)).toFixed(1)} дБ.`);
  const info = paths.workFile(story, 'mix.json');
  writeFileSync(
    info,
    JSON.stringify({ file: paths.rel(out), seconds: Math.round(filmSec * 1000) / 1000, bytes: statSync(out).size, generated_at: new Date().toISOString(), credits: 0, spec }, null, 2) + '\n',
  );
  log(`Готово: ${paths.rel(out)}, ${filmSec.toFixed(2)} с, ${(statSync(out).size / 1e6).toFixed(2)} МБ (параметри: ${paths.rel(info)}).`);
}

runMain(main);
