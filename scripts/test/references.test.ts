import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import sharp from 'sharp';
import { parsePhotoRefIds, parseSamples, parseStoryboard } from '../lib/docs';
import { updateManifest } from '../lib/manifest';
import { readDoc } from '../lib/md';
import { paths } from '../lib/paths';
import { licenseKind, parseReferenceSources, parseReferences, resolvePhotoRefs, checkSourcesAgainstObjects } from '../lib/references';
import { prepareReference } from '../lib/reference-image';
import { gatherPhotoRefs } from '../lib/review-refs';
import { renderPhotoRefs } from '../lib/review-html';
import { STORY, mkProject } from './fixtures';

export const REFERENCES_MD = `# Фото-референси

## Об'єкт bohdan-bus: Автобус «Богдан»
Де потрібен: зразки 9–12, кадр 5
Що шукати: White Bogdan A092 minibus, side view, Ukraine
Скільки: 2

## Об'єкт gas-pipe: Жовта газова труба
Де потрібен: кадр 1
Що шукати: yellow gas pipe along a Soviet apartment wall
Скільки: 1
`;

const SOURCES_LIST = `# Джерела фото-референсів

- Об'єкт: bohdan-bus
  Файл: bus1.jpg
  Джерело: https://commons.wikimedia.org/wiki/File:Bus1.jpg
  Автор: Ivan Petrenko
  Ліцензія: CC-BY-SA 4.0
  Посилання на ліцензію: https://creativecommons.org/licenses/by-sa/4.0/
  Дата завантаження: 2026-11-05

- Об'єкт: bohdan-bus
  Файл: bus2.png
  Джерело: https://commons.wikimedia.org/wiki/File:Bus2.png
  Автор: Olena K.
  Ліцензія: CC0 1.0
  Посилання на ліцензію: https://creativecommons.org/publicdomain/zero/1.0/
  Дата завантаження: 2026-11-05
`;

const SOURCES_TABLE = `# Джерела

| Об'єкт | Файл | Джерело | Автор | Ліцензія | Посилання на ліцензію | Дата завантаження |
|---|---|---|---|---|---|---|
| gas-pipe | pipe.webp | https://example.org/pipe | A. Author | CC-BY 4.0 | https://creativecommons.org/licenses/by/4.0/ | 2026-11-05 |
`;

let root = '';
before(() => {
  root = mkProject();
  writeFileSync(join(root, 'art', 'references.md'), REFERENCES_MD);
});
const srcFile = () => paths.referencesSourcesDoc();

describe('art/references.md', () => {
  it('розбирає об\'єкти', () => {
    const o = parseReferences();
    assert.deepEqual(o.map((x) => [x.id, x.count]), [['bohdan-bus', 2], ['gas-pipe', 1]]);
    assert.equal(o[0]!.name, 'Автобус «Богдан»');
    assert.match(o[0]!.search, /Bogdan/);
  });
  it('суворо: Скільки поза 1–3, поганий id, немає поля', () => {
    const f = paths.referencesDoc();
    writeFileSync(f, REFERENCES_MD.replace('Скільки: 2', 'Скільки: 5'));
    assert.throws(() => parseReferences(), /references\.md, рядок \d+ \(роль: art-director\)[^]*1, 2 або 3/);
    writeFileSync(f, REFERENCES_MD.replace('bohdan-bus:', 'Bohdan_Bus:'));
    assert.throws(() => parseReferences(), /латиницею/);
    writeFileSync(f, REFERENCES_MD.replace('Що шукати: White Bogdan A092 minibus, side view, Ukraine\n', ''));
    assert.throws(() => parseReferences(), /немає поля «Що шукати/);
    writeFileSync(f, REFERENCES_MD);
  });
});

