// Фото-референси: українські предмети за реальними фото з вільною ліцензією.
//  - art/references.md (художник): список об'єктів «## Об'єкт <id>: <назва>» з полями
//    «Де потрібен:», «Що шукати:» (англійською), «Скільки:» (1–3);
//  - art/references-sources.md (виконавець): записи «Об'єкт, Файл, Джерело, Автор, Ліцензія,
//    Посилання на ліцензію, Дата завантаження» (списком або таблицею);
//  - файли фото в work/references/<id>/.

import { existsSync } from 'node:fs';
import { type Doc, type Line, fail, firstLineOf, readDoc, readFieldsStrict, requireField, splitByHeading } from './md';
import { paths } from './paths';
import { readManifest } from './manifest';

export interface ReferenceObject {
  id: string;
  name: string;
  where: string;
  search: string;
  count: number;
  line: number;
}

export const OBJECT_ID_RE = /^[a-z][a-z0-9-]*$/;

export function parseReferences(): ReferenceObject[] {
  const doc = readDoc(paths.referencesDoc(), 'art-director');
  const { sections } = splitByHeading(doc.lines, 2);
  const out: ReferenceObject[] = [];
  for (const s of sections) {
    const m = /^Об['’ʼ]єкт\s+([^:\s]+)\s*:\s*(.+)$/i.exec(s.title);
    if (!m) fail(doc, s.line, `Заголовок об'єкта має бути «## Об'єкт <id>: <назва>», а є «${s.title}».`);
    const id = m[1]!;
    if (!OBJECT_ID_RE.test(id)) fail(doc, s.line, `id об'єкта «${id}» має бути латиницею малими літерами, цифрами й дефісами.`);
    if (out.some((o) => o.id === id)) fail(doc, s.line, `Об'єкт «${id}» описано двічі.`);
    const { fields } = readFieldsStrict(doc, s.body, { where: /^Де потрібен$/i, search: /^Що шукати/i, count: /^Скільки$/i });
    const where = `## ${s.title}`;
    const cf = requireField(doc, fields, 'count', 'Скільки', where, s.line);
    const cv = firstLineOf(cf.value);
    if (!/^[1-3]$/.test(cv)) fail(doc, cf.line, `${where}: «Скільки:» має бути 1, 2 або 3, а є «${cv}».`);
    out.push({
      id, name: m[2]!.trim(), line: s.line, count: Number(cv),
      where: requireField(doc, fields, 'where', 'Де потрібен', where, s.line).value,
      search: requireField(doc, fields, 'search', 'Що шукати (англійською)', where, s.line).value,
    });
  }
  if (!out.length) fail(doc, undefined, 'Немає жодного розділу «## Об\'єкт <id>: <назва>».');
  return out;
}

export type LicenseKind = 'CC0' | 'CC-BY' | 'CC-BY-SA' | 'PD' | 'director';

/** Походження «надано режисером»: фото без вільної ліцензії, лише вхід для генератора (на сторінку й у docs/ не потрапляє). */
export const DIRECTOR_PROVIDED = 'надано режисером';

export function isDirectorProvided(s: Pick<ReferenceSource, 'licenseKind'>): boolean {
  return s.licenseKind === 'director';
}

/** Вільні ліцензії: CC0, CC-BY, CC-BY-SA, суспільне надбання, а також окреме походження «надано режисером». NC і ND відхиляються. */
export function licenseKind(text: string): LicenseKind | null {
  const t = text.trim();
  if (t.toLowerCase().replace(/[.\s]+$/, '') === DIRECTOR_PROVIDED) return 'director';
  if (/(^|[\s-])(nc|nd)([\s-]|$)/i.test(t)) return null;
  if (/^cc[\s-]*0/i.test(t)) return 'CC0';
  if (/^cc[\s-]*by[\s-]*sa/i.test(t)) return 'CC-BY-SA';
  if (/^cc[\s-]*by/i.test(t)) return 'CC-BY';
  if (/(public\s*domain|суспільн[а-яіїєґ]*\s+надбан|^pd\b)/i.test(t)) return 'PD';
  return null;
}

export interface ReferenceSource {
  object: string;
  file: string;
  source: string;
  author: string;
  license: string;
  licenseKind: LicenseKind;
  licenseUrl: string;
  date: string;
  line: number;
}

const SRC_KEYS: Array<[keyof Omit<ReferenceSource, 'licenseKind' | 'line'>, RegExp, string]> = [
  ['object', /^Об['’ʼ]єкт$/i, 'Об\'єкт'],
  ['file', /^Файл$/i, 'Файл'],
  ['source', /^Джерело$/i, 'Джерело'],
  ['author', /^Автор$/i, 'Автор'],
  ['license', /^Ліцензія$/i, 'Ліцензія'],
  ['licenseUrl', /^Посилання на ліцензію$/i, 'Посилання на ліцензію'],
  ['date', /^Дата завантаження$/i, 'Дата завантаження'],
];

function cleanCell(s: string): string {
  return s.replace(/\*\*/g, '').replace(/^`|`$/g, '').trim();
}

/** Посилання з markdown «[текст](url)» чи «<url>» → url. */
function cleanUrl(s: string): string {
  const t = cleanCell(s);
  const md = /\]\(([^)\s]+)\)/.exec(t) ?? /^<([^>]+)>$/.exec(t);
  return md ? md[1]! : t;
}

