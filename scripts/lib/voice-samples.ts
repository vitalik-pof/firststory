// Проби голосів v4: розбір stories/<id>/voice-samples.md, цілі вирівнювання з нашого озвучення,
// розрахунок зсувів темпу й висоти, rubberband, хеш проби. Сторінку огляду будує voice-samples-page.ts.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { blockText, fail, readDoc, requireSection, splitByHeading, type Doc } from './md';
import { paths } from './paths';
import { bracketProblem, slugify, sha1, stripTags } from './text';
import type { TimingsFile } from './timings';

export const MODEL_ID = 'eleven_v4';
export const LANGUAGE = 'uk';
export const OUTPUT_FORMAT = 'mp3_44100_128';
/** Межі вирівнювання: далі зсувати вже означає міняти тембр і ламати природність. */
export const MAX_SEMITONES = 4;
export const MAX_TEMPO_DELTA = 0.25;
export const OUT_KBPS = 128;

export interface SampleVoice {
  voiceId: string;
  /** Назва без дужкової примітки. */
  name: string;
  /** Примітка в дужках у кінці рядка, якщо є. */
  note: string;
  line: number;
}

export interface VoiceSamplesDoc {
  doc: Doc;
  /** Заголовок першого рівня без префікса «Проби голосів v4:». */
  title: string;
  /** Текст проби як є, з тегами. */
  text: string;
  voices: SampleVoice[];
}

const VOICE_LINE = /^\s*[-*]\s+`?([A-Za-z0-9]{12,40})`?\s+(?:—|–|-{1,2})\s+(.+?)\s*$/;

