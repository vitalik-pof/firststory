// Референси кадрів: аркуші героїв (за рядком «Герої:» розкадровки) і винятки з
// необов'язкового stories/<id>/frame-refs.json:
//   {"2": [], "4": ["frame:3"], "9": ["natalia:2014"]}
// Ключ — номер кадру, значення — список референсів ЗАМІСТЬ стандартних. «frame:N» — готова
// картинка кадру N, «<герой>[:версія]» — аркуш героя. Порожній список — кадр без референсів.

import { existsSync, readFileSync } from 'node:fs';
import { type CharacterDoc, type HeroRef, type StoryboardFrame, findSheet, listCharacterIds, parseCharacter } from './docs';
import { readManifest } from './manifest';
import { paths } from './paths';
import { slugify } from './text';

export type FrameRefsFile = Record<string, string[]>;

export function loadFrameRefs(story: string, frameNumbers: number[]): FrameRefsFile {
  const file = paths.storyFile(story, 'frame-refs.json');
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${paths.rel(file)} не є коректним JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${paths.rel(file)}: очікується об'єкт {"<номер кадру>": [референси]}.`);
  const out: FrameRefsFile = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !frameNumbers.includes(Number(k))) throw new Error(`${paths.rel(file)}: ключ «${k}» не є номером кадру з розкадровки.`);
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${paths.rel(file)}: для кадру ${k} очікується масив рядків.`);
    out[k] = v as string[];
  }
  return out;
}

export function sheetKey(heroId: string, slug: string): string {
  return `sheet/${heroId}/${slug}`;
}

export function sheetFile(heroId: string, slug: string): string {
  return `${paths.charactersWork()}/${slug === 'main' ? heroId : `${heroId}--${slug}`}.png`;
}

export function frameKey(n: number): string {
  return `frame/${String(n).padStart(2, '0')}`;
}

export function frameFile(story: string, n: number): string {
  return paths.workFile(story, 'frames', `frame-${String(n).padStart(2, '0')}.png`);
}

export interface ResolvedRefs {
  refs: string[];
  /** Кадри, які мають бути згенеровані раніше. */
  deps: number[];
  /** Чого бракує для справжнього запуску (id ресурсу, готовий кадр). */
  missing: string[];
}

export class CharacterCache {
  private docs = new Map<string, CharacterDoc>();
  get(id: string, where: string): CharacterDoc {
    let d = this.docs.get(id);
    if (!d) {
      if (!listCharacterIds().includes(id)) throw new Error(`${where}: невпізнаний герой «${id}» (немає characters/${id}.md; є: ${listCharacterIds().join(', ')}).`);
      d = parseCharacter(id);
      this.docs.set(id, d);
    }
    return d;
  }
}

function assetOf(doc: CharacterDoc, label: string): string | undefined {
  return doc.resources.find((r) => r.label.toLowerCase() === label.toLowerCase())?.assetId;
}

function heroRefToAsset(cache: CharacterCache, ref: HeroRef, where: string, out: ResolvedRefs): void {
  const doc = cache.get(ref.id, where);
  const sheet = findSheet(doc, ref.version, where);
  const asset = assetOf(doc, sheet.label);
  if (asset) out.refs.push(`asset:${asset}`);
  else out.missing.push(`аркуш ${ref.id}${sheet.label === 'main' ? '' : ` «${sheet.label}»`} ще не завантажено (upload-character-sheet)`);
}

export function resolveFrameRefs(story: string, frame: StoryboardFrame, overrides: FrameRefsFile, cache: CharacterCache): ResolvedRefs {
  const out: ResolvedRefs = { refs: [], deps: [], missing: [] };
  const where = `Кадр ${frame.n}`;
  const override = overrides[String(frame.n)];
  const manifest = readManifest(story);
  if (override) {
    for (const item of override) {
      const fm = /^frame:(\d+)$/.exec(item);
      if (fm) {
        const n = Number(fm[1]);
        if (n === frame.n) throw new Error(`${where}: frame-refs.json посилається на сам себе.`);
        out.deps.push(n);
        const gid = manifest.images[frameKey(n)]?.current?.generation_id;
        if (gid) out.refs.push(`generation:${gid}`);
        else out.missing.push(`кадр ${n} ще не згенеровано (референс для кадру ${frame.n})`);
        continue;
      }
      const hm = /^([\w-]+?)(?::(.+))?$/.exec(item);
      if (!hm) throw new Error(`${where}: frame-refs.json: незрозумілий референс «${item}» (очікується «frame:N» чи «герой:версія»).`);
      heroRefToAsset(cache, { id: hm[1]!, version: hm[2] }, `${where} (frame-refs.json)`, out);
    }
  } else {
    for (const h of frame.heroes) heroRefToAsset(cache, h, `${where}, «Герої:»`, out);
  }
  return out;
}

/** Порядок генерації: залежні кадри після тих, від яких залежать. Цикл — помилка. */
export function orderFrames(frames: StoryboardFrame[], depsOf: (n: number) => number[]): StoryboardFrame[] {
  const byN = new Map(frames.map((f) => [f.n, f]));
  const done = new Set<number>();
  const visiting = new Set<number>();
  const out: StoryboardFrame[] = [];
  const visit = (n: number): void => {
    if (done.has(n)) return;
    if (visiting.has(n)) throw new Error(`Цикл залежностей між кадрами через frame-refs.json (кадр ${n}).`);
    visiting.add(n);
    for (const d of depsOf(n)) {
      if (!byN.has(d)) throw new Error(`Кадр ${n} залежить від кадру ${d}, якого немає в розкадровці.`);
      visit(d);
    }
    visiting.delete(n);
    done.add(n);
    out.push(byN.get(n)!);
  };
  for (const f of frames) visit(f.n);
  return out;
}

export function composePrompt(scene: string, style: string): string {
  return `${scene.trim()}\n\n${style.trim()}`;
}

export { slugify };
