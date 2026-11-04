// Єдиний модуль звернень до ElevenLabs. Усі скрипти ходять в API тільки через нього.
//
// Чому прямий HTTP, а не обгортка над CLI: потрібні статус-код і заголовок retry-after
// (CLI їх ховає), заголовки відповіді (character-cost, song-id), multipart-завантаження,
// а ключ не повинен потрапляти в аргументи процесу. Контракти звірено з
// `elevenlabs <група> <метод> --schema` і `--spec`.
//
// Правила (CLAUDE.md, розділ «Код»):
//  - 429: чекаємо стільки, скільки сказав сервер (retry-after), без заголовка: експоненційна затримка;
//  - 5xx, мережеві помилки, тайм-аути: експоненційна затримка з розкидом, стеля, обмежена кількість спроб;
//  - перед повтором запису після 5xx/мережевої помилки перевіряємо, чи запис уже не виконався;
//  - списки: явна пагінація до has_more = false з прогресом на кожній сторінці;
//  - довші за ~20 с запити і очікування друкують прогрес.

import { log, registerSecret, redact, withHeartbeat } from './log';

export const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Запит, найімовірніше, виконався (гроші списано), але відповіді ми не маємо. Повторювати не можна. */
export class PossiblyExecutedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PossiblyExecutedError';
  }
}

export class GenerationFailedError extends Error {
  constructor(
    public generationId: string,
    public reason: string,
    message: string,
  ) {
    super(`Генерація ${generationId} не вдалася (${reason}): ${message}. Кредити за невдалу генерацію не списуються.`);
    this.name = 'GenerationFailedError';
  }
}

export type VerifyResult = { executed: false } | { executed: true; result?: unknown };

/** Перевірка «чи запис уже виконався», яку викликаємо перед повтором після 5xx/мережевої помилки. */
export interface WriteGuard {
  describe: string;
  verify(): Promise<VerifyResult>;
}

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Пауза перед перевіркою запису: лічильник кредитів і списки оновлюються не миттєво. */
  verifyDelayMs?: number;
  print?: (message: string) => void;
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  form?: FormData;
  response: 'json' | 'binary';
  timeoutMs?: number;
  label: string;
  write?: WriteGuard;
  /** Повний URL (підписане посилання для завантаження). Ключ API на нього не надсилається. */
  absoluteUrl?: string;
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

export interface Subscription {
  tier?: string;
  character_count: number;
  character_limit: number;
  [k: string]: unknown;
}

export interface ModelInfo {
  model_id: string;
  name: string;
  can_do_text_to_speech: boolean;
  maximum_text_length_per_request: number;
  model_rates?: { character_cost_multiplier: number; cost_discount_multiplier?: number };
  [k: string]: unknown;
}

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface TtsWithTimestamps {
  audio_base64: string;
  alignment: Alignment | null;
  normalized_alignment: Alignment | null;
}

export interface VoicePreview {
  audio_base_64: string;
  generated_voice_id: string;
  duration_secs: number;
  media_type: string;
  language: string | null;
}

export type ImageStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface ImageGeneration {
  id: string;
  status: ImageStatus;
  content_url?: string;
  content_mime_type?: string;
  failure_reason?: string;
  error_message?: string;
}

export interface Asset {
  asset_id: string;
  name: string;
  mime_type: string;
  created_at_unix: number;
  content_url: string | null;
}

export interface SpendTracker {
  before: number;
  guard: WriteGuard;
  finish(): Promise<{ before: number; after: number; spent: number }>;
}

/** Один запис у списку: сторінка, курсор, чи є далі. */
export interface Page<T> {
  items: T[];
  next: string | null | undefined;
  hasMore: boolean;
}

export async function paginate<T>(
  label: string,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  print: (m: string) => void = log,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    const res = await fetchPage(cursor);
    all.push(...res.items);
    print(`  ${label}: сторінка ${page}, +${res.items.length}, разом ${all.length}${res.hasMore ? ', є наступна' : ', кінець'}`);
    if (!res.hasMore) return all;
    if (!res.next) throw new Error(`${label}: has_more = true, але next_cursor порожній (сторінка ${page})`);
    if (seen.has(res.next)) throw new Error(`${label}: курсор повторився (${res.next}), зупиняємось, щоб не зациклитись`);
    seen.add(res.next);
    cursor = res.next;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function summarizeBody(body: string): string {
  try {
    const j = JSON.parse(body) as { detail?: unknown };
    const d = j.detail;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const o = d as { message?: string; status?: string };
      return [o.status, o.message].filter(Boolean).join(': ') || JSON.stringify(d).slice(0, 400);
    }
  } catch {
    // не JSON
  }
  return body.slice(0, 400);
}

