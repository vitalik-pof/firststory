// Розділ огляду «Фото-референси»: використані фото мініатюрою з автором, ліцензією і джерелом
// (вимога ліцензій з атрибуцією). Якщо art/references-sources.md ще немає, розділ не показується.

import { existsSync } from 'node:fs';
import type { MediaItem } from './review-build';
import { checkSourcesAgainstObjects, parseReferenceSources, parseReferences, photoExists, photoFilePath, photosOf, type ReferenceObject, type ReferenceSource } from './references';
import { paths } from './paths';

export interface PhotoRefBlock {
  object: ReferenceObject;
  usedIn: string[];
  photos: Array<{ source: ReferenceSource; key: string }>;
}

/** usedBy: id об'єкта → де використано («зразок 9», «кадр 5»). */
export function gatherPhotoRefs(usedBy: Map<string, string[]>, media: MediaItem[], warnings: string[]): PhotoRefBlock[] {
  if (!existsSync(paths.referencesSourcesDoc()) || !usedBy.size) return [];
  const objects = parseReferences();
  const sources = parseReferenceSources();
  checkSourcesAgainstObjects(sources, objects);
  const out: PhotoRefBlock[] = [];
  for (const [id, where] of usedBy) {
    const obj = objects.find((o) => o.id === id);
    if (!obj) throw new Error(`Фото-референс «${id}» використано (${where.join(', ')}), але його немає в art/references.md.`);
    const photos = photosOf(sources, id, obj.count).map((s, i) => {
      const key = `ref:${id}/${s.file}`;
      if (photoExists(s)) media.push({ key, kind: 'image', src: photoFilePath(id, s.file), rel: `media/references/${id}-${i + 1}.jpg`, maxWidth: 640 });
      else warnings.push(`Фото-референс ${id}: немає файлу ${paths.rel(photoFilePath(id, s.file))}.`);
      return { source: s, key };
    });
    if (!photos.length) warnings.push(`Фото-референс ${id}: у art/references-sources.md немає записів про фото (потрібна атрибуція).`);
    out.push({ object: obj, usedIn: where, photos });
  }
  return out;
}
