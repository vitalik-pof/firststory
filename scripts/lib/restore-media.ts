// Відновлення медіа з work/, записаних у маніфесті, але відсутніх на цій машині (сесія тимчасова).
// Усе безкоштовне: лише читання з ElevenLabs (історія озвучення, збережені голоси, генерації картинок).
//
// Що звідки береться:
//  - частини озвучення: запис історії озвучення; його знаходимо за голосом, часом і текстом. Найсильніша
//    ознака: хеш частини (він рахується від тексту запиту, голосу й формату) збігається з ключем у маніфесті;
//  - narration.mp3: склейка активних частин так само, як це робить narrate.ts (concatMp3, пауза з timings.json);
//  - проба голосу: лише обрана (її зберігає створений голос як зразок) або та, що створена з потоковим режимом;
//  - картинки: генерація за id (flows image get → content_url);
//  - фото-референси: ElevenLabs зберігає лише стиснену JPEG-копію, тому з --allow-lossy;
//  - музика й шуми: способу отримати їх назад немає (ні в історії, ні за song_id).
// Файли, що вже є, ніколи не перезаписуються. У маніфест додається лише history_item_id частин озвучення.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { probeDuration, concatMp3, hasBinary } from './audio';
import { type Alignment, ApiError, type ElevenLabsClient, type HistoryItem, type HistoryItemDetail } from './elevenlabs';
import { toPng, writeAtomic } from './image-job';
import { log } from './log';
import { type Manifest, readManifest } from './manifest';
import { getRoot, paths } from './paths';
import type { TimingsFile } from './timings';
import { narrationPartHash } from './timings';

export type ItemState = 'present' | 'restorable' | 'unrecoverable' | 'skipped' | 'local';
export type Group = 'narration' | 'voice' | 'images' | 'references' | 'audio' | 'other';

export interface PlanItem {
  group: Group;
  label: string;
  /** Файли, які цей пункт дає (відносні шляхи від кореня проєкту). */
  files: string[];
  state: ItemState;
  /** Звідки беремо (для restorable). */
  source?: string;
  /** Чому не можна чи не робимо (для unrecoverable, skipped, local). */
  reason?: string;
  /** Додаткові відомості (перевірки, що вже зроблено в сухому прогоні). */
  notes: string[];
  /** Ключ частини озвучення в manifest.narration.parts (лише для частин). */
  partHash?: string;
  /** Виконує завантаження (лише з --run). Повертає короткий підсумок. */
  restore?: () => Promise<string>;
}

export interface RestoreOptions {
  story: string;
  /** Брати запис історії, чий хеш тексту не збігся, але збігаються довжина тексту й час (за замовчуванням ні). */
  acceptWeak?: boolean;
  /** Класти стиснену JPEG-копію фото-референсу замість втраченого оригіналу. */
  allowLossy?: boolean;
  /** Скільки найближчих за часом записів історії перевіряти на кожну частину. */
  maxCandidates?: number;
}

export interface Plan {
  story: string;
  items: PlanItem[];
  /** history_item_id для частин озвучення, які будуть дописані в маніфест після --run. */
  historyIds: Map<string, string>;
}

const abs = (rel: string): string => resolve(getRoot(), rel);
const relOf = (file: string): string => paths.rel(file);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function newItem(group: Group, label: string, files: string[]): PlanItem {
  return { group, label, files: files.map(relOf), state: 'present', notes: [] };
}

/** Записує файл через тимчасовий, спершу даючи перевірити вміст (наприклад, тривалість). */
function saveChecked(file: string, data: Buffer, check?: (tmp: string) => void): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  writeFileSync(tmp, data);
  try {
    check?.(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, file);
}

function isMissingOnServer(e: unknown): boolean {
  return e instanceof ApiError && [400, 403, 404, 410, 422].includes(e.status);
}

// ---------------------------------------------------------------- озвучення

interface PartRec {
  hash?: string;
  mp3?: string;
  response_file?: string;
  chars_sent?: number;
  credits?: number | null;
  credits_source?: string;
  fragments?: number[];
  generated_at?: string;
  history_item_id?: string;
}

interface NarrationRec {
  model_id?: string;
  voice_id?: string;
  language_code?: string | null;
  output_format?: string;
  parts?: Record<string, PartRec>;
  active_parts?: string[];
  file?: string;
}