interface RawRecord {
  line: number;
  values: Partial<Record<(typeof SRC_KEYS)[number][0], { v: string; line: number }>>;
}

function readRecords(doc: Doc): RawRecord[] {
  const records: RawRecord[] = [];
  const lines = doc.lines;
  // Таблиця: заголовок із «Об'єкт» і «Файл», далі рядки.
  let tableHeader: string[] | null = null;
  let cur: RawRecord | null = null;
  const keyOf = (label: string): (typeof SRC_KEYS)[number][0] | undefined => SRC_KEYS.find(([, re]) => re.test(label.replace(/[*`_]/g, '').trim()))?.[0];
  for (const l of lines) {
    const t = l.text.trim();
    if (t.startsWith('|')) {
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!tableHeader) {
        const keys = cells.map(keyOf);
        if (keys.includes('object') && keys.includes('file')) {
          tableHeader = cells;
          continue;
        }
        continue;
      }
      const rec: RawRecord = { line: l.n, values: {} };
      tableHeader.forEach((h, i) => {
        const k = keyOf(h);
        if (k && cells[i] !== undefined) rec.values[k] = { v: cells[i]!, line: l.n };
      });
      records.push(rec);
      continue;
    }
    const m = /^\s*(?:[-*]\s+)?\**([^:：*]{1,40}?)\**\s*[:：]\s*\**\s*(.*)$/.exec(l.text);
    const k = m ? keyOf(m[1]!) : undefined;
    if (m && k) {
      if (k === 'object') {
        cur = { line: l.n, values: {} };
        records.push(cur);
      }
      if (!cur) fail(doc, l.n, `Запис починається з «Об'єкт:», а перше поле «${m[1]}».`);
      if (cur.values[k]) fail(doc, l.n, `Поле «${m[1]!.trim()}» двічі в одному записі (запис з рядка ${cur.line}).`);
      cur.values[k] = { v: m[2]!, line: l.n };
    }
  }
  return records;
}

export function parseReferenceSources(): ReferenceSource[] {
  const doc = readDoc(paths.referencesSourcesDoc(), 'producer', '(список джерел фото-референсів складає виконавець)');
  const out: ReferenceSource[] = [];
  for (const rec of readRecords(doc)) {
    const get = (k: (typeof SRC_KEYS)[number][0], label: string): { v: string; line: number } => {
      const f = rec.values[k];
      if (!f || !cleanCell(f.v)) fail(doc, f?.line ?? rec.line, `У записі немає значення поля «${label}:».`);
      return f;
    };
    const object = cleanCell(get('object', "Об'єкт").v);
    const lic = get('license', 'Ліцензія');
    const kind = licenseKind(cleanCell(lic.v));
    if (!kind) fail(doc, lic.line, `Ліцензія «${cleanCell(lic.v)}» не вільна: дозволені лише CC0, CC-BY, CC-BY-SA, суспільне надбання і «${DIRECTOR_PROVIDED}» (NC й ND не підходять).`);
    const urls: Record<string, string> = {};
    for (const [k, label] of [['source', 'Джерело'], ['licenseUrl', 'Посилання на ліцензію']] as const) {
      const f = get(k, label);
      if (kind === 'director') {
        // Фото від режисера: джерело текстом, посилання на ліцензію «немає».
        urls[k] = k === 'licenseUrl' ? '' : cleanCell(f.v);
        continue;
      }
      const u = cleanUrl(f.v);
      if (!/^https?:\/\/[^\s"<>]+$/i.test(u)) fail(doc, f.line, `«${label}:» має бути посиланням http(s), а є «${cleanCell(f.v)}».`);
      urls[k] = u;
    }
    const dateF = kind === 'director' && !rec.values.date ? undefined : get('date', 'Дата завантаження');
    const file = cleanCell(get('file', 'Файл').v);
    if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(file)) fail(doc, rec.values.file!.line, `«Файл:» має бути іменем файлу jpg/png/webp без шляху, а є «${file}».`);
    out.push({
      object, file, source: urls.source!, author: cleanCell(get('author', 'Автор').v), license: cleanCell(lic.v), licenseKind: kind,
      licenseUrl: urls.licenseUrl!, date: dateF ? cleanCell(dateF.v) : '', line: rec.line,
    });
  }
  if (!out.length) fail(doc, undefined, 'У файлі немає жодного запису (очікуються поля «Об\'єкт:», «Файл:», «Джерело:», «Автор:», «Ліцензія:», «Посилання на ліцензію:», «Дата завантаження:»).');
  return out;
}

/** Перевіряє, що записи джерел посилаються на об'єкти з references.md. */
export function checkSourcesAgainstObjects(sources: ReferenceSource[], objects: ReferenceObject[]): void {
  const doc = readDoc(paths.referencesSourcesDoc(), 'producer');
  const known = new Set(objects.map((o) => o.id));
  for (const s of sources) if (!known.has(s.object)) fail(doc, s.line, `Об'єкта «${s.object}» немає в art/references.md (є: ${[...known].join(', ')}).`);
}

/** Фото об'єкта в порядку записів джерел, не більше «Скільки» (з references.md, якщо воно є). */
export function photosOf(sources: ReferenceSource[], objectId: string, limit = 3): ReferenceSource[] {
  return sources.filter((s) => s.object === objectId).slice(0, limit);
}

export function photoFilePath(objectId: string, file: string): string {
  return `${paths.referencesWork(objectId)}/${file}`;
}

export function photoExists(s: ReferenceSource): boolean {
  return existsSync(photoFilePath(s.object, s.file));
}

/**
 * Референси-фото для кадру чи зразка: asset id із маніфесту (assets.references[<id>].files).
 * missing: чого ще бракує (фото не завантажені).
 */
export function resolvePhotoRefs(story: string, ids: string[], where: string): { refs: string[]; missing: string[] } {
  const manifest = readManifest(story);
  const store = (manifest.assets.references ?? {}) as Record<string, { files?: Record<string, { asset_id: string; order?: number }> }>;
  let objects: ReferenceObject[] = [];
  try {
    objects = parseReferences();
  } catch (e) {
    if (!(e instanceof Error && e.name === 'MissingDocError')) throw e;
    throw new Error(`${where}: у полі «Фото-референси» вказано ${ids.join(', ')}, а art/references.md ще немає (його має створити роль art-director).`);
  }
  const refs: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const obj = objects.find((o) => o.id === id);
    if (!obj) throw new Error(`${where}: невпізнаний фото-референс «${id}» (в art/references.md є: ${objects.map((o) => o.id).join(', ')}).`);
    const files = Object.entries(store[id]?.files ?? {}).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0)).slice(0, obj.count);
    if (!files.length) missing.push(`фото-референс «${id}» ще не завантажено (upload-references.ts)`);
    for (const [, f] of files) refs.push(`asset:${f.asset_id}`);
  }
  return { refs, missing };
}

export type { Line };
