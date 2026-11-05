// Проби голосів: файли, кеш у маніфесті, вирівнювання, summary.json і сторінка. Усе тут безкоштовне
// й локальне (платний виклик озвучення робить сам скрипт через спільний клієнт).

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeMp3, probeDuration } from './audio';
import { log } from './log';
import { readManifest, updateManifest } from './manifest';
import { getRoot, paths } from './paths';
import { decodeMono, measureFile, measureSamples } from './pitch';
import { renderPage, pageTitle, type PageVoice } from './voice-samples-page';
import {
  LANGUAGE, MAX_SEMITONES, MAX_TEMPO_DELTA, MODEL_ID, OUTPUT_FORMAT, alignFile, paceFromTimings, planShift, readTimings, sampleHash, samplePace,
  type PlannedVoice, type ShiftPlan, type Targets, type TtsParams, type VoiceSamplesDoc,
} from './voice-samples';
import { stripTags } from './text';

export const PAGE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Запас під розмір HTML і похибки: якщо файли ближче до межі, сирі проби на сторінці стискаємо. */
const PAGE_SAFE_BYTES = 15.2 * 1024 * 1024;

export interface CachedSample {
  hash: string;
  slug: string;
  voice_id: string;
  name: string;
  raw_file: string;
  response_file: string;
  chars_sent: number;
  credits: number;
  credits_source: 'history' | 'counter';
  generated_at: string;
}

export const dirs = (story: string) => {
  const dir = paths.workFile(story, 'voice-samples');
  return { dir, raw: join(dir, 'raw') };
};

export function ttsParams(extra?: { stability?: number }): TtsParams {
  const p: TtsParams = { model_id: MODEL_ID, language_code: LANGUAGE, output_format: OUTPUT_FORMAT };
  if (extra?.stability !== undefined) p.voice_settings = { stability: extra.stability };
  return p;
}

export function ttsBody(text: string, params: TtsParams): Record<string, unknown> {
  const body: Record<string, unknown> = { text, model_id: params.model_id, language_code: params.language_code };
  if (params.voice_settings) body.voice_settings = params.voice_settings;
  return body;
}

export function cachedItems(story: string): Record<string, CachedSample> {
  return ((readManifest(story).voice_samples as { items?: Record<string, CachedSample> } | undefined)?.items ?? {}) as Record<string, CachedSample>;
}

export function cacheEntry(story: string, v: PlannedVoice, text: string, params: TtsParams): { hash: string; item?: CachedSample } {
  const hash = sampleHash(v.voiceId, text, params);
  const item = cachedItems(story)[hash];
  const ok = item && existsSync(join(getRoot(), item.raw_file));
  return { hash, item: ok ? item : undefined };
}

/** Записує пробу в маніфест; старі записи цього slug прибираються (на диску лежить лише остання проба slug). */
export function recordSample(story: string, item: CachedSample, params: TtsParams): void {
  updateManifest(story, (m) => {
    const prev = (m.voice_samples ?? {}) as { items?: Record<string, CachedSample> };
    const items: Record<string, CachedSample> = {};
    for (const [k, v] of Object.entries(prev.items ?? {})) if (v.slug !== item.slug) items[k] = v;
    items[item.hash] = item;
    m.voice_samples = { ...prev, model_id: params.model_id, language_code: params.language_code, output_format: params.output_format, items };
  });
}

export async function computeTargets(story: string, override: { f0?: number; pace?: number } = {}): Promise<Targets> {
  const t = readTimings(story);
  const pace = paceFromTimings(t);
  const narration = t.audio_file ? join(getRoot(), t.audio_file) : paths.workFile(story, 'narration.mp3');
  let f0 = override.f0;
  if (f0 === undefined) {
    if (!existsSync(narration)) throw new Error(`Немає ${paths.rel(narration)}: висоту нашого голосу виміряти нема з чого (або задайте --target-f0 Гц).`);
    log(`Міряємо висоту нашого озвучення (${paths.rel(narration)})…`);
    const m = measureFile(narration);
    if (m.f0.hz === null) throw new Error(`У ${paths.rel(narration)} не знайдено озвученого мовлення: F0 не виміряно.`);
    f0 = m.f0.hz;
  }
  return { paceCps: override.pace ?? pace.cps, paceChars: pace.chars, paceSeconds: pace.seconds, f0Hz: f0, narrationFile: paths.rel(narration) };
}

export interface VoiceSummary {
  id: string;
  name: string;
  note: string;
  slug: string;
  current: boolean;
  f0_before_hz: number | null;
  f0_after_hz: number | null;
  pace_before_cps: number;
  pace_after_cps: number;
  shifts: {
    semitones_requested: number;
    semitones_applied: number;
    pitch_clamped: boolean;
    tempo_requested: number;
    tempo_applied: number;
    tempo_clamped: boolean;
    notes: string[];
  };
  duration_sec: number;
  raw_duration_sec: number;
  credits: number;
  credits_source: string;
  aligned_file: string;
  raw_file: string;
}

