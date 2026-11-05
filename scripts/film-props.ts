// Пропси композиції Film з edit.md і timings.json → work/<id>/film-props.json. Безкоштовно, без API.
//
//   npx tsx scripts/film-props.ts --story 01-natalia
//
// Якщо в аркуші щось не розбирається однозначно, скрипт падає з поясненням. Додаткові масштаби до кадрів
// (+2%, якщо на стоп-кадрі видно край паперу) лежать у stories/<id>/film-bumps.json: {"8": 0.02}.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError, runMain } from './lib/cli';
import { buildFilmProps, readBumps } from './lib/film-props';
import { log } from './lib/log';
import { assertStoryExists, paths } from './lib/paths';

async function main(): Promise<void> {
  let values: { story?: string; out?: string; 'allow-seconds-mismatch'?: boolean; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, out: { type: 'string' }, 'allow-seconds-mismatch': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log('Пропси Film з edit.md.\n  --story <id>  історія (обов\'язково)\n  --out <файл>  куди писати (за замовчуванням work/<id>/film-props.json)\n  --allow-seconds-mismatch  розбіжність секунд і кадрів лише попередження');
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  assertStoryExists(values.story);
  const { props, warnings } = buildFilmProps({ story: values.story, bumps: readBumps(values.story), allowSecondsMismatch: values['allow-seconds-mismatch'] });
  for (const w of warnings) log(`УВАГА: ${w}`);
  const out = values.out ?? paths.workFile(values.story, 'film-props.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(props, null, 1) + '\n');
  log(`Пропси фільму: ${paths.rel(out)}: ${props.shots.length} кадрів, ${props.durationInFrames} кадрів (${(props.durationInFrames / props.fps).toFixed(1)} с), ${props.subtitles.cards.length} карток субтитрів, звук: ${props.audio ?? 'немає'}.`);
}

runMain(main);
