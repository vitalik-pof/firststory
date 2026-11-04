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

export const paths = {
  storyDir: (story: string) => join(root, 'stories', story),
  storyFile: (story: string, name: string) => join(root, 'stories', story, name),
  manifest: (story: string) => join(root, 'stories', story, 'manifest.json'),
  timings: (story: string) => join(root, 'stories', story, 'timings.json'),
  workDir: (story: string) => join(root, 'work', story),
  workFile: (story: string, ...parts: string[]) => join(root, 'work', story, ...parts),
  charactersWork: () => join(root, 'work', 'characters'),
  characterDoc: (id: string) => join(root, 'characters', `${id}.md`),
  voicesDoc: () => join(root, 'voices.md'),
  styleDoc: () => join(root, 'art', 'style.md'),
  rel: (abs: string) => (abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs),
};

export function assertStoryExists(story: string): void {
  if (!/^[\w.-]+$/.test(story)) throw new Error(`Некоректний id історії: «${story}»`);
  if (!existsSync(paths.storyDir(story))) throw new Error(`Не знайдено теку stories/${story}`);
}