export interface AssembleResult {
  summaryFile: string;
  indexFile: string;
  voices: VoiceSummary[];
  skipped: Array<{ name: string; reason: string }>;
  pageBytes: number;
  rawRecompressed: boolean;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function shiftSummary(p: ShiftPlan): VoiceSummary['shifts'] {
  return {
    semitones_requested: r2(p.requestedSemitones), semitones_applied: r2(p.appliedSemitones), pitch_clamped: p.pitchClamped,
    tempo_requested: r3(p.requestedTempo), tempo_applied: r3(p.appliedTempo), tempo_clamped: p.tempoClamped, notes: p.notes,
  };
}

/**
 * Вирівнює всі проби, які є на диску, пише summary.json і index.html. Безкоштовно.
 * Голоси без проби (не озвучено чи збій) потрапляють у skipped.
 */
export function assembleSamples(a: {
  story: string; doc: VoiceSamplesDoc; voices: PlannedVoice[]; params: TtsParams; targets: Targets; failures?: Map<string, string>;
}): AssembleResult {
  const { dir, raw } = dirs(a.story);
  mkdirSync(raw, { recursive: true });
  const summaries: VoiceSummary[] = [];
  const pageVoices: PageVoice[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const v of a.voices) {
    const { item } = cacheEntry(a.story, v, a.doc.text, a.params);
    if (!item) {
      skipped.push({ name: v.name, reason: a.failures?.get(v.voiceId) ?? 'ще не озвучено' });
      continue;
    }
    const rawFile = join(getRoot(), item.raw_file);
    const alignedFile = join(dir, `${v.slug}.mp3`);
    const before = measureSamples(decodeMono(rawFile));
    const paceBefore = samplePace(a.doc.text, before.span.duration);
    const plan = planShift({ f0Hz: before.f0.hz, paceCps: paceBefore }, { f0Hz: a.targets.f0Hz, paceCps: a.targets.paceCps });
    alignFile(rawFile, alignedFile, plan);
    const after = measureSamples(decodeMono(alignedFile));
    const paceAfter = samplePace(a.doc.text, after.span.duration);
    log(`  ${v.slug}: висота ${before.f0.hz?.toFixed(0) ?? '?'} → ${after.f0.hz?.toFixed(0) ?? '?'} Гц, темп ${paceBefore.toFixed(1)} → ${paceAfter.toFixed(1)} зн/с${plan.notes.length ? ` (${plan.notes.join('; ')})` : ''}`);
    summaries.push({
      id: v.voiceId, name: v.name, note: v.note, slug: v.slug, current: v.current,
      f0_before_hz: before.f0.hz === null ? null : r2(before.f0.hz), f0_after_hz: after.f0.hz === null ? null : r2(after.f0.hz),
      pace_before_cps: r2(paceBefore), pace_after_cps: r2(paceAfter), shifts: shiftSummary(plan),
      duration_sec: r2(probeDuration(alignedFile) ?? after.span.total), raw_duration_sec: r2(probeDuration(rawFile) ?? before.span.total),
      credits: item.credits, credits_source: item.credits_source, aligned_file: paths.rel(alignedFile), raw_file: item.raw_file,
    });
    pageVoices.push({
      name: v.name, note: v.note, current: v.current,
      alignedSrc: `${v.slug}.mp3`, rawSrc: `raw/${v.slug}.mp3`,
      f0Before: before.f0.hz, f0After: after.f0.hz, paceBefore, paceAfter, notes: plan.notes,
    });
  }

  // Розмір сторінки: сирі проби на сторінці стискаємо, лише якщо інакше не вкладаємось у 16 МБ.
  const size = (f: string): number => statSync(f).size;
  const html = (voices: PageVoice[]): string =>
    renderPage({
      title: pageTitle(a.doc.title), textPlain: stripTags(a.doc.text), textTagged: a.doc.text, targetF0: a.targets.f0Hz, targetPace: a.targets.paceCps,
      voices, skipped,
    });
  const total = (voices: PageVoice[]): number =>
    Buffer.byteLength(html(voices)) + voices.reduce((n, v) => n + size(join(dir, v.alignedSrc)) + size(join(dir, v.rawSrc)), 0);
  let rawRecompressed = false;
  let bytes = total(pageVoices);
  if (bytes > PAGE_SAFE_BYTES) {
    log(`Сторінка з файлами ${(bytes / 1048576).toFixed(1)} МБ: стискаємо сирі проби для сторінки до 64 кбіт/с (raw-page/).`);
    mkdirSync(join(dir, 'raw-page'), { recursive: true });
    for (const pv of pageVoices) {
      const slug = pv.rawSrc.replace(/^raw\//, '');
      encodeMp3(join(dir, pv.rawSrc), join(dir, 'raw-page', slug), 64);
      pv.rawSrc = `raw-page/${slug}`;
    }
    rawRecompressed = true;
    bytes = total(pageVoices);
  }
  if (bytes > PAGE_LIMIT_BYTES) log(`УВАГА: сторінка з файлами ${(bytes / 1048576).toFixed(1)} МБ, а ліміт Artifact 16 МБ. Приберіть частину голосів (--only) чи скоротіть текст.`);
  const indexFile = join(dir, 'index.html');
  writeFileSync(indexFile, html(pageVoices));

  const summaryFile = join(dir, 'summary.json');
  const spent = summaries.reduce((n, s) => n + s.credits, 0);
  writeFileSync(
    summaryFile,
    JSON.stringify(
      {
        story: a.story, model_id: a.params.model_id, language_code: a.params.language_code, text: a.doc.text, text_chars_without_tags: stripTags(a.doc.text).length,
        targets: {
          f0_hz: r2(a.targets.f0Hz), pace_cps: r2(a.targets.paceCps), narration_file: a.targets.narrationFile,
          pace_basis: `${a.targets.paceChars} знаків тексту фрагментів / ${r2(a.targets.paceSeconds)} с (сума тривалостей фрагментів за timings.json)`,
        },
        limits: { max_semitones: MAX_SEMITONES, max_tempo_delta: MAX_TEMPO_DELTA },
        credits_total: spent, page_bytes: bytes, raw_recompressed_for_page: rawRecompressed,
        voices: summaries, skipped,
      },
      null,
      2,
    ) + '\n',
  );
  return { summaryFile, indexFile, voices: summaries, skipped, pageBytes: bytes, rawRecompressed };
}
