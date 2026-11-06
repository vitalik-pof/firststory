// Повне зведення фільму: озвучення + музика (+ шуми, якщо вони є) за звуковим брифом (stories/<id>/sound.md).
// Усі секунди sound.md рахуються від початку фільму: озвучення стоїть із затримкою «Озвучення стоїть
// у фільмі з N с» (береться з документа), музика грає з 0 с на всю довжину фільму.
// Кредитів не витрачає і в API не ходить: лише ffmpeg (декодування/кодування) і власна крива гучності
// з lib/mix.ts (та сама, що в зразку зведення, плюс шуми й ділянки-винятки).
//
//   npx tsx scripts/mix-full.ts --story 01-natalia --tail-frames 157            # українська: work/<id>/mix.mp3 (+ mix.json)
//   npx tsx scripts/mix-full.ts --story 01-natalia --lang en --tail-frames 157  # англійська: work/<id>/en/mix.mp3
//   npx tsx scripts/mix-full.ts --story 01-natalia --lang fr --tail-frames 157 --dry-run  # лише план: вікна, паузи, швидкість
//
// Розділ «Зведення» sound.md тепер це правила для будь-якої мови (lib/mix-rules.ts): вікна прив'язані до слів,
// фрагментів і пауз timings.json мови, швидкість читання музики v = 114.0 / (3.0 + duration) у межах 0.80…1.08.
// Довжина фільму L приходить ззовні: --film-length L, --tail F (L = 3.0 + duration + F) або --tail-frames N
// (L = F_total / 30 за правилами edit.md: tD + N кадрів, саме така довжина mix.mp3 кожної мови).
// Старий формат розділу (секунди української версії прозою) читається, як раніше, лише для української.
//
// Маніфест не чіпається: нічого, крім файлів у work/<id>/[<код>/], скрипт не пише.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSound } from './lib/docs';
import { UsageError, runMain } from './lib/cli';
import { log } from './lib/log';
import { CH, SR, baseMusicEnvelope, dbAt, decodeMusic, decodeStereo, encodeStereoMp3, lowpass, mixFilm, padVoice, rmsOver, speechIntervals, withPatches, type FilmSfx } from './lib/mix';
import { boostFilmDb, checkRulesAgainstDoc, filmLengthFromArgs, isLanguageIndependentMix, musicLevelFn, planLangMix, RULES } from './lib/mix-rules';
import { parseFilmLength, parseFilmMix, parseVoiceDelay } from './lib/mix-spec';
import { assertStoryExists, getRoot, isDefaultLang, normalizeLang, paths } from './lib/paths';
import type { TimingsFile } from './lib/timings';

const HELP = `Повне зведення фільму (безкоштовно).
Прапорці:
  --story <id>         історія (обов'язково)
  --lang <код>         мовна версія: en, fr, de (таймінги stories/<id>/<код>/timings.json, результат work/<id>/<код>/mix.mp3
                       і mix.json); без прапорця українська (work/<id>/mix.mp3)
  --film-length <с>    довжина фільму L, секунди
  --tail <с>           фінальний титр F після кінця файлу озвучення, секунди: L = 3.0 + duration + F
  --tail-frames <N>    фінальний титр у кадрах (157 за edit.md): L = (tD + N) / 30, tD за правилами edit.md. Рекомендовано.
                       Одне з трьох обов'язкове (для старого формату «Зведення» не потрібне): довжину скрипт не вгадує.
  --dry-run            лише розібрати sound.md і показати план, файлів не створювати
  --out <файл>         інший файл виводу (за замовчуванням work/<id>[/<код>]/mix.mp3)
  --kbps N             бітрейт MP3 (128 за замовчуванням)`;

const fmt = (x: number): string => (Math.round(x * 100) / 100).toString();

