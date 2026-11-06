// Шляхи проєкту. Корінь репозиторію — на два рівні вище за scripts/lib.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Для тестів: можна підмінити корінь (тимчасова копія проєкту). */
let root = process.env.FIRSTSTORY_ROOT ? resolve(process.env.FIRSTSTORY_ROOT) : REPO_ROOT;
export function setRoot(newRoot: string): void {
  root = resolve(newRoot);
}
export function getRoot(): string {
  return root;
}

/** Мова за замовчуванням: українська лежить у корені теки історії й корені work/<id>/. */
export const DEFAULT_LANG = 'uk';

/**
 * Код мовної версії: два-три малі літери (`en`, `fr`, `de`); без коду це українська.
 * Невідомий формат (наприклад, `../x`) відхиляється, бо код стає ім'ям теки.
 */
export function normalizeLang(lang?: string): string {
  const l = (lang ?? DEFAULT_LANG).trim();
  if (!/^[a-z]{2,3}$/.test(l)) throw new Error(`Некоректний код мови «${lang}»: очікується два-три малі латинські літери (uk, en, fr, de).`);
  return l;
}
export const isDefaultLang = (lang?: string): boolean => normalizeLang(lang) === DEFAULT_LANG;

export const paths = {
  storyDir: (story: string) => join(root, 'stories', story),
  storyFile: (story: string, name: string) => join(root, 'stories', story, name),
  /** Тека мовної версії: stories/<id>/<код> (для української це корінь stories/<id>). */
  langDir: (story: string, lang?: string) => (isDefaultLang(lang) ? join(root, 'stories', story) : join(root, 'stories', story, normalizeLang(lang))),
  langFile: (story: string, lang: string | undefined, name: string) => join(paths.langDir(story, lang), name),
  manifest: (story: string) => join(root, 'stories', story, 'manifest.json'),
  timings: (story: string, lang?: string) => join(paths.langDir(story, lang), 'timings.json'),
  workDir: (story: string) => join(root, 'work', story),
  workFile: (story: string, ...parts: string[]) => join(root, 'work', story, ...parts),
  /** Тека медіа мовної версії: work/<id>/<код> (для української це корінь work/<id>). */
  workLangDir: (story: string, lang?: string) => (isDefaultLang(lang) ? join(root, 'work', story) : join(root, 'work', story, normalizeLang(lang))),
  workLangFile: (story: string, lang: string | undefined, ...parts: string[]) => join(paths.workLangDir(story, lang), ...parts),
  charactersWork: () => join(root, 'work', 'characters'),
  characterDoc: (id: string) => join(root, 'characters', `${id}.md`),
  voicesDoc: () => join(root, 'voices.md'),
  styleDoc: () => join(root, 'art', 'style.md'),
  referencesDoc: () => join(root, 'art', 'references.md'),
  referencesSourcesDoc: () => join(root, 'art', 'references-sources.md'),
  referencesWork: (id?: string) => (id ? join(root, 'work', 'references', id) : join(root, 'work', 'references')),
  samplesDoc: () => join(root, 'art', 'samples.md'),
  soundSamplesDoc: (story: string) => join(root, 'stories', story, 'sound-samples.md'),
  rel: (abs: string) => (abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs),
};

export function assertStoryExists(story: string): void {
  if (!/^[\w.-]+$/.test(story)) throw new Error(`Некоректний id історії: «${story}»`);
  if (!existsSync(paths.storyDir(story))) throw new Error(`Не знайдено теку stories/${story}`);
}
