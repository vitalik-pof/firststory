// Генерація однієї картинки: створення → опитування → завантаження → запис у маніфест.
// Спільне для аркушів героїв (крок 7) і кадрів (крок 8).
//
// Стан у маніфесті (images[ключ]): current (поточна версія), history (попередні), regen_count,
// pending (генерація в процесі). Правила:
//  - id генерації записується в маніфест одразу після створення, тому повторний запуск
//    продовжує очікування тієї самої генерації і не платить вдруге;
//  - якщо pending.status = requested без id (збій між запитом і відповіддю), скрипт відмовляє,
//    бо генерація могла бути створена: перевірте `elevenlabs flows image list` і запустіть з --ignore-pending;
//  - перегенерація (regen) не більше ніж --max-regens разів (за замовчуванням 1 на Етап 1);
//    лічильник росте тільки після успішного завершення, невдала генерація не рахується.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import { GenerationFailedError } from './elevenlabs';
import { log } from './log';
import { type ImageRecord, type ImageVersion, readManifest, updateManifest } from './manifest';
import { paths } from './paths';
import type { RunContext } from './run-context';

export const IMAGE_MODEL = 'gemini-3.1-flash-image';
export const MAX_REFS = 14;

export interface ImageJob {
  /** Ключ у manifest.images, наприклад «frame/03» чи «sheet/natalia/main». Референси: asset:<id> або generation:<id>. */
  key: string;
  label: string;
  prompt: string;
  refs: string[];
  aspect: string;
  resolution: string;
  /** Абсолютний шлях результату (.png). */
  outFile: string;
  regen: boolean;
  maxRegens: number;
  ignorePending: boolean;
  /** Замінити наявну картинку іншої роздільності (не рахується як перегенерація). */
  upgrade?: boolean;
  /** Очікувана вартість для перевірки ліміту. */
  expectedCredits: number;
}

export type JobAction = 'generate' | 'resume' | 'regen' | 'upgrade' | 'skip' | 'refuse';
export type JobOutcome = 'generated' | 'regenerated' | 'skipped' | 'refused';

/** Референс у маніфесті: «asset:<id>» (аркуш героя) або «generation:<id>» (готовий кадр). */
export function refToApi(ref: string): Record<string, string> {
  const m = /^(asset|generation):(.+)$/.exec(ref);
  if (!m) throw new Error(`Некоректний референс «${ref}» (очікується asset:<id> або generation:<id>).`);
  return m[1] === 'asset' ? { type: 'asset', asset_id: m[2]! } : { type: 'generation', generation_id: m[2]! };
}

export function getRecord(story: string, key: string): ImageRecord | undefined {
  return readManifest(story).images[key];
}

/** Що робитиме скрипт з цією картинкою (для сухого прогону й для реального). */
export function planJob(story: string, job: ImageJob): { action: JobAction; why: string } {
  const rec = getRecord(story, job.key);
  const fileOk = existsSync(job.outFile);
  if (rec?.pending) {
    if (rec.pending.status === 'requested' && !rec.pending.generation_id && !job.ignorePending) {
      return { action: 'refuse', why: 'попередній запуск обірвався між запитом і відповіддю: генерація могла бути створена. Перевірте `elevenlabs flows image list`, потім запустіть з --ignore-pending' };
    }
    if (rec.pending.generation_id) return { action: 'resume', why: `продовжуємо генерацію ${rec.pending.generation_id}` };
  }
  if (rec?.current && fileOk) {
    if (!job.regen) {
      if (rec.current.resolution !== job.resolution) {
        return job.upgrade
          ? { action: 'upgrade', why: `заміна ${rec.current.resolution} на ${job.resolution} (не перегенерація)` }
          : { action: 'skip', why: `вже є в роздільності ${rec.current.resolution}; для ${job.resolution} додайте --upgrade` };
      }
      return { action: 'skip', why: 'вже згенеровано (є в маніфесті і у work/)' };
    }
    if (rec.regen_count >= job.maxRegens) {
      return { action: 'refuse', why: `ліміт перегенерацій вичерпано (${rec.regen_count} з ${job.maxRegens}). Далі тільки за рішенням режисера: --max-regens` };
    }
    return { action: 'regen', why: `перегенерація ${rec.regen_count + 1} з ${job.maxRegens}` };
  }
  if (job.regen) return { action: 'refuse', why: 'перегенерувати нічого: картинки ще немає' };
  if (rec?.current && !fileOk) return { action: 'generate', why: 'у маніфесті є, але файлу у work/ немає: генеруємо заново' };
  return { action: 'generate', why: 'нова генерація' };
}

async function toPng(data: Buffer, contentType: string | null): Promise<Buffer> {
  if (contentType?.includes('png') || (data[0] === 0x89 && data[1] === 0x50)) return data;
  return sharp(data).png().toBuffer();
}