describe('art/references-sources.md', () => {
  it('списком і таблицею, ліцензії класифікуються', () => {
    writeFileSync(srcFile(), SOURCES_LIST);
    const a = parseReferenceSources();
    assert.deepEqual(a.map((s) => [s.object, s.file, s.licenseKind]), [['bohdan-bus', 'bus1.jpg', 'CC-BY-SA'], ['bohdan-bus', 'bus2.png', 'CC0']]);
    assert.equal(a[0]!.author, 'Ivan Petrenko');
    writeFileSync(srcFile(), SOURCES_TABLE);
    const b = parseReferenceSources();
    assert.deepEqual(b.map((s) => [s.object, s.file, s.licenseKind, s.licenseUrl]), [['gas-pipe', 'pipe.webp', 'CC-BY', 'https://creativecommons.org/licenses/by/4.0/']]);
  });
  it('невільні ліцензії та погані значення відхиляються з рядком', () => {
    assert.equal(licenseKind('CC BY-NC 4.0'), null);
    assert.equal(licenseKind('CC-BY-ND'), null);
    assert.equal(licenseKind('Public domain'), 'PD');
    assert.equal(licenseKind('Суспільне надбання'), 'PD');
    assert.equal(licenseKind('All rights reserved'), null);
    writeFileSync(srcFile(), SOURCES_LIST.replace('CC-BY-SA 4.0', 'CC BY-NC 4.0'));
    assert.throws(() => parseReferenceSources(), /references-sources\.md, рядок 7[^]*не вільна/);
    writeFileSync(srcFile(), SOURCES_LIST.replace('https://creativecommons.org/licenses/by-sa/4.0/', 'creativecommons.org'));
    assert.throws(() => parseReferenceSources(), /має бути посиланням http\(s\)/);
    writeFileSync(srcFile(), SOURCES_LIST.replace('  Автор: Ivan Petrenko\n', ''));
    assert.throws(() => parseReferenceSources(), /немає значення поля «Автор:»/);
    writeFileSync(srcFile(), SOURCES_LIST.replace('bus1.jpg', '../bus1.jpg'));
    assert.throws(() => parseReferenceSources(), /без шляху/);
    writeFileSync(srcFile(), SOURCES_LIST.replace("Об'єкт: bohdan-bus\n  Файл: bus2.png", "Об'єкт: tram\n  Файл: bus2.png"));
    assert.throws(() => checkSourcesAgainstObjects(parseReferenceSources(), parseReferences()), /Об'єкта «tram» немає в art\/references\.md/);
    writeFileSync(srcFile(), SOURCES_LIST);
  });
});

describe('поле «Фото-референси»', () => {
  it('у зразках і кадрах, з перевіркою id', () => {
    const sf = paths.samplesDoc();
    const orig = readFileSync(sf, 'utf8');
    writeFileSync(sf, orig.replace("Для генератора (англійською): A white minibus", "Фото-референси: bohdan-bus, gas-pipe\nДля генератора (англійською): A white minibus"));
    assert.deepEqual(parseSamples().samples[3]!.photoRefs, ['bohdan-bus', 'gas-pipe']);
    assert.deepEqual(parseSamples().samples[0]!.photoRefs, []);
    writeFileSync(sf, orig.replace("Для генератора (англійською): A white minibus", "Фото-референси: Bohdan Bus\nДля генератора (англійською): A white minibus"));
    assert.throws(() => parseSamples(), /samples\.md[^]*Фото-референси:» очікує id/);
    writeFileSync(sf, orig);
    const bf = paths.storyFile(STORY, 'storyboard.md');
    const bo = readFileSync(bf, 'utf8');
    writeFileSync(bf, bo.replace('Камера: наїзд.\nСвітло і настрій: спека.', 'Камера: наїзд.\nФото-референси: gas-pipe\nСвітло і настрій: спека.'));
    assert.deepEqual(parseStoryboard(STORY).frames[0]!.photoRefs, ['gas-pipe']);
    writeFileSync(bf, bo);
    const doc = readDoc(sf, 'art-director');
    assert.deepEqual(parsePhotoRefIds(doc, 'немає', 1, 'x'), []);
    assert.throws(() => parsePhotoRefIds(doc, 'a, a', 1, 'x'), /повторює/);
  });
});

describe('референси для запиту: asset id з маніфесту, бракує — у списку missing', () => {
  it('порядок за джерелами, не більше «Скільки», невпізнаний id — помилка', () => {
    let r = resolvePhotoRefs(STORY, ['bohdan-bus'], 'Зразок 9');
    assert.deepEqual(r, { refs: [], missing: ['фото-референс «bohdan-bus» ще не завантажено (upload-references.py)'.replace('.py', '.ts')] });
    updateManifest(STORY, (m) => {
      m.assets.references = { 'bohdan-bus': { files: { 'bus2.png': { asset_id: 'asset_B', order: 1 }, 'bus1.jpg': { asset_id: 'asset_A', order: 0 }, 'bus3.jpg': { asset_id: 'asset_C', order: 2 } } } } as never;
    });
    r = resolvePhotoRefs(STORY, ['bohdan-bus'], 'Зразок 9');
    assert.deepEqual(r.refs, ['asset:asset_A', 'asset:asset_B'], 'Скільки: 2');
    assert.deepEqual(r.missing, []);
    assert.throws(() => resolvePhotoRefs(STORY, ['tram'], 'Кадр 5'), /Кадр 5: невпізнаний фото-референс «tram»/);
  });
});

describe('підготовка фото', () => {
  it('довша сторона не більше 1536 px, оригінал не змінюється; малі не збільшуються', async () => {
    const big = join(root, 'work', 'references', 'bohdan-bus', 'big.png');
    mkdirSync(dirname(big), { recursive: true });
    await sharp({ create: { width: 3200, height: 2000, channels: 3, background: '#808080' } }).png().toFile(big);
    const before = statSync(big).size;
    const p = await prepareReference(big);
    assert.equal(Math.max(p.width, p.height), 1536);
    assert.equal(p.width, 1536);
    assert.equal(p.height, 960);
    assert.equal(p.origWidth, 3200);
    assert.equal(statSync(big).size, before);
    const small = join(root, 'work', 'references', 'bohdan-bus', 'small.png');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toFile(small);
    assert.equal((await prepareReference(small)).width, 800);
  });
});

describe('розділ «Фото-референси» на сторінці', () => {
  it('немає art/references-sources.md: розділу немає', () => {
    if (existsSync(srcFile())) writeFileSync(srcFile(), SOURCES_LIST);
    const f = srcFile();
    writeFileSync(f, SOURCES_LIST);
    require_removed(f);
    assert.deepEqual(gatherPhotoRefs(new Map([['bohdan-bus', ['зразок 9']]]), [], []), []);
    writeFileSync(f, SOURCES_LIST);
  });

  it('мініатюра, автор, ліцензія з посиланням, джерело з посиланням; відсутній файл дає попередження', () => {
    writeFileSync(join(root, 'work', 'references', 'bohdan-bus', 'bus1.jpg'), 'x');
    const media: never[] = [];
    const warnings: string[] = [];
    const blocks = gatherPhotoRefs(new Map([['bohdan-bus', ['зразок 9', 'зразок 10']]]), media, warnings);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.photos.length, 2);
    assert.ok(warnings.some((w) => /bus2\.png/.test(w)));
    const html = renderPhotoRefs(blocks, (k) => (k === 'ref:bohdan-bus/bus1.jpg' ? 'media/references/bohdan-bus-1.jpg' : undefined));
    assert.match(html, /<img src="media\/references\/bohdan-bus-1\.jpg"/);
    assert.match(html, /Автор: Ivan Petrenko/);
    assert.match(html, /<a href="https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/"[^>]*rel="noopener noreferrer">CC-BY-SA 4\.0<\/a>/);
    assert.match(html, /<a href="https:\/\/commons\.wikimedia\.org\/wiki\/File:Bus1\.jpg"/);
    assert.match(html, /Використано: зразок 9, зразок 10/);
  });
});

import { rmSync } from 'node:fs';
function require_removed(f: string): void {
  rmSync(f);
}
