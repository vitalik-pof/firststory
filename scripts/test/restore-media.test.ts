import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { probeDuration } from '../lib/audio';
import { ElevenLabsClient } from '../lib/elevenlabs';
import { type Plan, buildPlan, executePlan, historyAlignmentToResponse, renderReport } from '../lib/restore-media';
import { gatherPreviews } from '../lib/review-previews';
import { renderVoiceBody } from '../lib/review-html';
import { readManifest } from '../lib/manifest';
import { getRoot } from '../lib/paths';
import { narrationPartHash } from '../lib/timings';
import { STORY, makeMp3, makePng, mkProject } from './fixtures';

const VOICE = 'voiceAAAA111';
const TEXT_A = '[calmly] Ми виїхали влітку. [pause]';
const TEXT_B = '[softly] Дочки мали піти в перший клас.\n\n[pause] Але не судилося. [pause]';
const TEXT_C = '[calmly] Ми виїхали влітку. [tense]';
const body = (text: string) => ({ text, model_id: 'eleven_v4', language_code: 'uk' });
const HASH_A = narrationPartHash(body(TEXT_A), VOICE, 'mp3_44100_128');
const HASH_B = narrationPartHash(body(TEXT_B), VOICE, 'mp3_44100_128');
const T0 = Date.parse('2026-11-05T00:42:14.000Z') / 1000;

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

function alignmentAsHistory(n: number): { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } {
  // У записі історії «end» це тривалість символу.
  return { characters: Array.from({ length: n }, () => 'a'), character_start_times_seconds: Array.from({ length: n }, (_, i) => i * 0.05), character_end_times_seconds: Array.from({ length: n }, () => 0.05) };
}

interface Mock {
  url: string;
  hits: string[];
}