/** Текст запиту з повного запису історії (для озвучення одним голосом це dialogue[0].text). */
export function historyText(d: HistoryItemDetail): string | undefined {
  if (d.text) return d.text;
  if (d.dialogue?.length === 1 && d.dialogue[0]!.text) return d.dialogue[0]!.text;
  return undefined;
}

export type MatchQuality = 'strong' | 'weak';

/**
 * Шукає в історії запис для частини озвучення. Порядок перевірки: збережений history_item_id, потім найближчі
 * за часом записи (їхній повний вміст запитується окремо, бо в списку text порожній).
 *  - strong: хеш, порахований від тексту запису, збігається з ключем частини в маніфесті;
 *  - weak: довжина тексту дорівнює chars_sent і запис створено не далі ніж за 120 с від generated_at.
 */
export async function matchPart(
  client: ElevenLabsClient,
  nar: NarrationRec,
  hash: string,
  part: PartRec,
  history: HistoryItem[],
  used: Set<string>,
  details: Map<string, HistoryItemDetail>,
  maxCandidates: number,
): Promise<{ detail: HistoryItemDetail; quality: MatchQuality } | undefined> {
  const voiceId = nar.voice_id ?? '';
  const outputFormat = nar.output_format ?? 'mp3_44100_128';
  const getDetail = async (id: string): Promise<HistoryItemDetail> => {
    let d = details.get(id);
    if (!d) {
      d = await client.getHistoryItem(id);
      details.set(id, d);
    }
    return d;
  };
  const hashOf = (d: HistoryItemDetail): string | undefined => {
    const text = historyText(d);
    if (text === undefined) return undefined;
    const body: Record<string, unknown> = { text, model_id: d.model_id ?? nar.model_id };
    if (nar.language_code) body.language_code = nar.language_code;
    return narrationPartHash(body, d.dialogue?.[0]?.voice_id ?? voiceId, d.output_format ?? outputFormat);
  };

  if (part.history_item_id) {
    try {
      const d = await getDetail(part.history_item_id);
      return { detail: d, quality: hashOf(d) === hash ? 'strong' : 'weak' };
    } catch (e) {
      if (!isMissingOnServer(e)) throw e;
      log(`  history_item_id ${part.history_item_id} з маніфесту сервер не знає, шукаємо за часом і текстом.`);
    }
  }

  const genUnix = part.generated_at ? Math.floor(Date.parse(part.generated_at) / 1000) : undefined;
  const candidates = history
    .filter((h) => !used.has(h.history_item_id))
    .sort((a, b) => (genUnix === undefined ? 0 : Math.abs(a.date_unix - genUnix) - Math.abs(b.date_unix - genUnix)))
    .slice(0, maxCandidates);
  let weak: HistoryItemDetail | undefined;
  for (const c of candidates) {
    const d = await getDetail(c.history_item_id);
    if (hashOf(d) === hash) return { detail: d, quality: 'strong' };
    const text = historyText(d);
    if (!weak && text !== undefined && part.chars_sent !== undefined && text.length === part.chars_sent && genUnix !== undefined && Math.abs(c.date_unix - genUnix) <= 120) weak = d;
  }
  return weak ? { detail: weak, quality: 'weak' } : undefined;
}

/**
 * Таймінги символів із запису історії приходять в іншому вигляді, ніж із виклику озвучення: замість часу
 * закінчення символу в character_end_times_seconds лежить його тривалість (кінець = початок + тривалість).
 * Перевірено на справжніх записах: кінець символу, менший за його початок, у відповіді озвучення неможливий.
 * Повертає таймінги у вигляді відповіді озвучення (кінець округлено до мілісекунди).
 */
export function historyAlignmentToResponse(a: Alignment): Alignment {
  const { character_start_times_seconds: st, character_end_times_seconds: en } = a;
  const durations = en.some((e, i) => e < st[i]! - 1e-9);
  if (!durations) return a;
  return { characters: a.characters, character_start_times_seconds: st, character_end_times_seconds: en.map((d, i) => Math.round((st[i]! + d) * 1000) / 1000) };
}