export function parseVoiceSamplesText(doc: Doc): VoiceSamplesDoc {
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const h1 = preamble.find((l) => /^#\s+/.test(l.text));
  const title = h1 ? h1.text.replace(/^#\s+/, '').trim() : '';
  const textSec = requireSection(doc, sections, /^Текст\s+проби$/i, 'Текст проби');
  const text = blockText(textSec.body)
    .split('\n')
    .map((l) => l.replace(/^\s*>\s?/, ''))
    .join('\n')
    .trim();
  if (!text) fail(doc, textSec.line, 'Розділ «Текст проби» порожній.');
  const problem = bracketProblem(text);
  if (problem) fail(doc, textSec.line, `У тексті проби неправильні квадратні дужки: ${problem}.`);
  if (!stripTags(text)) fail(doc, textSec.line, 'У тексті проби, крім тегів, немає слів.');

  const voicesSec = requireSection(doc, sections, /^Голоси$/i, 'Голоси');
  const voices: SampleVoice[] = [];
  for (const l of voicesSec.body) {
    if (!l.text.trim()) continue;
    const m = VOICE_LINE.exec(l.text);
    if (!m) fail(doc, l.n, `Рядок розділу «Голоси» має вигляд «- <voice_id> — <назва>», а тут: «${l.text.trim()}».`);
    if (voices.some((v) => v.voiceId === m[1])) fail(doc, l.n, `Голос ${m[1]} уже є в списку.`);
    const label = m[2]!.trim();
    const note = /\s*\(([^()]*)\)\s*$/.exec(label);
    const name = note ? label.slice(0, note.index).trim() : label;
    voices.push({ voiceId: m[1]!, name: name || label, note: note ? note[1]!.trim() : '', line: l.n });
  }
  if (!voices.length) fail(doc, voicesSec.line, 'У розділі «Голоси» немає жодного голосу.');
  return { doc, title: title.replace(/^Проби\s+голосів\s+v4\s*:?\s*/i, '').trim(), text, voices };
}

export function parseVoiceSamples(story: string): VoiceSamplesDoc {
  return parseVoiceSamplesText(readDoc(paths.storyFile(story, 'voice-samples.md'), 'voice-director'));
}

/** Голоси для проб: наш нинішній першим (його додаємо, якщо режисер не вказав), у кожного унікальний slug. */
export interface PlannedVoice extends SampleVoice {
  slug: string;
  current: boolean;
}

export function planVoices(voices: SampleVoice[], currentId: string, currentName: string): PlannedVoice[] {
  const list: SampleVoice[] = [...voices];
  const at = list.findIndex((v) => v.voiceId === currentId);
  const cur = at >= 0 ? list.splice(at, 1)[0]! : { voiceId: currentId, name: currentName, note: 'наш нинішній голос', line: 0 };
  const ordered = [cur, ...list];
  const used = new Set<string>();
  return ordered.map((v, i) => {
    let slug = i === 0 ? 'current' : slugify(v.name).slice(0, 40) || v.voiceId.slice(0, 8).toLowerCase();
    if (used.has(slug)) slug = `${slug}-${v.voiceId.slice(0, 6).toLowerCase()}`;
    used.add(slug);
    return { ...v, slug, current: i === 0 };
  });
}

// ------------------------------------------------------------------ параметри запиту й кеш

export interface TtsParams {
  model_id: string;
  language_code: string;
  output_format: string;
  voice_settings?: Record<string, number>;
}

/** Хеш проби: голос, текст і всі параметри синтезу. Інший голос, текст чи параметр дає іншу пробу. */
export function sampleHash(voiceId: string, text: string, params: TtsParams): string {
  return sha1(JSON.stringify({ voiceId, text, params })).slice(0, 10);
}

// ------------------------------------------------------------------ цілі з нашого озвучення

export interface Targets {
  /** Знаків (без тегів) на секунду мовлення. */
  paceCps: number;
  paceChars: number;
  paceSeconds: number;
  f0Hz: number;
  narrationFile: string;
}

/**
 * Темп нашого озвучення: знаки тексту фрагментів на суму тривалостей фрагментів
 * (від першого слова до останнього; паузи між фрагментами не входять).
 */
export function paceFromTimings(t: Pick<TimingsFile, 'fragments'>): { cps: number; chars: number; seconds: number } {
  let chars = 0;
  let seconds = 0;
  for (const f of t.fragments) {
    chars += f.text.length;
    seconds += f.end - f.start;
  }
  if (seconds <= 0) throw new Error('У timings.json нульова сумарна тривалість фрагментів: темп порахувати не можна.');
  return { cps: chars / seconds, chars, seconds };
}

export function readTimings(story: string): TimingsFile {
  const file = paths.timings(story);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TimingsFile;
  } catch (e) {
    throw new Error(`Не вдалося прочитати ${paths.rel(file)}: ${(e as Error).message}. Спершу озвучення (narrate.ts).`);
  }
}

// ------------------------------------------------------------------ зсуви

/** Темп проби: знаки без тегів на секунду мовлення. */
export function samplePace(text: string, speechSeconds: number): number {
  return speechSeconds > 0 ? stripTags(text).length / speechSeconds : 0;
}

export interface ShiftPlan {
  /** Бажаний зсув висоти, півтони (0, якщо F0 не виміряно). */
  requestedSemitones: number;
  appliedSemitones: number;
  pitchClamped: boolean;
  /** Бажаний множник темпу (>1 швидше). */
  requestedTempo: number;
  appliedTempo: number;
  tempoClamped: boolean;
  /** Множник висоти для rubberband. */
  pitchRatio: number;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function planShift(measured: { f0Hz: number | null; paceCps: number }, target: { f0Hz: number; paceCps: number }): ShiftPlan {
  const notes: string[] = [];
  let requestedSemitones = 0;
  if (measured.f0Hz && measured.f0Hz > 0) requestedSemitones = 12 * Math.log2(target.f0Hz / measured.f0Hz);
  else notes.push('F0 проби виміряти не вдалося: висоту не змінювали');
  const appliedSemitones = clamp(requestedSemitones, -MAX_SEMITONES, MAX_SEMITONES);
  const pitchClamped = Math.abs(requestedSemitones) > MAX_SEMITONES + 1e-9;
  if (pitchClamped) notes.push(`потрібен зсув висоти ${requestedSemitones.toFixed(1)} пт, обмежено до ${appliedSemitones > 0 ? '+' : '-'}${MAX_SEMITONES} пт`);

  let requestedTempo = 1;
  if (measured.paceCps > 0) requestedTempo = target.paceCps / measured.paceCps;
  else notes.push('темп проби виміряти не вдалося: темп не змінювали');
  const appliedTempo = clamp(requestedTempo, 1 - MAX_TEMPO_DELTA, 1 + MAX_TEMPO_DELTA);
  const tempoClamped = Math.abs(requestedTempo - appliedTempo) > 1e-9;
  if (tempoClamped) notes.push(`потрібна зміна темпу ×${requestedTempo.toFixed(2)}, обмежено до ×${appliedTempo.toFixed(2)}`);

  return {
    requestedSemitones, appliedSemitones, pitchClamped, requestedTempo, appliedTempo, tempoClamped,
    pitchRatio: 2 ** (appliedSemitones / 12), notes,
  };
}

/** Фільтр ffmpeg rubberband: темп і висота разом, форманта зберігається (тембр не міняється). */
export function rubberbandFilter(plan: Pick<ShiftPlan, 'appliedTempo' | 'pitchRatio'>): string {
  return `rubberband=tempo=${plan.appliedTempo.toFixed(6)}:pitch=${plan.pitchRatio.toFixed(6)}:formant=preserved:pitchq=quality`;
}

/** Вирівнює файл: rubberband (за потреби) і MP3 128 кбіт/с. */
export function alignFile(input: string, output: string, plan: Pick<ShiftPlan, 'appliedTempo' | 'pitchRatio'>): void {
  const trivial = Math.abs(plan.appliedTempo - 1) < 1e-4 && Math.abs(plan.pitchRatio - 1) < 1e-4;
  const args = ['-y', '-v', 'error', '-i', input, '-vn'];
  if (!trivial) args.push('-af', rubberbandFilter(plan));
  args.push('-codec:a', 'libmp3lame', '-b:a', `${OUT_KBPS}k`, output);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg (rubberband) не зміг вирівняти ${input}: ${r.stderr}`);
}