async function startMock(dir: string, opts: { streamOk?: boolean } = {}): Promise<Mock> {
  const hits: string[] = [];
  const item = (id: string, text: string, dt: number, from: number, to: number) => ({
    history_item_id: id, request_id: null, voice_id: null, model_id: 'eleven_v4', text: '', date_unix: T0 + dt, character_count_change_from: from, character_count_change_to: to,
    output_format: 'mp3_44100_128', dialogue: [{ text, voice_id: VOICE, voice_name: 'v' }], alignments: { alignment: alignmentAsHistory(text.length), normalized_alignment: alignmentAsHistory(text.length) },
  });
  const items: Record<string, ReturnType<typeof item>> = {
    hA: item('hA', TEXT_A, 0, 0, 18),
    hB: item('hB', TEXT_B, 30, 18, 60),
    hC: item('hC', TEXT_C, 2, 60, 78), // приманка: схожий текст, час поруч із A
  };
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url!, 'http://x');
    hits.push(`${req.method} ${u.pathname}`);
    const json = (status: number, b: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b));
    const file = (f: string, type: string): void => void res.writeHead(200, { 'content-type': type }).end(readFileSync(f));
    let m: RegExpExecArray | null;
    if (u.pathname === '/v1/history') {
      assert.equal(u.searchParams.get('voice_id'), VOICE);
      return json(200, { history: Object.values(items).map((x) => ({ ...x, dialogue: undefined, alignments: undefined })), has_more: false, last_history_item_id: null });
    }
    if ((m = /^\/v1\/history\/(\w+)\/audio$/.exec(u.pathname))) return file(join(dir, m[1] === 'hB' ? 'b.mp3' : 'a.mp3'), 'audio/mpeg');
    if ((m = /^\/v1\/history\/(\w+)$/.exec(u.pathname))) return items[m[1]!] ? json(200, items[m[1]!]) : json(404, { detail: 'нема' });
    if (u.pathname === `/v1/voices/${VOICE}`) return json(200, { voice_id: VOICE, name: 'v', samples: [{ sample_id: 'smp1', duration_secs: 2.0, size_bytes: 1 }] });
    if (u.pathname === `/v1/voices/${VOICE}/samples/smp1/audio`) return file(join(dir, 'a.mp3'), 'audio/mpeg');
    if ((m = /^\/v1\/text-to-voice\/(\w+)\/stream$/.exec(u.pathname))) {
      if (opts.streamOk && m[1] === 'gen3') return file(join(dir, 'a.mp3'), 'audio/mpeg');
      return json(400, { detail: { message: `Preview voice '${m[1]}' was not generated with preview streaming enabled.` } });
    }
    if ((m = /^\/v1\/flows\/image\/(\w+)$/.exec(u.pathname))) {
      if (m[1] === 'gone') return json(404, { detail: 'generation not found' });
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      return json(200, { id: m[1], status: 'completed', content_url: `${base}/content/${m[1]}.png`, content_mime_type: 'image/png' });
    }
    if (u.pathname.startsWith('/content/')) return file(join(dir, 'img.png'), 'image/png');
    json(404, { detail: `unexpected ${u.pathname}` });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function setup(opts: { hashA?: string; streamOk?: boolean } = {}): Promise<{ root: string; client: ElevenLabsClient; mock: Mock; w: (rel: string) => string }> {
  const root = mkProject();
  const dir = join(tmpdir(), `restore-fixtures-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  makeMp3(join(dir, 'a.mp3'), 2, 440);
  makeMp3(join(dir, 'b.mp3'), 3, 330);
  await makePng(join(dir, 'img.png'), 64, 96, 3);
  const dA = probeDuration(join(dir, 'a.mp3'))!;
  const dB = probeDuration(join(dir, 'b.mp3'))!;
  const hashA = opts.hashA ?? HASH_A;
  const gen = new Date((T0 + 1) * 1000).toISOString();
  const manifest = {
    story: STORY,
    credits: { total_spent: 0, runs: [] },
    images: {
      'frame/01': { history: [], regen_count: 0, current: { generation_id: 'gimg1', file: `work/${STORY}/frames/frame-01.png`, width: 64, height: 96, prompt: 'p', refs: [], aspect_ratio: '9:16', resolution: '1K', credits: 1, completed_at: gen } },
      'frame/02': { history: [], regen_count: 0, current: { generation_id: 'gone', file: `work/${STORY}/frames/frame-02.png`, prompt: 'p', refs: [], aspect_ratio: '9:16', resolution: '1K', credits: 1, completed_at: gen } },
      'frame/03': { history: [], regen_count: 0, pending: { kind: 'initial', status: 'created', generation_id: 'gimg3', prompt: 'p', refs: [], aspect_ratio: '9:16', resolution: '1K', requested_at: gen }, current: { generation_id: 'gimg3old', file: `work/${STORY}/frames/frame-03.png`, prompt: 'p', refs: [], aspect_ratio: '9:16', resolution: '1K', credits: 1, completed_at: gen } },
    },
    assets: {},
    audio: {
      music: { file: `work/${STORY}/audio/music.mp3`, kind: 'music', song_id: 'song1' },
      'sfx-1': { file: `work/${STORY}/audio/sfx-01.mp3`, kind: 'sfx' },
    },
    voice: {
      voice_id: VOICE, picked_preview: 1,
      previews: [
        { n: 1, generated_voice_id: VOICE, file: `work/${STORY}/voice-previews/preview-1.mp3`, duration_secs: 2.0 },
        { n: 2, generated_voice_id: 'gen2', file: `work/${STORY}/voice-previews/preview-2.mp3`, duration_secs: 3.0 },
        { n: 3, generated_voice_id: 'gen3', file: `work/${STORY}/voice-previews/preview-3.mp3`, duration_secs: 2.0 },
      ],
    },
    narration: {
      model_id: 'eleven_v4', voice_id: VOICE, language_code: 'uk', output_format: 'mp3_44100_128',
      parts: {
        [hashA]: { hash: hashA, mp3: `work/${STORY}/narration.part-${hashA}.mp3`, response_file: `work/${STORY}/narration.part-${hashA}.response.json`, chars_sent: TEXT_A.length, credits: 18, fragments: [1], generated_at: gen },
        [HASH_B]: { hash: HASH_B, mp3: `work/${STORY}/narration.part-${HASH_B}.mp3`, response_file: `work/${STORY}/narration.part-${HASH_B}.response.json`, chars_sent: TEXT_B.length, credits: 42, fragments: [2, 3], generated_at: new Date((T0 + 31) * 1000).toISOString() },
      },
      file: `work/${STORY}/narration.mp3`, active_parts: [hashA, HASH_B],
    },
  };
  const w = (rel: string): string => join(root, rel);
  writeFileSync(w(`stories/${STORY}/manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  const timings = {
    version: 1, story: STORY, part_gap: 1.5, duration: dA + 1.5 + dB, parts: [{ index: 0, fragments: [1], offset: 0, duration: dA }, { index: 1, fragments: [2, 3], offset: dA + 1.5, duration: dB }],
  };
  writeFileSync(w(`stories/${STORY}/timings.json`), JSON.stringify(timings));
  const mock = await startMock(dir, { streamOk: opts.streamOk });
  const client = new ElevenLabsClient({ apiKey: 'sk_test_SECRETSECRET123', baseUrl: mock.url, sleep: async () => undefined, print: () => undefined, maxAttempts: 2, verifyDelayMs: 0 });
  return { root, client, mock, w };
}

const find = (plan: Plan, text: string) => plan.items.find((i) => i.label.includes(text))!;

describe('відновлення медіа: таймінги з історії', () => {
  it('«end» у записі історії це тривалість: перетворюється на час закінчення', () => {
    const r = historyAlignmentToResponse({ characters: ['a', 'b', 'c'], character_start_times_seconds: [0, 0.1, 0.25], character_end_times_seconds: [0.1, 0.15, 0.05] });
    assert.deepEqual(r.character_end_times_seconds, [0.1, 0.25, 0.3]);
  });
  it('таймінги, які вже мають вигляд відповіді озвучення, не чіпає', () => {
    const a = { characters: ['a', 'b'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] };
    assert.deepEqual(historyAlignmentToResponse(a), a);
  });
});

describe('відновлення медіа: сухий прогін і --run на підставному сервері', () => {
  it('сухий прогін знаходить частини за хешем (а не за схожим текстом), нічого не пише', async () => {
    const { client, w } = await setup();
    const plan = await buildPlan(client, { story: STORY });
    const a = find(plan, `Частина озвучення ${HASH_A}`);
    assert.equal(a.state, 'restorable');
    assert.match(a.source!, /hA/, 'приманка hC (схожий текст, час поруч) не береться');
    assert.equal(plan.historyIds.get(HASH_A), 'hA');
    assert.equal(plan.historyIds.get(HASH_B), 'hB');
    assert.equal(find(plan, 'narration.mp3').state, 'restorable');
    assert.ok(!existsSync(w(`work/${STORY}`)), 'сухий прогін нічого не завантажує');
    const report = renderReport(plan, false);
    assert.match(report, /СУХИЙ ПРОГІН/);
    assert.match(report, /ВІДНОВИТИ НЕ МОЖНА/);
  });

  it('--run: частини, response.json, narration.mp3, проба, картинка; решта в переліку «не можна»; маніфест лише з history_item_id', async () => {
    const { client, w } = await setup();
    // Файл, який уже є, не перезаписується.
    mkdirSync(w(`work/${STORY}/voice-previews`), { recursive: true });
    writeFileSync(w(`work/${STORY}/voice-previews/preview-3.mp3`), 'вже є');
    const before = JSON.parse(readFileSync(w(`stories/${STORY}/manifest.json`), 'utf8'));
    const plan = await buildPlan(client, { story: STORY });
    const res = await executePlan(plan);
    assert.equal(res.failed.length, 0, JSON.stringify(res.failed.map((f) => f.error)));
    assert.equal(res.idsWritten, 2);

    for (const h of [HASH_A, HASH_B]) {
      assert.ok(existsSync(w(`work/${STORY}/narration.part-${h}.mp3`)));
      const resp = JSON.parse(readFileSync(w(`work/${STORY}/narration.part-${h}.response.json`), 'utf8')) as { audio_base64: string; alignment: { character_end_times_seconds: number[] } };
      assert.ok(resp.audio_base64.length > 100);
      assert.equal(resp.alignment.character_end_times_seconds[2], 0.15, 'кінець = початок + тривалість');
    }
    const dur = probeDuration(w(`work/${STORY}/narration.mp3`))!;
    const t = JSON.parse(readFileSync(w(`stories/${STORY}/timings.json`), 'utf8')) as { duration: number };
    assert.ok(Math.abs(dur - t.duration) < 0.25, `${dur} проти ${t.duration}`);
    assert.ok(existsSync(w(`work/${STORY}/voice-previews/preview-1.mp3`)), 'обрана проба зі зразка голосу');
    assert.equal(readFileSync(w(`work/${STORY}/voice-previews/preview-3.mp3`), 'utf8'), 'вже є', 'наявний файл не перезаписано');
    assert.ok(!existsSync(w(`work/${STORY}/voice-previews/preview-2.mp3`)));
    assert.ok(existsSync(w(`work/${STORY}/frames/frame-01.png`)));
    assert.ok(!existsSync(w(`work/${STORY}/frames/frame-02.png`)), '404 на сервері: відновити не можна');
    assert.ok(!existsSync(w(`work/${STORY}/frames/frame-03.png`)), 'триває генерація: не чіпаємо');
    assert.equal(find(plan, 'frame/03').state, 'skipped');
    assert.equal(find(plan, 'Проба голосу 2').state, 'unrecoverable');
    assert.equal(find(plan, 'Картинка frame/02').state, 'unrecoverable');
    assert.equal(find(plan, 'Музика music').state, 'unrecoverable');

    const after = JSON.parse(readFileSync(w(`stories/${STORY}/manifest.json`), 'utf8'));
    assert.equal(after.narration.parts[HASH_A].history_item_id, 'hA');
    assert.equal(after.narration.parts[HASH_B].history_item_id, 'hB');
    delete after.narration.parts[HASH_A].history_item_id;
    delete after.narration.parts[HASH_B].history_item_id;
    assert.deepEqual(after, before, 'у маніфесті змінився лише history_item_id');
    assert.equal(readManifest(STORY).story, STORY);
    assert.ok(getRoot());
  });

  it('слабка відповідність (хеш не збігся, довжина й час збігаються): без --accept-weak пропуск', async () => {
    const { client } = await setup({ hashA: 'deadbeef00' });
    const weak = await buildPlan(client, { story: STORY });
    const a = find(weak, 'Частина озвучення deadbeef00');
    assert.equal(a.state, 'skipped');
    assert.match(a.reason!, /--accept-weak/);
    assert.equal(find(weak, 'narration.mp3').state, 'unrecoverable', 'без частини narration.mp3 не збереш');
    const accepted = await buildPlan(client, { story: STORY, acceptWeak: true });
    assert.equal(find(accepted, 'Частина озвучення deadbeef00').state, 'restorable');
  });

  it('проба з потоковим переглядом доступна, без нього ні', async () => {
    const { client } = await setup({ streamOk: true });
    const plan = await buildPlan(client, { story: STORY });
    assert.equal(find(plan, 'Проба голосу 3').state, 'restorable');
    assert.equal(find(plan, 'Проба голосу 2').state, 'unrecoverable');
    assert.match(find(plan, 'Проба голосу 2').reason!, /не обрана/);
  });
});

describe('огляд без проб голосу', () => {
  it('відсутній файл проби лишається в списку і показується текстом, а не зламаним плеєром', async () => {
    await setup();
    const manifest = readManifest(STORY);
    const warnings: string[] = [];
    const media: string[] = [];
    const previews = gatherPreviews(STORY, manifest, (key) => (media.push(key), false), warnings);
    assert.deepEqual(previews.map((p) => p.n), [1, 2, 3]);
    assert.equal(previews.find((p) => p.chosen)!.n, 1);
    assert.match(warnings.join('\n'), /Проби голосу 1, 2, 3: файлів немає/);
    const html = renderVoiceBody({ previews, rel: () => undefined });
    assert.equal((html.match(/Файл проби недоступний/g) ?? []).length, 3);
    assert.ok(!html.includes('<audio'), 'без файлу плеєра немає');
    const withFile = renderVoiceBody({ previews, rel: (k) => (k === 'preview:1' ? 'media/voice/preview-1.mp3' : undefined) });
    assert.equal((withFile.match(/<audio/g) ?? []).length, 1);
    assert.equal((withFile.match(/Файл проби недоступний/g) ?? []).length, 2);
  });
});