/** Кінець останнього символу (трохи менший за тривалість файлу). */
function alignmentEnd(d: HistoryItemDetail): number | undefined {
  const a = d.alignments?.alignment;
  if (!a?.character_end_times_seconds?.length) return undefined;
  const ends = historyAlignmentToResponse(a).character_end_times_seconds;
  return ends[ends.length - 1];
}

async function planNarration(client: ElevenLabsClient, story: string, manifest: Manifest, timings: TimingsFile | undefined, opts: RestoreOptions, historyIds: Map<string, string>): Promise<PlanItem[]> {
  const nar = manifest.narration as NarrationRec | undefined;
  if (!nar?.parts) return [];
  const items: PlanItem[] = [];
  const partEntries = Object.entries(nar.parts).sort((a, b) => (a[1].generated_at ?? '').localeCompare(b[1].generated_at ?? ''));
  const needs = partEntries.filter(([, p]) => (p.mp3 && !existsSync(abs(p.mp3))) || (p.response_file && !existsSync(abs(p.response_file))));

  let history: HistoryItem[] = [];
  if (needs.length) {
    log(`Озвучення: бракує файлів у ${needs.length} з ${partEntries.length} частин. Шукаємо в історії голосу ${nar.voice_id}…`);
    if (!nar.voice_id) throw new Error('У manifest.narration немає voice_id: не можна шукати в історії.');
    history = await client.listHistory({ voiceId: nar.voice_id });
    log(`  Записів історії для цього голосу: ${history.length}.`);
  }
  const used = new Set<string>();
  const details = new Map<string, HistoryItemDetail>();
  const partItems = new Map<string, PlanItem>();

  for (const [hash, part] of partEntries) {
    const files = [part.mp3, part.response_file].filter((f): f is string => Boolean(f)).map(abs);
    const item = newItem('narration', `Частина озвучення ${hash} (фрагменти ${(part.fragments ?? []).join(', ')}, ${part.chars_sent ?? '?'} знаків)`, files);
    item.partHash = hash;
    items.push(item);
    partItems.set(hash, item);
    const missing = files.filter((f) => !existsSync(f));
    if (!missing.length) continue;
    const m = await matchPart(client, nar, hash, part, history, used, details, opts.maxCandidates ?? 10);
    if (!m) {
      item.state = 'unrecoverable';
      item.reason = `в історії ElevenLabs немає запису, що збігається за текстом (хеш ${hash}), або за довжиною й часом.`;
      log(`  ${item.label}: НЕ ЗНАЙДЕНО в історії.`);
      continue;
    }
    const d = m.detail;
    used.add(d.history_item_id);
    const diff = d.character_count_change_to - d.character_count_change_from;
    item.notes.push(
      `історія: ${d.history_item_id}, створено ${new Date(d.date_unix * 1000).toISOString()} (маніфест: ${part.generated_at ?? '?'}), кредити в історії ${diff}${part.credits != null ? ` (маніфест ${part.credits})` : ''}, ` +
        `${m.quality === 'strong' ? 'хеш тексту збігається з ключем у маніфесті (однозначно)' : 'хеш тексту НЕ збігся: збігаються лише довжина тексту й час (слабка відповідність)'}`,
    );
    const tp = timings?.parts.find((p) => p.fragments.join(',') === (part.fragments ?? []).join(','));
    const end = alignmentEnd(d);
    if (tp && end !== undefined) {
      const delta = Math.abs(tp.duration - end);
      item.notes.push(`тривалість: таймінги символів у записі дають ${end.toFixed(2)} с, у timings.json частина ${tp.index + 1} триває ${tp.duration} с (різниця ${delta.toFixed(2)} с${delta > 0.6 ? ', ВЕЛИКА' : ''})`);
    }
    if (m.quality === 'weak' && !opts.acceptWeak) {
      item.state = 'skipped';
      item.reason = 'слабка відповідність: запис схожий, але довести, що це він, не можна. Якщо переконані, додайте --accept-weak.';
      continue;
    }
    item.state = 'restorable';
    item.source = `ElevenLabs, історія озвучення ${d.history_item_id}`;
    if (!part.history_item_id) historyIds.set(hash, d.history_item_id);
    const al = d.alignments;
    if (missing.some((f) => f === abs(part.response_file ?? '')) && !al?.alignment) item.notes.push('у записі історії немає таймінгів символів: response.json відновити не вийде, narrate.ts --assemble-only не спрацює');
    item.restore = async () => {
      const dest = part.mp3 ? abs(part.mp3) : undefined;
      let audio: Buffer | undefined;
      const done: string[] = [];
      if (dest && !existsSync(dest)) {
        audio = await client.downloadHistoryAudio(d.history_item_id);
        saveChecked(dest, audio, (tmp) => {
          if (!tp) return;
          const got = probeDuration(tmp);
          if (got !== undefined && Math.abs(got - tp.duration) > 0.05) {
            throw new Error(`частина ${hash}: завантажене аудіо триває ${got.toFixed(3)} с, а в timings.json ${tp.duration} с (допуск 0.05 с). Файл не збережено.`);
          }
        });
        done.push(`${relOf(dest)} (${(audio.length / 1024).toFixed(0)} КБ${tp ? ', тривалість збігається з timings.json' : ''})`);
      }
      const rf = part.response_file ? abs(part.response_file) : undefined;
      if (rf && !existsSync(rf)) {
        if (!al?.alignment) done.push('response.json пропущено: у записі історії немає таймінгів символів');
        else {
          const data = audio ?? readFileSync(dest!);
          const response = {
            audio_base64: data.toString('base64'),
            alignment: historyAlignmentToResponse(al.alignment),
            normalized_alignment: al.normalized_alignment ? historyAlignmentToResponse(al.normalized_alignment) : null,
          };
          writeAtomic(rf, Buffer.from(JSON.stringify(response)));
          done.push(`${relOf(rf)} (аудіо й таймінги символів із запису історії)`);
        }
      }
      return done.join('; ');
    };
    log(`  ${item.label}: знайдено запис ${d.history_item_id} (${m.quality === 'strong' ? 'однозначно, за хешем' : 'слабка відповідність'}).`);
  }

  // narration.mp3
  if (nar.file) {
    const file = abs(nar.file);
    const item = newItem('narration', 'Зібране озвучення narration.mp3', [file]);
    items.push(item);
    if (!existsSync(file)) {
      const active = nar.active_parts?.length ? nar.active_parts : undefined;
      if (!active) {
        item.state = 'unrecoverable';
        item.reason = 'у маніфесті немає active_parts: невідомо, з яких частин і в якому порядку збирати.';
        return items;
      }
      const gap = timings && timings.parts.length > 1 ? timings.part_gap : 0;
      const blockers = active.filter((h) => {
        const pi = partItems.get(h);
        return !pi || (pi.state !== 'present' && pi.state !== 'restorable');
      });
      if (blockers.length) {
        item.state = 'unrecoverable';
        item.reason = `немає змоги відновити частини ${blockers.join(', ')}.`;
        return items;
      }
      item.state = 'restorable';
      item.source = `склейка активних частин ${active.join(' + ')} (пауза ${gap} с, як у narrate.ts)`;
      if (timings) item.notes.push(`очікувана тривалість за timings.json: ${timings.duration} с`);
      item.restore = async () => {
        if (!hasBinary('ffmpeg')) throw new Error('Для склейки потрібен ffmpeg (його немає в PATH).');
        const inputs = active.map((h) => abs(nar.parts![h]!.mp3!));
        for (const f of inputs) if (!existsSync(f)) throw new Error(`Немає частини ${relOf(f)}: склейка неможлива.`);
        const tmp = file.replace(/\.mp3$/i, '') + '.restoring.mp3';
        mkdirSync(dirname(file), { recursive: true });
        if (inputs.length === 1) copyFileSync(inputs[0]!, tmp);
        else concatMp3(inputs, gap, tmp);
        const got = probeDuration(tmp);
        if (timings && got !== undefined && Math.abs(got - timings.duration) > 0.25) {
          rmSync(tmp, { force: true });
          throw new Error(`склеєне озвучення триває ${got.toFixed(3)} с, а в timings.json ${timings.duration} с (допуск 0.25 с, як у narrate.ts). Файл не збережено.`);
        }
        renameSync(tmp, file);
        return `${relOf(file)}: ${got !== undefined ? `${got.toFixed(3)} с` : 'тривалість невідома (ffprobe недоступний)'}${timings ? `, timings.json ${timings.duration} с, узгоджено` : ''}`;
      };
    }
  }
  return items;
}