export class ElevenLabsClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly verifyDelayMs: number;
  readonly print: (m: string) => void;
  private knownImageIds: Set<string> | undefined;

  constructor(opts: ClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
    registerSecret(this.apiKey);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.verifyDelayMs = opts.verifyDelayMs ?? 3000;
    this.print = opts.print ?? log;
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  /** Експоненційна затримка з розкидом («equal jitter») і стелею. */
  backoffMs(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp / 2 + (this.random() * exp) / 2);
  }

  /** Очікування з прогресом: довгі паузи (наприклад, retry-after) не мовчать. */
  async sleepWithProgress(ms: number, why: string): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 15_000);
      await this.sleep(step);
      left -= step;
      if (left > 0) this.print(`  … ${why}: лишилось чекати ${Math.ceil(left / 1000)} с`);
    }
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async request<T = unknown>(opts: RequestOptions): Promise<ApiResponse<T>> {
    const url = opts.absoluteUrl ?? this.buildUrl(opts.path, opts.query);
    const authed = !opts.absoluteUrl;
    if (authed && !this.apiKey) throw new Error('Не задано ELEVENLABS_API_KEY.');
    const headers: Record<string, string> = {};
    if (authed) headers['xi-api-key'] = this.apiKey!;
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const isWrite = opts.method !== 'GET';

    let lastProblem = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let waitMs: number | undefined;
      let needsVerify = false;
      try {
        const res = await withHeartbeat(
          opts.label,
          () => this.fetchImpl(url, { method: opts.method, headers, body, signal: AbortSignal.timeout(timeoutMs) }),
          { firstAfterMs: 20_000, print: this.print },
        );
        if (res.ok) {
          const data = (opts.response === 'binary'
            ? Buffer.from(await res.arrayBuffer())
            : ((await res.json()) as unknown)) as T;
          return { data, headers: res.headers };
        }
        const text = await res.text().catch(() => '');
        if (res.status === 429) {
          waitMs = parseRetryAfter(res.headers.get('retry-after')) ?? this.backoffMs(attempt);
          lastProblem = `429 (${summarizeBody(text)})`;
          this.print(`  ${opts.label}: 429, сервер просить зачекати ${Math.ceil(waitMs / 1000)} с (спроба ${attempt}/${this.maxAttempts})`);
        } else if (res.status >= 500) {
          lastProblem = `${res.status} (${summarizeBody(text)})`;
          waitMs = this.backoffMs(attempt);
          needsVerify = isWrite;
          this.print(`  ${opts.label}: помилка сервера ${res.status}, повтор через ${Math.ceil(waitMs / 1000)} с (спроба ${attempt}/${this.maxAttempts})`);
        } else {
          throw new ApiError(`${opts.label}: ${res.status} ${summarizeBody(text)}`, res.status, text, opts.path);
        }
      } catch (e) {
        if (e instanceof ApiError || e instanceof PossiblyExecutedError) throw e;
        const msg = e instanceof Error ? `${e.name}: ${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ''}` : String(e);
        lastProblem = `мережева помилка або тайм-аут: ${redact(msg)}`;
        waitMs = this.backoffMs(attempt);
        needsVerify = isWrite;
        this.print(`  ${opts.label}: ${lastProblem}; повтор через ${Math.ceil(waitMs / 1000)} с (спроба ${attempt}/${this.maxAttempts})`);
      }

      if (needsVerify && opts.write) {
        const verdict = await this.verifyBeforeRetry(opts);
        if (verdict.executed) {
          if (verdict.result !== undefined) return { data: verdict.result as T, headers: new Headers() };
          throw new PossiblyExecutedError(
            `${opts.label}: запит, найімовірніше, уже виконався на сервері (${opts.write.describe}), хоча відповіді ми не отримали. ` +
              'Автоматичний повтор зупинено, щоб не заплатити двічі. Перевірте результат вручну.',
          );
        }
      } else if (needsVerify && !opts.write) {
        throw new PossiblyExecutedError(`${opts.label}: запис без перевірки виконання, повтор небезпечний (${lastProblem}).`);
      }
      if (attempt === this.maxAttempts) break;
      await this.sleepWithProgress(waitMs ?? this.backoffMs(attempt), `${opts.label}, очікування перед повтором`);
    }
    throw new Error(`${opts.label}: не вдалося після ${this.maxAttempts} спроб. Остання проблема: ${lastProblem}`);
  }

  private async verifyBeforeRetry(opts: RequestOptions): Promise<VerifyResult> {
    this.print(`  ${opts.label}: перед повтором перевіряємо, чи запис уже виконався (${opts.write!.describe})`);
    await this.sleep(this.verifyDelayMs);
    return opts.write!.verify();
  }

  // ---------------------------------------------------------------- безкоштовні виклики

  async getSubscription(): Promise<Subscription> {
    return (await this.request<Subscription>({ method: 'GET', path: '/v1/user/subscription', response: 'json', label: 'user subscription get' })).data;
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.request<ModelInfo[]>({ method: 'GET', path: '/v1/models', response: 'json', label: 'models list' })).data;
  }

  /** Лічильник витрачених кредитів: різниця до/після дає вартість кроку. */
  async creditsUsed(): Promise<number> {
    return (await this.getSubscription()).character_count;
  }

  /**
   * Починає облік витрат. `guard` перевіряє «чи запис виконався» за лічильником кредитів:
   * якщо він виріс відносно моменту до виклику, запис, найімовірніше, виконався.
   */
  async beginSpend(): Promise<SpendTracker> {
    const before = await this.creditsUsed();
    const guard: WriteGuard = {
      describe: 'лічильник кредитів',
      verify: async () => {
        const now = await this.creditsUsed();
        return now > before ? { executed: true } : { executed: false };
      },
    };
    return {
      before,
      guard,
      finish: async () => {
        const after = await this.creditsUsed();
        return { before, after, spent: after - before };
      },
    };
  }

  // ---------------------------------------------------------------- голос

  async designVoice(body: Record<string, unknown>, guard?: WriteGuard): Promise<{ previews: VoicePreview[]; text: string }> {
    return (
      await this.request<{ previews: VoicePreview[]; text: string }>({
        method: 'POST',
        path: '/v1/text-to-voice/design',
        query: { output_format: 'mp3_44100_128' },
        json: body,
        response: 'json',
        timeoutMs: 180_000,
        label: 'text-to-voice design',
        write: guard,
      })
    ).data;
  }

  /** Список голосів за назвою (v2, пагінація за next_page_token). Для перевірки перед повтором create. */
  async findVoicesByName(name: string): Promise<Array<{ voice_id: string; name: string }>> {
    const voices = await paginate<{ voice_id: string; name: string }>(
      'voices search',
      async (cursor) => {
        const r = (
          await this.request<{ voices: Array<{ voice_id: string; name: string }>; has_more: boolean; next_page_token: string | null }>({
            method: 'GET',
            path: '/v2/voices',
            query: { search: name, page_size: 100, next_page_token: cursor, include_total_count: false },
            response: 'json',
            label: 'voices search',
          })
        ).data;
        return { items: r.voices, next: r.next_page_token, hasMore: r.has_more };
      },
      this.print,
    );
    return voices.filter((v) => v.name === name);
  }

  async createVoice(body: { generated_voice_id: string; voice_name: string; voice_description: string }): Promise<{ voice_id: string; name?: string }> {
    const guard: WriteGuard = {
      describe: `голос з назвою «${body.voice_name}»`,
      verify: async () => {
        const found = await this.findVoicesByName(body.voice_name);
        if (found.length === 1) return { executed: true, result: { voice_id: found[0]!.voice_id, name: found[0]!.name } };
        if (found.length > 1) throw new PossiblyExecutedError(`Знайдено кілька голосів з назвою «${body.voice_name}», розбирайтесь вручну.`);
        return { executed: false };
      },
    };
    return (
      await this.request<{ voice_id: string; name?: string }>({
        method: 'POST',
        path: '/v1/text-to-voice',
        json: body,
        response: 'json',
        label: 'text-to-voice create',
        write: guard,
      })
    ).data;
  }

  // ---------------------------------------------------------------- озвучення

  async textToSpeechWithTimestamps(
    voiceId: string,
    body: Record<string, unknown>,
    query: Record<string, QueryValue>,
    guard?: WriteGuard,
  ): Promise<TtsWithTimestamps> {
    return (
      await this.request<TtsWithTimestamps>({
        method: 'POST',
        path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
        query,
        json: body,
        response: 'json',
        timeoutMs: 600_000,
        label: 'text-to-speech convert_with_timestamps',
        write: guard,
      })
    ).data;
  }

  // ---------------------------------------------------------------- картинки

  async listImageGenerations(): Promise<ImageGeneration[]> {
    return paginate<ImageGeneration>(
      'flows image list',
      async (cursor) => {
        const r = (
          await this.request<{ generations: ImageGeneration[]; next_cursor: string | null; has_more: boolean }>({
            method: 'GET',
            path: '/v1/flows/image',
            query: { page_size: 100, cursor },
            response: 'json',
            label: 'flows image list',
          })
        ).data;
        return { items: r.generations, next: r.next_cursor, hasMore: r.has_more };
      },
      this.print,
    );
  }

  private async ensureKnownImageIds(): Promise<Set<string>> {
    if (!this.knownImageIds) {
      this.print('  Знімок наявних генерацій картинок (щоб після збою 5xx відрізнити нашу від чужих)…');
      this.knownImageIds = new Set((await this.listImageGenerations()).map((g) => g.id));
    }
    return this.knownImageIds;
  }

  /**
   * Створює генерацію картинки (POST /v1/flows/image). Перед повтором після 5xx
   * порівнюємо список генерацій зі знімком: нова генерація означає, що запит виконався.
   */
  async createImage(body: Record<string, unknown>): Promise<{ id: string; status: string }> {
    const known = await this.ensureKnownImageIds();
    const guard: WriteGuard = {
      describe: 'список генерацій картинок',
      verify: async () => {
        const ids = (await this.listImageGenerations()).map((g) => g.id);
        const fresh = ids.filter((id) => !known.has(id));
        if (fresh.length === 1) return { executed: true, result: { id: fresh[0]!, status: 'pending' } };
        if (fresh.length > 1) throw new PossiblyExecutedError(`Після збою з'явилося ${fresh.length} нових генерацій (${fresh.join(', ')}): не можна визначити, яка наша.`);
        return { executed: false };
      },
    };
    const res = (
      await this.request<{ id: string; status: string }>({
        method: 'POST',
        path: '/v1/flows/image',
        json: body,
        response: 'json',
        label: 'flows image create',
        write: guard,
      })
    ).data;
    known.add(res.id);
    return res;
  }

  async getImage(id: string): Promise<ImageGeneration> {
    return (
      await this.request<ImageGeneration>({
        method: 'GET',
        path: `/v1/flows/image/${encodeURIComponent(id)}`,
        response: 'json',
        label: `flows image get ${id}`,
      })
    ).data;
  }

  /**
   * Опитує генерацію до completed/failed. Документація просить опитувати не частіше
   * ніж раз на 2 с; якщо генерація довга, інтервал подвоюється до хвилини.
   */
  async waitForImage(
    id: string,
    opts: { intervalMs?: number; maxIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<ImageGeneration & { status: 'completed'; content_url: string }> {
    const maxWait = opts.maxWaitMs ?? 10 * 60_000;
    const maxInterval = opts.maxIntervalMs ?? 60_000;
    let interval = Math.max(opts.intervalMs ?? 2000, 2000);
    let waited = 0;
    for (let poll = 1; ; poll++) {
      const g = await this.getImage(id);
      this.print(`  генерація ${id}: ${g.status} (опитування ${poll}, ${Math.round(waited / 1000)} с)`);
      if (g.status === 'completed') {
        if (!g.content_url) throw new Error(`Генерація ${id} completed, але без content_url`);
        return g as ImageGeneration & { status: 'completed'; content_url: string };
      }
      if (g.status === 'failed') throw new GenerationFailedError(id, g.failure_reason ?? '?', g.error_message ?? '');
      if (waited >= maxWait) {
        throw new Error(`Генерація ${id} не завершилась за ${Math.round(maxWait / 1000)} с (статус ${g.status}). Її id збережено: повторний запуск продовжить очікування, нової генерації не буде.`);
      }
      await this.sleep(interval);
      waited += interval;
      if (waited >= 30_000) interval = Math.min(maxInterval, interval * 2);
    }
  }

  /** Завантажує файл за підписаним посиланням (без ключа API). */
  async download(url: string, label = 'download'): Promise<{ data: Buffer; contentType: string | null }> {
    const r = await this.request<Buffer>({ method: 'GET', path: '', absoluteUrl: url, response: 'binary', timeoutMs: 120_000, label });
    return { data: r.data, contentType: r.headers.get('content-type') };
  }

  /** Завантажує результат генерації; якщо підписане посилання протухло (~1 година), бере свіже. */
  async downloadImageGeneration(id: string, url: string): Promise<Buffer> {
    try {
      return (await this.download(url, `download ${id}`)).data;
    } catch (e) {
      if (e instanceof ApiError && [400, 401, 403, 404, 410].includes(e.status)) {
        this.print(`  Посилання на ${id} не спрацювало (${e.status}), беремо свіже.`);
        const fresh = await this.waitForImage(id);
        return (await this.download(fresh.content_url, `download ${id}`)).data;
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- ресурси

  async listAssets(search?: string): Promise<Asset[]> {
    return paginate<Asset>(
      'assets list',
      async (cursor) => {
        const r = (
          await this.request<{ assets: Asset[]; next_cursor: string | null; has_more: boolean }>({
            method: 'GET',
            path: '/v1/assets',
            query: { page_size: 100, cursor, search },
            response: 'json',
            label: 'assets list',
          })
        ).data;
        return { items: r.assets, next: r.next_cursor, hasMore: r.has_more };
      },
      this.print,
    );
  }

  async createAsset(file: Buffer, fileName: string, name: string, mimeType: string): Promise<Asset> {
    const guard: WriteGuard = {
      describe: `ресурс з назвою «${name}»`,
      verify: async () => {
        const found = (await this.listAssets(name)).filter((a) => a.name === name);
        if (found.length === 1) return { executed: true, result: found[0] };
        if (found.length > 1) throw new PossiblyExecutedError(`Знайдено кілька ресурсів з назвою «${name}», розбирайтесь вручну.`);
        return { executed: false };
      },
    };
    // Одне й те саме тіло FormData безпечно відправляється повторно (перевірено тестом на мок-сервері).
    const form = new FormData();
    form.append('asset', new Blob([new Uint8Array(file)], { type: mimeType }), fileName);
    form.append('name', name);
    return (
      await this.request<Asset>({
        method: 'POST',
        path: '/v1/assets',
        form,
        response: 'json',
        timeoutMs: 120_000,
        label: 'assets create',
        write: guard,
      })
    ).data;
  }

  // ---------------------------------------------------------------- музика і шуми

  async composeMusic(body: Record<string, unknown>, query: Record<string, QueryValue>, guard?: WriteGuard): Promise<{ audio: Buffer; songId: string | null }> {
    const r = await this.request<Buffer>({
      method: 'POST',
      path: '/v1/music',
      query,
      json: body,
      response: 'binary',
      timeoutMs: 600_000,
      label: 'music compose',
      write: guard,
    });
    return { audio: r.data, songId: r.headers.get('song-id') };
  }

  async soundEffect(body: Record<string, unknown>, query: Record<string, QueryValue>, guard?: WriteGuard): Promise<{ audio: Buffer; characterCost: number | null }> {
    const r = await this.request<Buffer>({
      method: 'POST',
      path: '/v1/sound-generation',
      query,
      json: body,
      response: 'binary',
      timeoutMs: 180_000,
      label: 'text-to-sound-effects convert',
      write: guard,
    });
    const cost = r.headers.get('character-cost');
    return { audio: r.data, characterCost: cost !== null && /^\d+$/.test(cost) ? Number(cost) : null };
  }
}