async function main(): Promise<void> {
  let values: { story?: string; lang?: string; 'film-length'?: string; tail?: string; 'tail-frames'?: string; 'dry-run'?: boolean; out?: string; kbps?: string; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, lang: { type: 'string' }, 'film-length': { type: 'string' }, tail: { type: 'string' }, 'tail-frames': { type: 'string' }, 'dry-run': { type: 'boolean' }, out: { type: 'string' }, kbps: { type: 'string' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log(HELP);
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  const story = values.story;
  assertStoryExists(story);
  const kbps = Number(values.kbps ?? 128);
  if (!Number.isFinite(kbps) || kbps < 32) throw new UsageError('--kbps має бути числом не менше 32.');

  const lang = normalizeLang(values.lang);
  const timingsFile = paths.timings(story, lang);
  if (!existsSync(timingsFile)) throw new Error(`Немає ${paths.rel(timingsFile)}: спершу озвучення цієї мови (narrate.ts${isDefaultLang(lang) ? '' : ` --lang ${lang}`}).`);
  const timings = JSON.parse(readFileSync(timingsFile, 'utf8')) as TimingsFile;
  const sound = parseSound(story);
  if (isLanguageIndependentMix(sound.mix)) return mixByRules(story, lang, timings, sound, values, kbps);
  if (!isDefaultLang(lang)) throw new Error('Розділ «Зведення» у sound.md у старому форматі (секунди української версії): мовні версії зводяться лише за новими правилами. Роль: composer.');
  // Затримка озвучення: з документа (не хардкод); слова, пауза й кінець фільму зсуваються на неї.
  const delay = parseVoiceDelay(sound.mix) ?? 0;
  const words = timings.fragments.flatMap((f) => f.words).map((w) => ({ start: w.start + delay, end: w.end + delay }));
  const lastWordEnd = Math.max(...words.map((w) => w.end));
  // Довжина фільму: явна («- Довжина фільму 134.0 с.» у «Зведенні»), інакше кінець озвучення плюс затримка.
  const voiceEnd = timings.duration + delay;
  const explicitEnd = parseFilmLength(sound.mix);
  if (explicitEnd !== undefined && explicitEnd < voiceEnd - 0.001) {
    throw new Error(`«Довжина фільму» ${explicitEnd} с у sound.md коротша за озвучення (${fmt(voiceEnd)} с): голос обрізався б. Роль: composer.`);
  }
  const filmEnd = explicitEnd ?? voiceEnd;
  const spec = parseFilmMix(sound.mix, sound.sfx, { filmEnd, lastWordEnd });
  log(`Зведення фільму ${story}: тривалість ${fmt(filmEnd)} с${explicitEnd !== undefined ? ' (явна «Довжина фільму»)' : ''} (озвучення ${fmt(timings.duration)} с, стоїть із ${fmt(spec.voiceDelay)} с), мовлення ${fmt(words[0]!.start)}–${fmt(lastWordEnd)} с.`);
  if (sound.totalSeconds !== undefined && Math.abs(sound.totalSeconds - filmEnd) > 0.05) {
    log(`УВАГА: «Загальна тривалість» у sound.md ${sound.totalSeconds} с, а довжина зведення ${fmt(filmEnd)} с.`);
  }
  if (spec.music.offset > 0 || spec.music.speed !== 1 || spec.music.boost.length) log(`Читання музики: з ${fmt(spec.music.offset)} с файлу, швидкість ${spec.music.speed}, підсилення початку ${spec.music.boost.length ? spec.music.boost.map((p) => `${p.t} с ${p.db > 0 ? '+' : ''}${p.db}`).join(', ') : 'немає'}.`);
  log(`Музика: під голосом ${spec.underDb} дБ, у паузах довших за ${spec.pauseMin} с ${spec.pauseDb} дБ, зміна гучності ${spec.fade} с; ділянок-винятків ${spec.musicPatches.length}, на кінці згасання ${spec.endFade} с.`);
  for (const p of spec.musicPatches) log(`  ділянка музики: ${p.label}`);
  if (spec.sfx.length) log('Шуми (файл починається на «Де», рівень відносно голосу):');
  else log('Шумів немає: підмішуються лише голос і музика.');
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
  let voice = padVoice(decodeStereo(narration), spec.voiceDelay);
  // MP3 озвучення може бути на кілька десятків мс коротшим за timings.json: фільм має довжину за документом.
  const wantFrames = Math.round(filmEnd * SR);
  if (voice.length / CH < wantFrames) {
    const grown = new Float32Array(wantFrames * CH);
    grown.set(voice);
    voice = grown;
  } else if (explicitEnd !== undefined && voice.length / CH > wantFrames) {
    // Явна довжина фільму: надлишок декодованого MP3 (десятки мс) відрізається, щоб зведення було рівно такої довжини.
    voice = voice.slice(0, wantFrames * CH);
  }
  // Музика: з секунди offset файлу, зі швидкістю speed; RMS по ділянці оригінального файлу (якщо вона задана), інакше по прочитаному.
  const ms = spec.music;
  const original = ms.rmsFrom !== undefined || ms.offset > 0 || ms.speed !== 1 ? decodeStereo(musicFile) : undefined;
  const music = original && (ms.offset > 0 || ms.speed !== 1) ? decodeMusic(musicFile, ms.offset, ms.speed) : original ?? decodeStereo(musicFile);
  let musicRms: number | undefined;
  if (original && ms.rmsFrom !== undefined && ms.rmsTo !== undefined) {
    const fileSec = original.length / CH / SR;
    musicRms = rmsOver(original, [{ a: ms.rmsFrom, b: Math.min(ms.rmsTo, fileSec) }]);
    log(`RMS музики по оригінальному файлу від ${fmt(ms.rmsFrom)} до ${fmt(Math.min(ms.rmsTo, fileSec))} с (файл ${fmt(fileSec)} с); музика у фільмі ${fmt(music.length / CH / SR)} с.`);
  }
  const filmSec = voice.length / CH / SR;
  const intervals = speechIntervals(words, spec.pauseMin);
  const levelDb = withPatches(baseMusicEnvelope(intervals, spec.underDb, spec.pauseDb, spec.fade), spec.musicPatches);
  const boost = ms.boost;
  const musicDb = boost.length ? (t: number): number => levelDb(t) + dbAt(boost, t) : levelDb;
  const sfx: FilmSfx[] = spec.sfx.map((s) => {
    log(`Декодую шум ${s.n}…`);
    let pcm = decodeStereo(sfxFile(s.n));
    if (s.muffled) pcm = lowpass(pcm, 3000);
    const fileEnd = s.start + pcm.length / CH / SR;
    const fadeOutEnd = Math.min(s.fadeOutEnd ?? Infinity, fileEnd, filmSec);
    return { label: `шум ${s.n}`, pcm, start: s.start, levelDb: withPatches(() => s.levelDb, s.patches), fadeIn: s.fadeIn, fadeOutLen: s.fadeOutLen, fadeOutEnd };
  });

  log('Зводжу…');
  const r = mixFilm(voice, music, { words, pauseMin: spec.pauseMin, musicDb, endFade: spec.endFade, musicFadeIn: spec.musicFadeIn, musicRms, sfx });
  mkdirSync(dirname(out), { recursive: true });
  log('Кодую MP3…');
  encodeStereoMp3(r.pcm, out, kbps);
  log(`RMS голосу ${r.voiceRmsDb.toFixed(1)} дБFS, музики ${r.musicRmsDb.toFixed(1)} дБFS (до вирівнювання)${r.sfxRmsDb.length ? `; шуми: ${r.sfxRmsDb.map((x) => `${x.label} ${x.rmsDb.toFixed(1)}`).join(', ')}` : ''}.`);
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

type Values = { 'film-length'?: string; tail?: string; 'tail-frames'?: string; 'dry-run'?: boolean; out?: string };

/** Зведення за правилами розділу «Зведення» для будь-якої мови (див. lib/mix-rules.ts). */
async function mixByRules(story: string, lang: string, timings: TimingsFile, sound: ReturnType<typeof parseSound>, values: Values, kbps: number): Promise<void> {
  const { L, how } = filmLengthFromArgs(timings.duration, values);
  const plan = planLangMix(timings, L);
  const check = checkRulesAgainstDoc(sound.mix);
  const warnings = [...check, ...plan.warnings];
  // «Загальна тривалість» у sound.md це довжина української версії; для інших мов число інше.
  if (isDefaultLang(lang) && sound.totalSeconds !== undefined && Math.abs(sound.totalSeconds - L) > 0.05) {
    warnings.push(`«Загальна тривалість» у sound.md ${sound.totalSeconds} с, а довжина зведення ${fmt(L)} с (${how}).`);
  }
  log(`Зведення фільму ${story}, версія ${lang}: L = ${fmt(L)} с (${how}); озвучення D = ${fmt(plan.D)} с стоїть із ${RULES.O} с, перше слово W1 = ${fmt(plan.W1)} с, останнє закінчується E = ${fmt(plan.E)} с.`);
  log(`Читання музики: з ${RULES.O} с файлу, швидкість v = ${plan.speed.v}${plan.speed.limited ? ` (за формулою ${plan.speed.raw}, обмежено межею)` : ''}, підсилення початку (секунди файлу): ${RULES.boost.map(([t, db]) => `${t} с ${db > 0 ? '+' : ''}${db}`).join(', ')}.`);
  log(`Рівні: музика під голосом ${RULES.underDb} дБ, у паузах довших за ${RULES.pauseMin} с ${RULES.pauseDb} дБ (зміна за ${RULES.fade} с).`);
  log(`P1 (найдовша пауза у фрагменті 1): ${plan.P1 ? `${fmt(plan.P1.a)}–${fmt(plan.P1.b)} с (${fmt(plan.P1.b - plan.P1.a)} с)` : 'немає'}.`);
  log('Вікна пунктів (секунди фільму):');
  for (const w of plan.windows) log(`  ${w.item}. ${w.label}: ${fmt(w.from)}–${fmt(w.to)} с`);
  log(`Паузи довші за ${RULES.pauseMin} с: ${plan.pauses.length ? plan.pauses.map((p) => `${fmt(p.a)}–${fmt(p.b)} с (${fmt(p.g)} с)`).join('; ') : 'немає'}.`);
  log(`Події файлу музики на секундах фільму (f − ${RULES.O}) / v: ${plan.fileEvents.map((e) => `файл ${e.file} → ${fmt(e.film)} с`).join(', ')}.`);
  for (const n of plan.notes) log(`ПРОЧИТАНО: ${n}`);
  for (const w of warnings) log(`УВАГА: ${w}`);

  const narration = timings.audio_file && existsSync(join(getRoot(), timings.audio_file)) ? join(getRoot(), timings.audio_file) : paths.workLangFile(story, lang, 'narration.mp3');
  const musicFile = paths.workFile(story, 'audio', 'music.mp3');
  const out = values.out ?? paths.workLangFile(story, lang, 'mix.mp3');
  const missing = [narration, musicFile].filter((f) => !existsSync(f));
  if (values['dry-run']) {
    if (missing.length) log(`(Для справжнього зведення бракує файлів: ${missing.map((f) => paths.rel(f)).join(', ')}.)`);
    return void log(`\nСУХИЙ ПРОГІН: файл ${paths.rel(out)} не створено.`);
  }
  if (missing.length) throw new Error(`Немає файлів: ${missing.map((f) => paths.rel(f)).join(', ')}.`);

  log('\nДекодую озвучення й музику…');
  let voice = padVoice(decodeStereo(narration), RULES.O);
  const wantFrames = Math.round(L * SR);
  if (voice.length / CH < wantFrames) {
    const grown = new Float32Array(wantFrames * CH);
    grown.set(voice);
    voice = grown;
  } else if (voice.length / CH > wantFrames) voice = voice.slice(0, wantFrames * CH);
  const music = decodeMusic(musicFile, RULES.O, plan.speed.v);
  const original = decodeStereo(musicFile);
  const fileSec = original.length / CH / SR;
  const musicRms = rmsOver(original, [{ a: RULES.rmsFrom, b: Math.min(RULES.rmsTo, fileSec) }]);
  log(`RMS музики по оригінальному файлу від ${RULES.rmsFrom} до ${fmt(Math.min(RULES.rmsTo, fileSec))} с (файл ${fmt(fileSec)} с); музика у фільмі ${fmt(music.length / CH / SR)} с.`);
  const level = musicLevelFn(plan);
  const v = plan.speed.v;
  log('Зводжу…');
  const r = mixFilm(voice, music, { words: plan.words, pauseMin: RULES.pauseMin, musicDb: (t) => level(t) + boostFilmDb(t, v), endFade: RULES.endFade, musicFadeIn: RULES.fadeIn, musicRms, sfx: [] });
  mkdirSync(dirname(out), { recursive: true });
  log('Кодую MP3…');
  encodeStereoMp3(r.pcm, out, kbps);
  log(`RMS голосу ${r.voiceRmsDb.toFixed(1)} дБFS, музики ${r.musicRmsDb.toFixed(1)} дБFS (до вирівнювання).`);
  if (r.musicShorterBy > 0.05) log(`УВАГА: музика коротша за фільм на ${r.musicShorterBy.toFixed(1)} с: наприкінці музики немає.`);
  if (r.peakScale < 1) log(`УВАГА: щоб уникнути кліпінгу, загальну гучність зменшено на ${(-20 * Math.log10(r.peakScale)).toFixed(1)} дБ.`);
  const info = join(dirname(out), 'mix.json');
  const { words: _words, ...planOut } = plan;
  void _words;
  const seconds = Math.round((r.pcm.length / CH / SR) * 1000) / 1000;
  writeFileSync(
    info,
    JSON.stringify({ file: paths.rel(out), lang, seconds, bytes: statSync(out).size, generated_at: new Date().toISOString(), credits: 0, duration: plan.D, L: plan.L, v: plan.speed.v, v_raw: plan.speed.raw, v_limited: plan.speed.limited, W1: plan.W1, E: plan.E, P1: plan.P1 ?? null, windows: plan.windows, pauses_over_1_2: plan.pauses, file_events: plan.fileEvents, warnings, plan: planOut }, null, 2) + '\n',
  );
  log(`Готово: ${paths.rel(out)}, ${seconds.toFixed(2)} с, ${(statSync(out).size / 1e6).toFixed(2)} МБ (параметри: ${paths.rel(info)}).`);
}