// ---------------------------------------------------------------- проби голосу

interface PreviewRec {
  n: number;
  generated_voice_id?: string;
  file?: string;
  duration_secs?: number;
}

async function planPreviews(client: ElevenLabsClient, manifest: Manifest): Promise<PlanItem[]> {
  const voice = manifest.voice as { voice_id?: string; picked_preview?: number; previews?: PreviewRec[] } | undefined;
  if (!voice?.previews) return [];
  const items: PlanItem[] = [];
  let info: Awaited<ReturnType<ElevenLabsClient['getVoice']>> | null | undefined;
  for (const p of voice.previews) {
    if (!p.file) continue;
    const file = abs(p.file);
    const item = newItem('voice', `Проба голосу ${p.n}${voice.picked_preview === p.n ? ' (обрана)' : ''}`, [file]);
    items.push(item);
    if (existsSync(file)) continue;
    const reasons: string[] = [];
    // 1. Обрана проба: створений з неї голос зберігає її як зразок.
    const isPicked = voice.voice_id && (p.generated_voice_id === voice.voice_id || voice.picked_preview === p.n);
    if (isPicked && voice.voice_id) {
      if (info === undefined) {
        try {
          info = await client.getVoice(voice.voice_id);
        } catch (e) {
          if (!isMissingOnServer(e)) throw e;
          info = null;
          reasons.push(`голос ${voice.voice_id} не знайдено (${errText(e)})`);
        }
      }
      const samples = info?.samples ?? [];
      const sample = p.duration_secs !== undefined
        ? samples.find((s) => s.duration_secs != null && Math.abs(s.duration_secs - p.duration_secs!) <= 0.2)
        : samples.length === 1 ? samples[0] : undefined;
      if (sample) {
        item.state = 'restorable';
        item.source = `зразок ${sample.sample_id} створеного голосу ${voice.voice_id} (його проба)`;
        item.notes.push(`тривалість зразка ${sample.duration_secs?.toFixed(3) ?? '?'} с, у маніфесті ${p.duration_secs ?? '?'} с: збігається`);
        item.restore = async () => {
          const data = await client.downloadVoiceSample(voice.voice_id!, sample.sample_id);
          saveChecked(file, data);
          return `${relOf(file)} (${(data.length / 1024).toFixed(0)} КБ)`;
        };
        log(`  ${item.label}: знайдено зразок голосу.`);
        continue;
      }
      if (info) reasons.push(`у голосу ${voice.voice_id} немає зразка тривалістю ${p.duration_secs ?? '?'} с (зразків: ${samples.length})`);
    }
    // 2. Потоковий перегляд проби за generated_voice_id (доступний лише для проб, створених із потоковим режимом).
    if (p.generated_voice_id) {
      try {
        const data = await client.streamVoicePreview(p.generated_voice_id);
        item.state = 'restorable';
        item.source = `потоковий перегляд проби ${p.generated_voice_id}`;
        item.restore = async () => {
          saveChecked(file, data);
          return `${relOf(file)} (${(data.length / 1024).toFixed(0)} КБ)`;
        };
        log(`  ${item.label}: проба доступна потоком.`);
        continue;
      } catch (e) {
        if (!isMissingOnServer(e)) throw e;
        reasons.push(`потоковий перегляд недоступний: ${errText(e).replace(/^[^:]*:\s*/, '').replace(/\.+$/, '')}`);
      }
    }
    item.state = 'unrecoverable';
    item.reason = `${isPicked ? '' : 'проба не обрана, тож голосом її ніхто не зберіг; '}${reasons.join('; ') || 'джерела немає'}. На сторінці огляду на її місці буде текст «файл недоступний».`;
    log(`  ${item.label}: відновити не можна.`);
  }
  return items;
}

