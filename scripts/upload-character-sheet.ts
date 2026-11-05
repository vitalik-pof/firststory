// Крок 7 (друга половина): завантаження затвердженого аркуша героя в assets create
// і запис id у розділ «Ресурси» файлу героя (characters/<id>.md).
//
//   npx tsx scripts/upload-character-sheet.ts --story 01-natalia --character natalia:2014 --run
//   npx tsx scripts/upload-character-sheet.ts --story 01-natalia --all --run

import { existsSync, readFileSync } from 'node:fs';
import { commonFlags, parseCli, runMain } from './lib/cli';
import { findSheet, parseCharacter, parseStoryboard, writeCharacterResource } from './lib/docs';
import { ElevenLabsClient } from './lib/elevenlabs';
import { sheetFile, sheetKey } from './lib/frame-refs';
import { log } from './lib/log';
import { readManifest, updateManifest } from './lib/manifest';
import { assertStoryExists, paths } from './lib/paths';

const HELP = `Завантаження затвердженого аркуша героя.
Прапорці:
  --story <id>             історія (обов'язково)
  --character <герой[:версія]>   один аркуш, або список через кому
  --all                    усі аркуші героїв із розкадровки
  --run                    справді завантажити (без нього сухий прогін). Кредити не витрачаються.`;

async function main(): Promise<void> {
  const { values } = parseCli({ character: { type: 'string' }, all: { type: 'boolean' } });
  if (values.help) return void log(HELP);
  const flags = commonFlags(values, { paid: false });
  assertStoryExists(flags.story);
  const story = flags.story;
  if (!values.character && !values.all) throw new Error('Вкажіть --character <герой[:версія]> або --all.');
  const refs: Array<[string, string | undefined]> = [];
  if (values.all) {
    const ids = [...new Set(parseStoryboard(story).frames.flatMap((f) => f.heroes.map((h) => h.id)))];
    for (const id of ids) for (const s of parseCharacter(id).sheets) refs.push([id, s.label]);
  } else {
    for (const w of values.character!.split(',').map((x) => x.trim()).filter(Boolean)) {
      const i = w.indexOf(':');
      refs.push(i < 0 ? [w, undefined] : [w.slice(0, i), w.slice(i + 1)]);
    }
  }

  const client = new ElevenLabsClient();
  const manifest = readManifest(story);
  const todo: Array<{ id: string; label: string; slug: string; file: string; key: string; genId: string }> = [];
  for (const [id, ver] of refs) {
    const doc = parseCharacter(id);
    const sh = findSheet(doc, ver, `--character ${id}`);
    const key = sheetKey(id, sh.slug);
    const cur = manifest.images[key]?.current;
    const file = sheetFile(id, sh.slug);
    if (!cur || !existsSync(file)) throw new Error(`Аркуш ${id}${sh.label === 'main' ? '' : ` «${sh.label}»`} ще не згенеровано (немає запису в маніфесті чи файлу ${paths.rel(file)}).`);
    const already = manifest.assets[key];
    const listed = doc.resources.find((r) => r.label.toLowerCase() === sh.label.toLowerCase());
    if (already && already.generation_id === cur.generation_id && listed?.assetId === already.asset_id) {
      log(`  ${id} «${sh.label}»: уже завантажено (${already.asset_id}), пропуск.`);
      continue;
    }
    todo.push({ id, label: sh.label, slug: sh.slug, file, key, genId: cur.generation_id });
  }
  for (const t of todo) log(`  ${t.id} «${t.label}»: буде завантажено ${paths.rel(t.file)} як ресурс «character-${t.id}-${t.slug}-${t.genId}»`);
  if (!flags.run) return void log('\nСУХИЙ ПРОГІН: нічого не завантажено. Додайте --run.');

  for (const t of todo) {
    const name = `character-${t.id}-${t.slug}-${t.genId}`;
    const asset = await client.createAsset(readFileSync(t.file), `${t.id}-${t.slug}.png`, name, 'image/png');
    updateManifest(story, (m) => {
      m.assets[t.key] = { asset_id: asset.asset_id, name, generation_id: t.genId, file: paths.rel(t.file), uploaded_at: new Date().toISOString() };
    });
    writeCharacterResource(t.id, t.label, asset.asset_id, `завантажено ${new Date().toISOString().slice(0, 10)}, ${paths.rel(t.file)}`);
    log(`  ${t.id} «${t.label}»: ресурс ${asset.asset_id}, записано в characters/${t.id}.md і маніфест.`);
  }
}

runMain(main);
