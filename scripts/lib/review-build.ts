// Збирання змісту сторінки огляду Етапу 1: читає документи ролей, таймінги, маніфест і файли work/.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  type CharacterDoc, type ScriptDoc, type SoundDoc, type StoryboardDoc, type StyleDoc, type VoiceDoc, type VoiceEntry,
  checkStoryboardAgainstScript, parseCharacter, parseScript, parseSound, parseStoryboard, parseStyle, parseVoiceMd, parseVoices, storyAuthorName,
} from './docs';
import { frameFile, sheetFile } from './frame-refs';
import { type Manifest, readManifest } from './manifest';
import { type Role, extractQuestions, readDoc, splitByHeading, blockText } from './md';
import { paths } from './paths';
import type { TimingsFile } from './timings';

export interface MediaItem {
  /** Ключ для зв'язку з HTML: frame:3, sheet:natalia/2014, preview:1, narration, music, sfx:2. */
  key: string;
  kind: 'image' | 'audio';
  src: string;
  /** Відносний шлях усередині теки сторінки, наприклад media/frames/frame-03.jpg. */
  rel: string;
}

export interface QuestionBlock {
  role: Role;
  file: string;
  text: string;
}

export interface ReviewData {
  story: string;
  name: string;
  script: ScriptDoc;
  style?: StyleDoc;
  characters: CharacterDoc[];
  storyboard?: StoryboardDoc;
  voice?: VoiceEntry;
  voiceMd?: VoiceDoc;
  sound?: SoundDoc;
  timings?: TimingsFile;
  manifest: Manifest;
  roleDecisions: string;
  questions: QuestionBlock[];
  warnings: string[];
  media: MediaItem[];
  previews: Array<{ n: number; key: string; chosen: boolean }>;
}

/** Імена в заголовку без двокрапок і тире. */
export function titleName(raw: string): string {
  return raw.replace(/[:：–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tryRead<T>(warnings: string[], what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.name === 'MissingDocError') {
      warnings.push(`${what}: ${e.message}`);
      return undefined;
    }
    throw e;
  }
}

export function gatherReview(story: string, nameOverride?: string): ReviewData {
  const warnings: string[] = [];
  const script = parseScript(story);
  const style = tryRead(warnings, 'Стиль', () => parseStyle());
  const storyboard = tryRead(warnings, 'Розкадровка', () => parseStoryboard(story));
  if (storyboard) checkStoryboardAgainstScript(story, storyboard, script);
  const heroIds = storyboard ? [...new Set(storyboard.frames.flatMap((f) => f.heroes.map((h) => h.id)))] : [];
  const characters: CharacterDoc[] = [];
  for (const id of heroIds) {
    const c = tryRead(warnings, `Герой ${id}`, () => parseCharacter(id));
    if (c) characters.push(c);
  }
  const voiceMd = tryRead(warnings, 'Розмітка озвучення', () => parseVoiceMd(story));
  const voicesDoc = tryRead(warnings, 'Голоси', () => parseVoices());
  const voice = voicesDoc?.voices.find((v) => v.id === voiceMd?.voiceId) ?? voicesDoc?.voices.find((v) => v.story === story);
  const sound = tryRead(warnings, 'Звук', () => parseSound(story));
  const timingsFile = paths.timings(story);
  const timings = existsSync(timingsFile) ? (JSON.parse(readFileSync(timingsFile, 'utf8')) as TimingsFile) : undefined;
  if (!timings) warnings.push('Немає timings.json: аніматик недоступний (крок 6).');
  const manifest = readManifest(story);

  // Питання ролей: розділи «Питання» з усіх файлів.
  const questions: QuestionBlock[] = [];
  const addQ = (role: Role, file: string, role2: Role = role): void => {
    if (!existsSync(file)) return;
    const text = extractQuestions(readDoc(file, role2));
    if (text) questions.push({ role, file: paths.rel(file), text });
  };
  addQ('scenarist', paths.storyFile(story, 'script.md'));
  addQ('art-director', paths.styleDoc());
  for (const id of heroIds) addQ('art-director', paths.characterDoc(id));
  addQ('art-director', paths.storyFile(story, 'storyboard.md'));
  addQ('voice-director', paths.voicesDoc());
  addQ('voice-director', paths.storyFile(story, 'voice.md'));
  addQ('composer', paths.storyFile(story, 'sound.md'));
  addQ('editor', paths.storyFile(story, 'edit.md'));

  // Рішення ролей замість режисера (status.md).
  let roleDecisions = '';
  const statusFile = paths.storyFile(story, 'status.md');
  if (existsSync(statusFile)) {
    const d = readDoc(statusFile, 'scenarist');
    const sec = splitByHeading(d.lines, 2).sections.find((s) => /^Рішення ролей замість режисера/i.test(s.title));
    roleDecisions = sec ? blockText(sec.body) : '';
  }

  // Медіа.
  const media: MediaItem[] = [];
  const add = (key: string, kind: MediaItem['kind'], src: string, rel: string): boolean => {
    if (!existsSync(src)) return false;
    media.push({ key, kind, src, rel });
    return true;
  };
  if (storyboard) {
    for (const f of storyboard.frames) {
      const nn = String(f.n).padStart(2, '0');
      if (!add(`frame:${f.n}`, 'image', frameFile(story, f.n), `media/frames/frame-${nn}.jpg`)) warnings.push(`Кадр ${f.n}: немає файлу ${paths.rel(frameFile(story, f.n))}.`);
    }
  }
  for (const c of characters) {
    for (const s of c.sheets) {
      if (!add(`sheet:${c.id}/${s.slug}`, 'image', sheetFile(c.id, s.slug), `media/sheets/${s.slug === 'main' ? c.id : `${c.id}--${s.slug}`}.jpg`)) {
        warnings.push(`Аркуш ${c.id}/${s.label}: немає файлу ${paths.rel(sheetFile(c.id, s.slug))}.`);
      }
    }
  }
  const previews: ReviewData['previews'] = [];
  const pdir = paths.workFile(story, 'voice-previews');
  const picked = (manifest.voice?.picked_preview as number | undefined) ?? 1;
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir).filter((x) => /^preview-\d+\.mp3$/.test(x)).sort()) {
      const n = Number(/\d+/.exec(f)![0]);
      add(`preview:${n}`, 'audio', `${pdir}/${f}`, `media/voice/preview-${n}.mp3`);
      previews.push({ n, key: `preview:${n}`, chosen: n === picked });
    }
  }
  if (!previews.length) warnings.push('Немає проб голосу у work/<id>/voice-previews/ (крок 5).');
  if (!add('narration', 'audio', paths.workFile(story, 'narration.mp3'), 'media/narration.mp3')) warnings.push('Немає narration.mp3 (крок 6).');
  add('music', 'audio', paths.workFile(story, 'audio', 'music.mp3'), 'media/audio/music.mp3');
  for (const s of sound?.sfx ?? []) {
    const nn = String(s.n).padStart(2, '0');
    if (!add(`sfx:${s.n}`, 'audio', paths.workFile(story, 'audio', `sfx-${nn}.mp3`), `media/audio/sfx-${nn}.mp3`)) warnings.push(`Шум ${s.n}: немає файлу (крок 10).`);
  }
  if (sound && !media.some((m) => m.key === 'music')) warnings.push('Немає музики (крок 10).');

  const name = nameOverride ?? storyAuthorName(story) ?? story;
  return { story, name, script, style, characters, storyboard, voice, voiceMd, sound, timings, manifest, roleDecisions, questions, warnings, media, previews };
}