// ---------------------------------------------------------------- картинки

interface VersionRec {
  generation_id?: string;
  file?: string;
  width?: number;
  height?: number;
}

async function planImage(client: ElevenLabsClient, item: PlanItem, v: VersionRec): Promise<void> {
  if (!v.generation_id || !v.file) {
    item.state = 'unrecoverable';
    item.reason = 'у маніфесті немає generation_id.';
    return;
  }
  const file = abs(v.file);
  try {
    const g = await client.getImage(v.generation_id);
    if (g.status !== 'completed' || !g.content_url) {
      item.state = 'unrecoverable';
      item.reason = `генерація ${v.generation_id} має статус «${g.status}», результату немає.`;
      return;
    }
    item.state = 'restorable';
    item.source = `генерація ${v.generation_id} (flows image get → content_url)`;
    const contentUrl = g.content_url;
    const mime = g.content_mime_type ?? null;
    item.restore = async () => {
      const data = await client.downloadImageGeneration(v.generation_id!, contentUrl);
      const png = await toPng(data, mime);
      const meta = await sharp(png).metadata();
      writeAtomic(file, png);
      const dims = `${meta.width}×${meta.height} px`;
      const warn = v.width && v.height && (meta.width !== v.width || meta.height !== v.height) ? `, УВАГА: у маніфесті ${v.width}×${v.height}` : v.width ? ', розмір збігається з маніфестом' : '';
      return `${relOf(file)} (${dims}${warn})`;
    };
  } catch (e) {
    if (!isMissingOnServer(e)) throw e;
    item.state = 'unrecoverable';
    item.reason = `ElevenLabs не знаходить генерацію ${v.generation_id}: ${errText(e)}`;
  }
}

