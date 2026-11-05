// Крок 11: збирання огляду Етапу 1 (сторінка з аніматиком). Кредитів не витрачає, в API не ходить.
//
//   npx tsx scripts/review.ts --story 01-natalia --target artifact   → work/<id>/review/ (для публікації на claude.ai)
//   npx tsx scripts/review.ts --story 01-natalia --target pages      → docs/<id>/ (для GitHub Pages) + docs/.nojekyll
//
// Картинки стискаються в JPEG, звук іде в MP3, оригінали в work/ не змінюються. Разом не більше 16 МБ.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { encodeMp3, hasBinary } from './lib/audio';
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './lib/cli';
import { log } from './lib/log';
import { assertStoryExists, getRoot, paths } from './lib/paths';
import { gatherReview, titleName, type MediaItem } from './lib/review-build';
import { checkArtifactContract, checkCommon } from './lib/review-checks';
import { renderReview, type ReviewTarget } from './lib/review-html';

const HELP = `Огляд Етапу 1.
Прапорці:
  --story <id>            історія (обов'язково)
  --target artifact|pages artifact (за замовчуванням): work/<id>/review/, фрагмент для claude.ai;
                          pages: docs/<id>/, повний HTML для GitHub Pages
  --name "<ім'я>"         ім'я в заголовку («Наталя»); за замовчуванням з source.md («Автор: Наталя, …»)
  --out <тека>            інша тека виводу
  --limit-mb N            ліміт розміру в МБ (16 за замовчуванням, 1 МБ = 1 000 000 байт)`;

interface Level {
  q: number;
  maxWidth?: number;
  kbps: number | null;
}
/** Від найякіснішого до найстисненішого: беремо перший, що вкладається в ліміт. */
const LEVELS: Level[] = [
  { q: 85, kbps: null },
  { q: 78, kbps: null },
  { q: 72, maxWidth: 1080, kbps: 96 },
  { q: 62, maxWidth: 900, kbps: 80 },
  { q: 52, maxWidth: 768, kbps: 64 },
  { q: 45, maxWidth: 640, kbps: 48 },
];

export function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

async function produce(item: MediaItem, outDir: string, level: Level): Promise<void> {
  const dest = join(outDir, item.rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (item.kind === 'image') {
    let img = sharp(item.src).flatten({ background: '#ffffff' });
    if (level.maxWidth) img = img.resize({ width: level.maxWidth, withoutEnlargement: true });
    await img.jpeg({ quality: level.q, mozjpeg: true }).toFile(dest);
  } else if (level.kbps === null && /\.mp3$/i.test(item.src)) {
    copyFileSync(item.src, dest); // MP3 уже є: нічого з ним не робимо
  } else {
    encodeMp3(item.src, dest, level.kbps ?? 128);
  }
}

async function main(): Promise<void> {
  let values: { story?: string; target?: string; name?: string; out?: string; 'limit-mb'?: string; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, target: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' }, 'limit-mb': { type: 'string' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log(HELP);
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  const target = (values.target ?? 'artifact') as ReviewTarget;
  if (target !== 'artifact' && target !== 'pages') throw new UsageError('--target має бути artifact або pages.');
  const story = values.story;
  assertStoryExists(story);
  const limit = Number(values['limit-mb'] ?? 16) * 1_000_000;
  const outDir = values.out ?? (target === 'pages' ? join(getRoot(), 'docs', story) : paths.workFile(story, 'review'));
  if (!hasBinary('ffmpeg') && !hasBinary('ffprobe')) log('УВАГА: ffmpeg не знайдено; MP3 копіюються без перекодування, а WAV не підтримуються.');

  const data = gatherReview(story, values.name);
  const title = `${titleName(data.name)}, огляд Етапу 1`;
  log(`Огляд «${title}», режим ${target}, вивід ${paths.rel(outDir)}`);
  for (const w of data.warnings) log(`УВАГА: ${w}`);

  rmSync(join(outDir, 'media'), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const available = new Set<string>();
  let html = '';
  let chosen = -1;
  for (let i = 0; i < LEVELS.length; i++) {
    const level = LEVELS[i]!;
    rmSync(join(outDir, 'media'), { recursive: true, force: true });
    available.clear();
    for (const item of data.media) {
      await produce(item, outDir, level);
      available.add(item.key);
    }
    html = renderReview(data, target, title, available);
    writeFileSync(join(outDir, 'index.html'), html);
    const size = dirSize(outDir);
    log(`  рівень ${i + 1}: JPEG q=${level.q}${level.maxWidth ? `, ширина ≤ ${level.maxWidth}` : ''}, MP3 ${level.kbps ?? 'як є'}: разом ${(size / 1e6).toFixed(2)} МБ`);
    if (size <= limit) {
      chosen = i;
      break;
    }
  }
  if (chosen < 0) throw new Error(`Навіть найсильніше стиснення не вкладається в ${limit / 1e6} МБ. Потрібне рішення режисера (менше кадрів чи коротший звук).`);

  const problems = [...checkCommon(html), ...(target === 'artifact' ? checkArtifactContract(html) : [])];
  if (problems.length) throw new Error('Сторінка не відповідає контракту:\n  - ' + problems.join('\n  - '));
  if (target === 'pages') {
    const nojekyll = join(dirname(outDir), '.nojekyll');
    if (!existsSync(nojekyll)) writeFileSync(nojekyll, '');
  }
  log(`\nГотово: ${paths.rel(join(outDir, 'index.html'))}, медіа: ${data.media.length} файлів, разом ${(dirSize(outDir) / 1e6).toFixed(2)} МБ (ліміт ${limit / 1e6} МБ).`);
  if (target === 'artifact') log('Публікація: тека разом із media/ як приватна сторінка (Artifact); посилання на медіа відносні.');
  else log('Далі: git add docs/ (комітить технічний продюсер); сторінка буде за адресою <github-pages>/' + story + '/');
}

runMain(main);
