// Фото-референси: завантаження фото з work/references/<id>/ в `assets create`, id у маніфест
// (assets.references[<id>].files[<файл>]). Перед завантаженням довша сторона зменшується до 1536 px
// (оригінали не чіпаємо). Завантажуються лише фото, для яких є запис у art/references-sources.md
// (автор і ліцензія: вимога ліцензій з атрибуцією).
//
//   npx tsx scripts/upload-references.ts --story 01-natalia            сухий прогін
//   npx tsx scripts/upload-references.ts --story 01-natalia --run
//   npx tsx scripts/upload-references.ts --story 01-natalia --run --object bohdan-bus

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse as parsePath } from 'node:path';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { ElevenLabsClient } from './lib/elevenlabs';
import { log, warn } from './lib/log';
import { readManifest, updateManifest } from './lib/manifest';
import { assertStoryExists, paths } from './lib/paths';
import { prepareReference } from './lib/reference-image';
import { checkSourcesAgainstObjects, parseReferenceSources, parseReferences, photoFilePath, photosOf } from './lib/references';

const HELP = `Завантаження фото-референсів.
Прапорці:
  --story <id>     історія (маніфест; обов'язково)
  --object <id>    лише цей об'єкт (через кому можна кілька)
  --run            справді завантажити (без нього сухий прогін). Кредити не витрачаються.`;

async function main(): Promise<void> {
  const { values } = parseCli({ object: { type: 'string' } });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: false });
  assertStoryExists(flags.story);
  const story = flags.story;
  const objects = parseReferences();
  const sources = parseReferenceSources();
  checkSourcesAgainstObjects(sources, objects);
  const only = values.object ? new Set(values.object.split(',').map((x) => x.trim())) : undefined;
  if (only) for (const id of only) if (!objects.some((o) => o.id === id)) throw new Error(`--object: об'єкта «${id}» немає в art/references.md.`);

  const manifest = readManifest(story);
  const store = (manifest.assets.references ?? {}) as Record<string, { files?: Record<string, { sha1: string; asset_id: string }> }>;
  const todo: Array<{ obj: string; file: string; path: string; sha1: string; order: number; source: string }> = [];
  for (const obj of objects) {
    if (only && !only.has(obj.id)) continue;
    const all = sources.filter((s) => s.object === obj.id);
    const photos = photosOf(sources, obj.id, obj.count);
    if (all.length > obj.count) warn(`Об'єкт ${obj.id}: у джерелах ${all.length} фото, а «Скільки:» ${obj.count}. Беремо перші ${obj.count}.`);
    if (!photos.length) {
      warn(`Об'єкт ${obj.id}: у art/references-sources.md немає жодного запису.`);
      continue;
    }
    // Файли в теці без запису про джерело не завантажуємо.
    const dir = paths.referencesWork(obj.id);
    if (existsSync(dir)) {
      const listed = new Set(all.map((s) => s.file));
      for (const f of readdirSync(dir).filter((x) => /\.(jpe?g|png|webp)$/i.test(x))) if (!listed.has(f)) warn(`work/references/${obj.id}/${f}: немає запису в art/references-sources.md (автор, ліцензія), не завантажуємо.`);
    }
    photos.forEach((p, i) => {
      const path = photoFilePath(obj.id, p.file);
      if (!existsSync(path)) throw new Error(`Об'єкт ${obj.id}: файлу ${paths.rel(path)} немає, а в art/references-sources.md (рядок ${p.line}) він є.`);
      const sha1 = createHash('sha1').update(readFileSync(path)).digest('hex');
      todo.push({ obj: obj.id, file: p.file, path, sha1, order: i, source: p.source });
    });
  }

  const client = new ElevenLabsClient();
  let uploaded = 0;
  for (const t of todo) {
    const have = store[t.obj]?.files?.[t.file];
    const prep = await prepareReference(t.path);
    const size = `${prep.origWidth}×${prep.origHeight} → ${prep.width}×${prep.height} px (${(prep.data.length / 1024).toFixed(0)} КБ)`;
    if (have && have.sha1 === t.sha1) {
      log(`  ${t.obj}/${t.file}: уже завантажено (${have.asset_id}), пропуск.`);
      continue;
    }
    log(`  ${t.obj}/${t.file}: буде завантажено, ${size}`);
    if (!flags.run) continue;
    const name = `reference-${t.obj}-${parsePath(t.file).name}-${t.sha1.slice(0, 8)}`;
    const asset = await client.createAsset(prep.data, `${parsePath(t.file).name}.jpg`, name, 'image/jpeg');
    updateManifest(story, (m) => {
      const refs = (m.assets.references ??= {}) as Record<string, { files: Record<string, unknown> }>;
      const entry = (refs[t.obj] ??= { files: {} });
      entry.files[t.file] = { asset_id: asset.asset_id, name, sha1: t.sha1, order: t.order, width: prep.width, height: prep.height, source: t.source, uploaded_at: new Date().toISOString() };
    });
    uploaded++;
    log(`    ресурс ${asset.asset_id}, записано в маніфест (assets.references.${t.obj}).`);
  }
  if (!flags.run) log('\nСУХИЙ ПРОГІН: нічого не завантажено. Додайте --run.');
  else log(`\nЗавантажено: ${uploaded}.`);
}

runMain(main);