async function planImages(client: ElevenLabsClient, manifest: Manifest, planned: Set<string>): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const [key, rec] of Object.entries(manifest.images)) {
    const versions: Array<{ tag: string; v: VersionRec }> = [];
    if (rec.current) versions.push({ tag: 'поточна', v: rec.current });
    rec.history.forEach((h, i) => versions.push({ tag: `попередня ${i + 1}`, v: h }));
    for (const { tag, v } of versions) {
      if (!v.file) continue;
      const file = abs(v.file);
      if (planned.has(file)) continue;
      planned.add(file);
      const item = newItem('images', `Картинка ${key}, ${tag} версія`, [file]);
      items.push(item);
      if (existsSync(file)) continue;
      if (rec.pending) {
        item.state = 'skipped';
        item.reason = `для ${key} триває генерація (pending в маніфесті): її веде frames.ts чи інший скрипт, не чіпаємо. Запустіть відновлення ще раз, коли вона завершиться.`;
        continue;
      }
      await planImage(client, item, v);
      log(`  ${item.label}: ${item.state === 'restorable' ? 'є на сервері' : 'відновити не можна'}.`);
    }
  }
  return items;
}

/** Аркуші героїв: assets["sheet/..."] має generation_id і file; якщо картинки вже заплановано через images, пропускаємо. */
async function planSheets(client: ElevenLabsClient, manifest: Manifest, planned: Set<string>): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const [key, a] of Object.entries(manifest.assets)) {
    const file = typeof a.file === 'string' ? abs(a.file) : undefined;
    if (!file || planned.has(file)) continue;
    planned.add(file);
    const item = newItem('images', `Аркуш героя ${key}`, [file]);
    items.push(item);
    if (existsSync(file)) continue;
    await planImage(client, item, { generation_id: typeof a.generation_id === 'string' ? a.generation_id : undefined, file: a.file as string });
    log(`  ${item.label}: ${item.state === 'restorable' ? 'є на сервері' : 'відновити не можна'}.`);
  }
  return items;
}

// ---------------------------------------------------------------- фото-референси

