// Маніфест stories/<id>/manifest.json: що згенеровано, id ресурсів, лічильники
// перегенерацій, фактичні витрати кредитів. Запис атомарний (tmp + rename), і
// невідомі поля (наприклад, посилання на Drive з кроку 14) завжди зберігаються.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDefaultLang, normalizeLang, paths } from './paths';

export interface ImageVersion {
  generation_id: string;
  model_id?: string;
  prompt: string;
  refs: string[];
  file: string;
  aspect_ratio: string;
  resolution: string;
  credits: number | null;
  /** Фактичні розміри файлу в пікселях (запитана роздільність може не застосуватися). */
  width?: number;
  height?: number;
  completed_at: string;
}

export interface PendingImage {
  kind: 'initial' | 'regen' | 'upgrade';
  status: 'requested' | 'created';
  prompt: string;
  refs: string[];
  aspect_ratio: string;
  resolution: string;
  generation_id?: string;
  requested_at: string;
}

export interface ImageRecord {
  current?: ImageVersion;
  history: ImageVersion[];
  regen_count: number;
  pending?: PendingImage;
}

export interface RunRecord {
  script: string;
  started_at: string;
  finished_at?: string;
  credits_before: number;
  credits_after?: number;
  /** Різниця лічильника за запуск; може враховувати чужі витрати на акаунті. */
  spent_run?: number;
}

export interface Manifest {
  story: string;
  updated_at?: string;
  credits: { total_spent: number; runs: RunRecord[] };
  voice?: Record<string, unknown>;
  narration?: Record<string, unknown>;
  images: Record<string, ImageRecord>;
  assets: Record<string, Record<string, unknown>>;
  audio: Record<string, Record<string, unknown>>;
  /** Виміряна ціна картинки окремо для кожної пари «модель@роздільність». */
  image_prices?: Record<string, { max: number; last: number; count: number }>;
  /** Фактичні розміри перших згенерованих картинок для пари «модель@роздільність@формат». */
  image_sizes?: Record<string, { width: number; height: number; file: string }>;
  [k: string]: unknown;
}

/**
 * Ключ запису озвучення в маніфесті: `narration` для української, `narration_<код>` для інших мов
 * (запис однієї мови не затирає інший).
 */
export function narrationKey(lang?: string): string {
  return isDefaultLang(lang) ? 'narration' : `narration_${normalizeLang(lang)}`;
}

/** Усі ключі озвучення, що є в маніфесті (`narration`, `narration_en`, …). */
export function narrationKeys(m: Record<string, unknown>): string[] {
  return Object.keys(m).filter((k) => /^narration(_[a-z]{2,3})?$/.test(k));
}

export function emptyManifest(story: string): Manifest {
  return { story, credits: { total_spent: 0, runs: [] }, images: {}, assets: {}, audio: {} };
}

export function readManifest(story: string): Manifest {
  const file = paths.manifest(story);
  if (!existsSync(file)) return emptyManifest(story);
  let raw: Partial<Manifest>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>;
  } catch (e) {
    throw new Error(`${paths.rel(file)} не є коректним JSON: ${(e as Error).message}`);
  }
  const m = { ...emptyManifest(story), ...raw } as Manifest;
  m.credits = { total_spent: raw.credits?.total_spent ?? 0, runs: raw.credits?.runs ?? [] };
  m.images ??= {};
  m.assets ??= {};
  m.audio ??= {};
  return m;
}

export function writeManifest(story: string, m: Manifest): void {
  const file = paths.manifest(story);
  mkdirSync(dirname(file), { recursive: true });
  m.updated_at = new Date().toISOString();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Читає свіжу версію, застосовує зміну, записує. Викликати після кожного платного кроку. */
export function updateManifest(story: string, fn: (m: Manifest) => void): Manifest {
  const m = readManifest(story);
  fn(m);
  writeManifest(story, m);
  return m;
}

export function addCredits(story: string, spent: number): void {
  if (spent > 0) updateManifest(story, (m) => void (m.credits.total_spent += spent));
}
