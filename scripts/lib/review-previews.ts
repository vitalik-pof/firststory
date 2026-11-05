// Проби голосу для сторінки огляду (спільне для огляду Етапу 1 і огляду зразків).
// Список проб беремо з маніфесту (manifest.voice.previews) і з файлів у work/<id>/voice-previews/.
// Якщо файлу проби немає (ElevenLabs зберігає лише обрану пробу), проба лишається в списку,
// а сторінка показує на її місці текст «файл недоступний»: див. renderVoiceBody.

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Manifest } from './manifest';
import { getRoot, paths } from './paths';

export interface PreviewRef {
  n: number;
  key: string;
  chosen: boolean;
}

export function gatherPreviews(
  story: string,
  manifest: Manifest,
  add: (key: string, kind: 'audio', src: string, rel: string) => boolean,
  warnings: string[],
): PreviewRef[] {
  const voice = manifest.voice as { picked_preview?: number; previews?: Array<{ n: number; file?: string }> } | undefined;
  const picked = voice?.picked_preview ?? 1;
  const files = new Map<number, string>();
  for (const p of voice?.previews ?? []) files.set(p.n, p.file ? resolve(getRoot(), p.file) : paths.workFile(story, 'voice-previews', `preview-${p.n}.mp3`));
  const pdir = paths.workFile(story, 'voice-previews');
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir).filter((x) => /^preview-\d+\.mp3$/.test(x))) {
      const n = Number(/\d+/.exec(f)![0]);
      if (!files.has(n) || !existsSync(files.get(n)!)) files.set(n, `${pdir}/${f}`);
    }
  }
  const previews: PreviewRef[] = [];
  const missing: number[] = [];
  for (const n of [...files.keys()].sort((a, b) => a - b)) {
    if (!add(`preview:${n}`, 'audio', files.get(n)!, `media/voice/preview-${n}.mp3`)) missing.push(n);
    previews.push({ n, key: `preview:${n}`, chosen: n === picked });
  }
  if (!previews.length) warnings.push('Немає проб голосу у work/<id>/voice-previews/ (крок 5).');
  else if (missing.length) warnings.push(`Проби голосу ${missing.join(', ')}: файлів немає (ElevenLabs зберігає лише обрану пробу; спроба відновлення: restore-media.ts), на сторінці замість них текст «файл недоступний».`);
  return previews;
}