async function planReferences(client: ElevenLabsClient, manifest: Manifest, opts: RestoreOptions): Promise<PlanItem[]> {
  const refs = (manifest.assets.references ?? {}) as Record<string, { files?: Record<string, { asset_id?: string; sha1?: string; width?: number; height?: number }> }>;
  const items: PlanItem[] = [];
  for (const [objId, entry] of Object.entries(refs)) {
    for (const [name, rec] of Object.entries(entry.files ?? {})) {
      const file = paths.referencesWork(objId) + '/' + name;
      const item = newItem('references', `Фото-референс ${objId}/${name}`, [file]);
      items.push(item);
      if (existsSync(file)) continue;
      if (!rec.asset_id) {
        item.state = 'unrecoverable';
        item.reason = 'у маніфесті немає asset_id.';
        continue;
      }
      try {
        const asset = await client.getAsset(rec.asset_id);
        const url = asset.content_url;
        if (!url) {
          item.state = 'unrecoverable';
          item.reason = `ресурс ${rec.asset_id} без content_url.`;
          continue;
        }
        const why = `ElevenLabs зберігає лише копію, яку завантажив upload-references.ts (JPEG q90, довша сторона ≤ 1536 px); sha1 оригіналу (${rec.sha1?.slice(0, 8) ?? '?'}…) із неї не відтворити, тож upload-references.ts вважатиме файл зміненим. Для генерації локальний файл не потрібен: запити йдуть за asset_id.`;
        if (!opts.allowLossy) {
          item.state = 'skipped';
          item.reason = `${why} Щоб усе одно покласти копію, додайте --allow-lossy.`;
          continue;
        }
        item.state = 'restorable';
        item.source = `ресурс ${rec.asset_id} (копія з втратами)`;
        item.notes.push(why);
        item.restore = async () => {
          const { data } = await client.download(url, `download ${rec.asset_id}`);
          const out = /\.png$/i.test(name) ? await toPng(data, null) : data;
          writeAtomic(file, out);
          return `${relOf(file)} (копія з втратами, ${(out.length / 1024).toFixed(0)} КБ)`;
        };
      } catch (e) {
        if (!isMissingOnServer(e)) throw e;
        item.state = 'unrecoverable';
        item.reason = `ElevenLabs не знаходить ресурс ${rec.asset_id}: ${errText(e)}`;
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------- музика, шуми, зведення

function planAudio(manifest: Manifest): PlanItem[] {
  const items: PlanItem[] = [];
  for (const [key, a] of Object.entries(manifest.audio)) {
    if (typeof a.file !== 'string') continue;
    const file = abs(a.file);
    const kind = a.kind === 'music' ? 'музика' : 'шум';
    const item = newItem('audio', `${kind[0]!.toUpperCase()}${kind.slice(1)} ${key}`, [file]);
    items.push(item);
    if (existsSync(file)) continue;
    item.state = 'unrecoverable';
    item.reason =
      a.kind === 'music'
        ? `ElevenLabs не віддає готову музику за song_id${a.song_id ? ` (${a.song_id})` : ''}: у API є тільки генерація (платна), а історія містить лише озвучення.`
        : 'шуми не потрапляють в історію ElevenLabs, і способу завантажити їх назад немає; лишається лише нова генерація (платна).';
  }
  const mix = manifest.mix_sample as { file?: string; music_sample?: number } | undefined;
  if (mix?.file) {
    const file = abs(mix.file);
    const item = newItem('other', 'Зразок зведення mix-sample.mp3', [file]);
    items.push(item);
    if (!existsSync(file)) {
      item.state = 'local';
      const music = mix.music_sample !== undefined ? paths.workFile(manifest.story, 'audio', 'samples', `music-${mix.music_sample}.mp3`) : undefined;
      item.reason = `не з ElevenLabs: збирається локально й безкоштовно командою «npx tsx scripts/mix-sample.ts --story ${manifest.story}»; потрібні narration.mp3 і зразок музики ${mix.music_sample ?? '?'}${music ? ` (${existsSync(music) ? 'є' : 'його теж немає, і він не відновлюється'})` : ''}.`;
    }
  }
  return items;
}

// ---------------------------------------------------------------- план і виконання

export async function buildPlan(client: ElevenLabsClient, opts: RestoreOptions): Promise<Plan> {
  const story = opts.story;
  const manifest = readManifest(story);
  const timings = existsSync(paths.timings(story)) ? (JSON.parse(readFileSync(paths.timings(story), 'utf8')) as TimingsFile) : undefined;
  const historyIds = new Map<string, string>();
  const planned = new Set<string>();
  const items: PlanItem[] = [];
  log('Перевіряємо, чого бракує на диску…');
  items.push(...(await planNarration(client, story, manifest, timings, opts, historyIds)));
  items.push(...(await planPreviews(client, manifest)));
  items.push(...(await planImages(client, manifest, planned)));
  items.push(...(await planSheets(client, manifest, planned)));
  items.push(...(await planReferences(client, manifest, opts)));
  items.push(...planAudio(manifest));
  return { story, items, historyIds };
}

/** Дописує history_item_id у manifest.narration.parts[хеш]. Нічого іншого в маніфесті не змінюється (навіть updated_at). */
export function patchManifestHistoryIds(story: string, ids: Map<string, string>): number {
  if (!ids.size) return 0;
  const file = paths.manifest(story);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { narration?: { parts?: Record<string, PartRec> } };
  let n = 0;
  for (const [hash, id] of ids) {
    const part = raw.narration?.parts?.[hash];
    if (part && !part.history_item_id) {
      part.history_item_id = id;
      n++;
    }
  }
  if (n) {
    writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + '\n');
    renameSync(`${file}.tmp`, file);
  }
  return n;
}

export interface RestoreResult {
  restored: Array<{ item: PlanItem; summary: string }>;
  failed: Array<{ item: PlanItem; error: string }>;
  idsWritten: number;
}

export async function executePlan(plan: Plan): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], failed: [], idsWritten: 0 };
  const todo = plan.items.filter((i) => i.state === 'restorable' && i.restore);
  log(`\nЗавантажуємо: ${todo.length} пунктів.`);
  const okParts = new Set<string>();
  let k = 0;
  for (const item of todo) {
    k++;
    log(`[${k}/${todo.length}] ${item.label}…`);
    try {
      const summary = await item.restore!();
      result.restored.push({ item, summary });
      log(`  готово: ${summary}`);
      if (item.partHash) okParts.add(item.partHash);
    } catch (e) {
      result.failed.push({ item, error: errText(e) });
      log(`  ПОМИЛКА: ${errText(e)}`);
    }
  }
  // history_item_id дописуємо лише для частин, які справді відновлено.
  const ids = new Map([...plan.historyIds].filter(([h]) => okParts.has(h)));
  result.idsWritten = patchManifestHistoryIds(plan.story, ids);
  return result;
}