function writeAtomic(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

export async function runImageJob(ctx: RunContext, job: ImageJob): Promise<JobOutcome> {
  const { story, client } = ctx;
  const plan = planJob(story, job);
  if (plan.action === 'skip') {
    log(`  ${job.label}: пропуск, ${plan.why}`);
    return 'skipped';
  }
  if (plan.action === 'refuse') {
    log(`  ${job.label}: ВІДМОВА, ${plan.why}`);
    return 'refused';
  }
  if (job.refs.length > MAX_REFS) throw new Error(`${job.label}: референсів ${job.refs.length}, максимум ${MAX_REFS}.`);

  let pendingId: string | undefined = getRecord(story, job.key)?.pending?.generation_id;
  if (!pendingId) {
    ctx.assertBudget(job.expectedCredits, job.label);
    const kind = plan.action === 'regen' ? 'regen' : plan.action === 'upgrade' ? 'upgrade' : 'initial';
    updateManifest(story, (m) => {
      const rec = (m.images[job.key] ??= { history: [], regen_count: 0 });
      rec.pending = {
        kind, status: 'requested', prompt: job.prompt, refs: job.refs,
        aspect_ratio: job.aspect, resolution: job.resolution, requested_at: new Date().toISOString(),
      };
    });
    const before = await client.creditsUsed();
    const body: Record<string, unknown> = { model_id: IMAGE_MODEL, prompt: job.prompt, aspect_ratio: job.aspect, resolution: job.resolution };
    if (job.refs.length) body.images = job.refs.map(refToApi);
    log(`  ${job.label}: створюємо генерацію (${plan.why})…`);
    const created = await client.createImage(body);
    pendingId = created.id;
    updateManifest(story, (m) => {
      const p = m.images[job.key]!.pending!;
      p.status = 'created';
      p.generation_id = created.id;
      (p as unknown as Record<string, unknown>).credits_before = before;
    });
  } else {
    log(`  ${job.label}: ${plan.why}`);
  }

  const rec0 = getRecord(story, job.key)!;
  const pending = rec0.pending!;
  try {
    const done = await client.waitForImage(pendingId);
    const data = await client.downloadImageGeneration(pendingId, done.content_url);
    const png = await toPng(data, done.content_mime_type ?? null);
    const after = await client.creditsUsed();
    const before = (pending as unknown as { credits_before?: number }).credits_before;
    const spent = before !== undefined ? ctx.recordSpent(after - before) : null;

    // Старий файл архівуємо тільки тепер, коли новий уже в руках.
    let archived: string | undefined;
    if (pending.kind !== 'initial' && existsSync(job.outFile)) {
      const tag = pending.kind === 'regen' ? `v${rec0.history.length + 1}` : `r${rec0.current?.resolution ?? 'old'}`;
      archived = join(dirname(job.outFile), `${basename(job.outFile, extname(job.outFile))}.${tag}${extname(job.outFile)}`);
      renameSync(job.outFile, archived);
    }
    writeAtomic(job.outFile, png);
    updateManifest(story, (m) => {
      const rec = m.images[job.key]!;
      if (pending.kind !== 'initial' && rec.current) {
        rec.history.push({ ...rec.current, file: archived ? paths.rel(archived) : rec.current.file });
        if (pending.kind === 'regen') rec.regen_count += 1;
      }
      const v: ImageVersion = {
        generation_id: pendingId!, model_id: IMAGE_MODEL, prompt: pending.prompt, refs: pending.refs, file: paths.rel(job.outFile),
        aspect_ratio: pending.aspect_ratio, resolution: pending.resolution, credits: spent,
        completed_at: new Date().toISOString(),
      };
      rec.current = v;
      delete rec.pending;
      if (spent !== null && spent > 0) {
        const pk = priceKey(pending.resolution);
        const pr = (m.image_prices ??= {});
        const old = pr[pk];
        pr[pk] = { max: Math.max(old?.max ?? 0, spent), last: spent, count: (old?.count ?? 0) + 1 };
      }
    });
    log(`  ${job.label}: готово → ${paths.rel(job.outFile)} (${spent ?? '?'} кредитів)`);
    return pending.kind === 'regen' ? 'regenerated' : 'generated';
  } catch (e) {
    if (e instanceof GenerationFailedError) {
      // Невдала генерація не списується і не рахується як перегенерація.
      updateManifest(story, (m) => {
        const rec = m.images[job.key]!;
        delete rec.pending;
        const fl = ((rec as unknown as Record<string, unknown>).failures ??= []) as unknown[];
        fl.push({ generation_id: pendingId, reason: e.reason, message: e.message, at: new Date().toISOString() });
      });
    }
    throw e;
  }
}

export function priceKey(resolution: string, model = IMAGE_MODEL): string {
  return `${model}@${resolution}`;
}

/** Максимум виміряної вартості картинки для пари «модель, роздільність» (з маніфесту), якщо є. */
export function measuredImageCredits(story: string, resolution: string, model = IMAGE_MODEL): number | undefined {
  const m = readManifest(story);
  const rec = m.image_prices?.[priceKey(resolution, model)];
  if (rec) return rec.max;
  // Маніфест без image_prices (старі записи): рахуємо з версій картинок тієї ж роздільності.
  let max: number | undefined;
  for (const r of Object.values(m.images)) {
    for (const v of [r.current, ...r.history]) {
      if (v?.credits != null && v.credits > 0 && v.resolution === resolution && (v.model_id ?? IMAGE_MODEL) === model) max = Math.max(max ?? 0, v.credits);
    }
  }
  return max;
}

/**
 * Очікувана вартість картинки для перевірки ліміту: максимум виміряного для цієї роздільності,
 * інакше значення --image-credits, інакше помилка (ціни в документації немає, а 512 і 1K коштують по-різному).
 */
export function expectedImageCredits(story: string, flag: number | undefined, resolution: string): number {
  const measured = measuredImageCredits(story, resolution);
  if (measured !== undefined) return measured;
  if (flag !== undefined) return flag;
  throw new Error(
    `Невідома ціна картинки для ${IMAGE_MODEL} у роздільності ${resolution} (у документації ElevenLabs її не знайдено, і для іншої роздільності вона інша). ` +
      'Задайте --image-credits N або згенеруйте одну картинку (--only) і скрипт візьме виміряну ціну сам.',
  );
}
