// Спільне для sound.ts (кроки 10) і sound-samples.ts (Етап 1б): план і генерація музики та шумів.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log';
import { readManifest, updateManifest } from './manifest';
import { paths } from './paths';
import { type Priced, estimateMusic, estimateSfx, fmt } from './pricing';
import type { RunContext } from './run-context';

export interface SoundItem {
  /** Ключ у manifest.audio: music, sfx-1, sample-music-1, sample-sfx-2… */
  id: string;
  label: string;
  file: string;
  seconds: number;
  prompt: string;
  kind: 'music' | 'sfx';
  instrumental?: boolean;
}

export function costOf(it: SoundItem): Priced {
  return it.kind === 'music' ? estimateMusic(it.seconds) : estimateSfx(it.seconds);
}

export function parseIdList(value: string | undefined, known: Set<string>): Set<string> | undefined {
  if (!value) return undefined;
  const set = new Set(value.split(',').map((x) => x.trim()).filter(Boolean));
  for (const id of set) if (!known.has(id)) throw new Error(`Невідомий елемент «${id}» (є: ${[...known].join(', ')}).`);
  return set;
}

/** Що робитиме скрипт з кожним елементом; друкує таблицю й повертає те, що треба генерувати. */
export function planSoundItems(story: string, items: SoundItem[], only: Set<string> | undefined, redo: Set<string> | undefined): { todo: SoundItem[]; total: number } {
  const manifest = readManifest(story);
  const todo: SoundItem[] = [];
  let total = 0;
  for (const it of items) {
    if (only && !only.has(it.id) && !redo?.has(it.id)) continue;
    const done = existsSync(it.file) && manifest.audio[it.id];
    const action = done ? (redo?.has(it.id) ? 'redo' : 'skip') : 'generate';
    const cost = costOf(it);
    log(`  ${it.label.padEnd(12)} ${String(it.seconds).padStart(5)} с  ${action.padEnd(8)} ${fmt(cost)}  → ${paths.rel(it.file)}`);
    if (action !== 'skip') {
      todo.push(it);
      total += cost.credits ?? 0;
    }
  }
  log(`Разом до генерації: ${todo.length} шт., ~${total} кредитів (оцінка з документації; фактичне число запишемо в маніфест).`);
  return { todo, total };
}

export async function runSoundItems(ctx: RunContext, todo: SoundItem[], opts: { outFmt: string; musicModel?: string }): Promise<void> {
  const { client, story } = ctx;
  for (const it of todo) {
    ctx.assertBudget(costOf(it).credits ?? 0, it.label);
    const sp = await client.beginSpend();
    let extra: Record<string, unknown> = {};
    let audio: Buffer;
    if (it.kind === 'music') {
      const body: Record<string, unknown> = { prompt: it.prompt, music_length_ms: Math.round(it.seconds * 1000), force_instrumental: Boolean(it.instrumental) };
      if (opts.musicModel) body.model_id = opts.musicModel;
      const r = await client.composeMusic(body, { output_format: opts.outFmt }, sp.guard);
      audio = r.audio;
      extra = { song_id: r.songId, model_id: opts.musicModel ?? null };
    } else {
      const r = await client.soundEffect({ text: it.prompt, duration_seconds: it.seconds }, { output_format: opts.outFmt }, sp.guard);
      audio = r.audio;
      extra = { character_cost_header: r.characterCost };
    }
    mkdirSync(dirname(it.file), { recursive: true });
    if (existsSync(it.file)) renameSync(it.file, `${it.file}.prev`);
    writeFileSync(it.file, audio);
    const { spent } = await sp.finish();
    ctx.recordSpent(spent);
    updateManifest(story, (m) => {
      const regen = ((m.audio[it.id]?.regen_count as number | undefined) ?? 0) + (m.audio[it.id] ? 1 : 0);
      m.audio[it.id] = { file: paths.rel(it.file), kind: it.kind, seconds_requested: it.seconds, prompt: it.prompt, credits: spent, output_format: opts.outFmt, regen_count: regen, generated_at: new Date().toISOString(), ...extra };
    });
    log(`  ${it.label}: готово → ${paths.rel(it.file)} (${spent} кредитів)`);
  }
}