const STATE_TITLE: Record<ItemState, string> = {
  present: 'є на диску',
  restorable: 'можна відновити',
  unrecoverable: 'відновити не можна',
  skipped: 'пропущено',
  local: 'збирається локально',
};

export function renderReport(plan: Plan, run: boolean, result?: RestoreResult): string {
  const out: string[] = [];
  const by = (s: ItemState): PlanItem[] => plan.items.filter((i) => i.state === s);
  const present = by('present').length;
  out.push(`\n=== ${run ? 'Результат' : 'Сухий прогін'}: ${plan.story} ===`);
  out.push(`Усього пунктів у маніфесті: ${plan.items.length}; уже є на диску: ${present}.`);
  const restorable = by('restorable');
  if (restorable.length) {
    out.push(`\n${run ? 'До відновлення було' : 'Можна відновити'} (${restorable.length}):`);
    for (const i of restorable) {
      out.push(`  - ${i.label}`);
      out.push(`      джерело: ${i.source}`);
      for (const n of i.notes) out.push(`      ${n}`);
    }
  }
  if (result) {
    out.push(`\nЗавантажено: ${result.restored.length}, помилок: ${result.failed.length}.`);
    for (const f of result.failed) out.push(`  ПОМИЛКА ${f.item.label}: ${f.error}`);
    if (result.idsWritten) out.push(`У маніфест дописано history_item_id: ${result.idsWritten} (більше нічого не змінено).`);
  } else if (plan.historyIds.size) {
    out.push(`\nПісля --run в manifest.narration.parts буде дописано history_item_id для частин: ${[...plan.historyIds.keys()].join(', ')} (більше нічого в маніфесті не змінюється).`);
  }
  for (const s of ['skipped', 'local', 'unrecoverable'] as const) {
    const list = by(s);
    if (!list.length) continue;
    out.push(`\n${s === 'unrecoverable' ? 'ВІДНОВИТИ НЕ МОЖНА' : STATE_TITLE[s].toUpperCase()} (${list.length}):`);
    for (const i of list) {
      out.push(`  - ${i.label}: ${i.reason}`);
      for (const n of i.notes) out.push(`      ${n}`);
    }
  }
  if (!restorable.length && !by('skipped').length && !by('local').length && !by('unrecoverable').length) out.push('\nУсе на місці, відновлювати нічого.');
  if (!run && restorable.length) out.push('\nСУХИЙ ПРОГІН: нічого не завантажено. Додайте --run (безкоштовно).');
  return out.join('\n');
}
