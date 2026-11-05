// Збирання змісту сторінки огляду Етапу 1: читає документи ролей, таймінги, маніфест і файли work/.

import { existsSync, readFileSync } from 'node:fs';
import {
  type CharacterDoc, type ScriptDoc, type SoundDoc, type StoryboardDoc, type StyleDoc, type VoiceDoc, type VoiceEntry,
  type DirectorQuestions, type RoleDecision, parseRoleDecisions, parseDirectorQuestions, parseProducerDecisions,
  checkStoryboardAgainstScript, parseCharacter, parseScript, parseSound, parseStoryboard, parseStyle, parseVoiceMd, parseVoices, storyAuthorName,
} from './docs';
import { frameFile, sheetFile } from './frame-refs';
import { gatherPreviews } from './review-previews';
import { type PhotoRefBlock, gatherPhotoRefs } from './review-refs';
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
  /** Додаткове обмеження ширини для цього файлу (мініатюри). */
  maxWidth?: number;
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
  roleDecisions: RoleDecision[];
  directorQuestions: DirectorQuestions;
  photoRefs: PhotoRefBlock[];
  producerDecisions: string[];
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

  const roleDecisions = parseRoleDecisions(story);
  const directorQuestions = parseDirectorQuestions(story);
  const producerDecisions = parseProducerDecisions(story);

  // Медіа.
  const media: MediaItem[] = [];
  const add = (key: string, kind: MediaItem['kind'], src: string, rel: string): boolean => {
    if (!existsSync(src)) return false;
    media.push({ key, kind, src, rel });
    return true;
  };
  const missingFrames: number[] = [];
  if (storyboard) {
    for (const f of storyboard.frames) {
      const nn = String(f.n).padStart(2, '0');
      if (!add(`frame:${f.n}`, 'image', frameFile(story, f.n), `media/frames/frame-${nn}.jpg`)) missingFrames.push(f.n);
    }
    if (missingFrames.length) warnings.push(`Немає файлів кадрів ${missingFrames.join(', ')} (крок 8): на їхньому місці заглушки.`);
  }
  const missingSheets: string[] = [];
  for (const c of characters) {
    for (const s of c.sheets) {
      if (!add(`sheet:${c.id}/${s.slug}`, 'image', sheetFile(c.id, s.slug), `media/sheets/${s.slug === 'main' ? c.id : `${c.id}--${s.slug}`}.jpg`)) {
        missingSheets.push(`${c.id}${s.label === 'main' ? '' : ` «${s.label}»`}`);
      }
    }
  }
  if (missingSheets.length) warnings.push(`Немає аркушів героїв: ${missingSheets.join(', ')} (крок 7).`);
  const previews = gatherPreviews(story, manifest, add, warnings);
  if (!add('narration', 'audio', paths.workFile(story, 'narration.mp3'), 'media/narration.mp3')) warnings.push('Немає narration.mp3 (крок 6).');
  add('music', 'audio', paths.workFile(story, 'audio', 'music.mp3'), 'media/audio/music.mp3');
  // Повне зведення (scripts/mix-full.ts): аніматик грає його замість голого озвучення; якщо його немає, лишається озвучення.
  add('film-mix', 'audio', paths.workFile(story, 'mix.mp3'), 'media/mix.mp3');
  for (const s of sound?.sfx ?? []) {
    const nn = String(s.n).padStart(2, '0');
    if (!add(`sfx:${s.n}`, 'audio', paths.workFile(story, 'audio', `sfx-${nn}.mp3`), `media/audio/sfx-${nn}.mp3`)) warnings.push(`Шум ${s.n}: немає файлу (крок 10).`);
  }
  if (sound && !media.some((m) => m.key === 'music')) warnings.push('Немає музики (крок 10).');

  const usedBy = new Map<string, string[]>();
  for (const f of storyboard?.frames ?? []) for (const id of f.photoRefs) usedBy.set(id, [...(usedBy.get(id) ?? []), `кадр ${f.n}`]);
  const photoRefs = gatherPhotoRefs(usedBy, media, warnings);
  const name = nameOverride ?? storyAuthorName(story) ?? story;
  return { story, name, script, style, characters, storyboard, voice, voiceMd, sound, timings, manifest, roleDecisions, directorQuestions, photoRefs, producerDecisions, questions, warnings, media, previews };
}
