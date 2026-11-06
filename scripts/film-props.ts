// Пропси композиції Film з edit.md і таймінгів мови → work/<id>[/<код>]/film-props.json. Безкоштовно, без API.
//
//   npx tsx scripts/film-props.ts --story 01-natalia              # українська
//   npx tsx scripts/film-props.ts --story 01-natalia --lang fr    # французька (таймінги stories/<id>/fr/timings.json)
//
// Кадри рахуються з таймінгів мови за правилами «Алгоритму» edit.md. Якщо правило не застосовується чи щось не
// розбирається однозначно, скрипт падає з поясненням. Додаткові масштаби до кадрів (+2%, якщо на стоп-кадрі
// видно край паперу) лежать у stories/<id>/film-bumps.json: {"8": 0.02} (однакові в усіх мовах).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError, runMain } from './lib/cli';
import { buildFilmProps, readBumps } from './lib/film-props';
import { log } from './lib/log';
import { assertStoryExists, normalizeLang, paths } from './lib/paths';

async function main(): Promise<void> {
  let values: { story?: string; lang?: string; out?: string; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, lang: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log("Пропси Film з edit.md.\n  --story <id>  історія (обов'язково)\n  --lang <код>  мовна версія en|fr|de (без прапорця українська)\n  --out <файл>  куди писати (за замовчуванням work/<id>[/<код>]/film-props.json)");
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  assertStoryExists(values.story);
  const lang = normalizeLang(values.lang);
  const { props, warnings, plan } = buildFilmProps({ story: values.story, lang, bumps: readBumps(values.story) });
  for (const w of warnings) log(`УВАГА: ${w}`);
  if (plan.reduced.length) log(`Переходи зменшено до мінімуму чистого кадру (крок 7): після кадрів ${plan.reduced.join(', ')}.`);
  const out = values.out ?? paths.workLangFile(values.story, lang, 'film-props.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(props, null, 1) + '\n');
  log(`Пропси фільму ${lang}: ${paths.rel(out)}: ${props.shots.length} кадрів, ${props.durationInFrames} кадрів (${(props.durationInFrames / props.fps).toFixed(3)} с, tD = ${plan.tD}), ${props.subtitles.cards.length} карток субтитрів, звук: ${props.audio ?? 'немає'}.`);
}

runMain(main);
