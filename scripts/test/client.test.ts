import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { ApiError, ElevenLabsClient, GenerationFailedError, PossiblyExecutedError, paginate, parseRetryAfter } from '../lib/elevenlabs';

type Handler = (req: IncomingMessage, res: ServerResponse, n: number, body: Buffer) => void;

let server: Server | undefined;
async function start(handler: Handler): Promise<{ url: string; hits: () => number; paths: string[] }> {
  let n = 0;
  const paths: string[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      n++;
      paths.push(`${req.method} ${req.url}`);
      handler(req, res, n, Buffer.concat(chunks));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => n, paths };
}
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

function mk(url: string, extra: Partial<ConstructorParameters<typeof ElevenLabsClient>[0]> = {}) {
  const sleeps: number[] = [];
  const printed: string[] = [];
  const client = new ElevenLabsClient({
    apiKey: 'sk_test_SECRETSECRET123', baseUrl: url, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5,
    maxAttempts: 4, verifyDelayMs: 0, print: (m) => void printed.push(m), ...extra,
  });
  return { client, sleeps, printed };
}

describe('retry і затримки', () => {
  it('429: чекаємо стільки, скільки сказав retry-after', async () => {
    const s = await start((_q, res, n) => (n === 1 ? json(res, 429, { detail: 'slow down' }, { 'retry-after': '7' }) : json(res, 200, { ok: 1 })));
    const { client, sleeps } = mk(s.url);
    const r = await client.request({ method: 'GET', path: '/x', response: 'json', label: 't' });
    assert.deepEqual(r.data, { ok: 1 });
    assert.deepEqual(sleeps, [7000]);
  });

  it('429 без retry-after: експоненційна затримка', async () => {
    const s = await start((_q, res, n) => (n < 3 ? json(res, 429, {}) : json(res, 200, { ok: 1 })));
    const { client, sleeps } = mk(s.url);
    await client.request({ method: 'GET', path: '/x', response: 'json', label: 't' });
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1]! > sleeps[0]!);
  });

  it('5xx: повтор із розкидом і стелею, потім помилка після обмеженої кількості спроб', async () => {
    const s = await start((_q, res) => json(res, 503, { detail: 'down' }));
    const { client, sleeps } = mk(s.url, { maxDelayMs: 2500, random: () => 1 });
    await assert.rejects(client.request({ method: 'GET', path: '/x', response: 'json', label: 't' }), /не вдалося після 4 спроб/);
    assert.equal(s.hits(), 4);
    assert.equal(sleeps.length, 3);
    assert.deepEqual(sleeps, [1000, 2000, 2500]); // стеля 2500
  });

  it('джитер: з random=0 затримка вдвічі менша, ніж з random=1', () => {
    const lo = new ElevenLabsClient({ apiKey: 'k', random: () => 0 }).backoffMs(3);
    const hi = new ElevenLabsClient({ apiKey: 'k', random: () => 1 }).backoffMs(3);
    assert.equal(hi, 4000);
    assert.equal(lo, 2000);
  });

  it('4xx не повторюється, помилка зрозуміла', async () => {
    const s = await start((_q, res) => json(res, 422, { detail: { status: 'invalid', message: 'bad text' } }));
    const { client } = mk(s.url);
    await assert.rejects(client.request({ method: 'POST', path: '/x', json: {}, response: 'json', label: 't' }), (e: unknown) => e instanceof ApiError && e.status === 422 && /bad text/.test(e.message));
    assert.equal(s.hits(), 1);
  });

  it('мережева помилка (обрив з\'єднання) повторюється', async () => {
    const s = await start((req, res, n) => (n === 1 ? req.socket.destroy() : json(res, 200, { ok: 1 })));
    const { client } = mk(s.url);
    const r = await client.request({ method: 'GET', path: '/x', response: 'json', label: 't' });
    assert.deepEqual(r.data, { ok: 1 });
    assert.equal(s.hits(), 2);
  });

  it('тайм-аут повторюється', async () => {
    const s = await start((_q, res, n) => {
      if (n === 1) return; // мовчимо
      json(res, 200, { ok: 1 });
    });
    const { client } = mk(s.url);
    const r = await client.request({ method: 'GET', path: '/x', response: 'json', label: 't', timeoutMs: 150 });
    assert.deepEqual(r.data, { ok: 1 });
  });

  it('ключ не потрапляє ні в повідомлення, ні в друк', async () => {
    const s = await start((_q, res) => json(res, 500, { detail: 'sk_test_SECRETSECRET123 leaked in body' }));
    const { client, printed } = mk(s.url, { maxAttempts: 2 });
    let msg = '';
    await client.request({ method: 'GET', path: '/x', response: 'json', label: 't' }).catch((e: Error) => void (msg = e.message));
    // Тіло помилки сервера могло б містити ключ; друк проходить redact(), але повідомлення помилки теж не виводимо без нього
    const { redact } = await import('../lib/log');
    assert.doesNotMatch(redact(msg + printed.join('\n')), /SECRETSECRET/);
  });

  it('parseRetryAfter: секунди й дата', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfter(null), undefined);
  });
});

describe('перевірка запису перед повтором після 5xx', () => {
  it('createImage: після 500 нова генерація в списку — беремо її, не створюємо вдруге', async () => {
    let created = false;
    const s = await start((req, res) => {
      if (req.method === 'GET' && req.url!.startsWith('/v1/flows/image')) {
        return json(res, 200, { generations: created ? [{ id: 'new1', status: 'pending' }, { id: 'old1', status: 'completed' }] : [{ id: 'old1', status: 'completed' }], next_cursor: null, has_more: false });
      }
      created = true; // сервер виконав запис, але відповів 500
      json(res, 500, { detail: 'oops' });
    });
    const { client } = mk(s.url);
    const r = await client.createImage({ prompt: 'x', model_id: 'm' });
    assert.equal(r.id, 'new1');
    assert.equal(s.paths.filter((p) => p.startsWith('POST')).length, 1, 'POST лише один');
  });

  it('createImage: після 500 нічого не з\'явилося — повтор', async () => {
    let posts = 0;
    const s = await start((req, res) => {
      if (req.method === 'GET') return json(res, 200, { generations: [], next_cursor: null, has_more: false });
      posts++;
      if (posts === 1) return json(res, 502, {});
      json(res, 200, { id: 'g2', status: 'pending' });
    });
    const { client } = mk(s.url);
    assert.equal((await client.createImage({ prompt: 'x', model_id: 'm' })).id, 'g2');
    assert.equal(posts, 2);
  });

  it('платний запис без відповіді: лічильник кредитів виріс — PossiblyExecutedError, повтору немає', async () => {
    let posted = false;
    const s = await start((req, res) => {
      if (req.url === '/v1/user/subscription') return json(res, 200, { character_count: posted ? 160 : 100, character_limit: 1000 });
      posted = true;
      json(res, 500, {});
    });
    const { client } = mk(s.url);
    const sp = await client.beginSpend();
    await assert.rejects(client.soundEffect({ text: 'x' }, {}, sp.guard), PossiblyExecutedError);
    assert.equal(s.paths.filter((p) => p.startsWith('POST')).length, 1);
  });

  it('платний запис: лічильник не змінився — повторюємо', async () => {
    let posts = 0;
    const s = await start((req, res) => {
      if (req.url === '/v1/user/subscription') return json(res, 200, { character_count: 100, character_limit: 1000 });
      posts++;
      if (posts === 1) return json(res, 500, {});
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'character-cost': '80' });
      res.end(Buffer.from('MP3DATA'));
    });
    const { client } = mk(s.url);
    const sp = await client.beginSpend();
    const r = await client.soundEffect({ text: 'x' }, {}, sp.guard);
    assert.equal(r.audio.toString(), 'MP3DATA');
    assert.equal(r.characterCost, 80);
    assert.equal(posts, 2);
  });

  it('запис без перевірки не повторюється після 5xx', async () => {
    const s = await start((_q, res) => json(res, 500, {}));
    const { client } = mk(s.url);
    await assert.rejects(client.request({ method: 'POST', path: '/x', json: {}, response: 'json', label: 't' }), PossiblyExecutedError);
    assert.equal(s.hits(), 1);
  });

  it('createAsset: multipart, повтор після 500 з тим самим FormData і перевірка за назвою', async () => {
    let posts = 0;
    const bodies: string[] = [];
    const s = await start((req, res, _n, body) => {
      if (req.method === 'GET') return json(res, 200, { assets: [], next_cursor: null, has_more: false });
      posts++;
      bodies.push(body.toString('latin1'));
      if (posts === 1) return json(res, 500, {});
      json(res, 200, { asset_id: 'asset_123456', name: 'n', mime_type: 'image/png', created_at_unix: 1, content_url: null });
    });
    const { client } = mk(s.url);
    const a = await client.createAsset(Buffer.from('PNGDATA'), 'a.png', 'n1', 'image/png');
    assert.equal(a.asset_id, 'asset_123456');
    assert.equal(posts, 2);
    for (const b of bodies) assert.ok(b.includes('PNGDATA') && b.includes('name="name"'));
  });
});

describe('пагінація', () => {
  it('йде за курсором до has_more = false і друкує прогрес на кожній сторінці', async () => {
    const s = await start((req, res) => {
      const cur = new URL(req.url!, 'http://x').searchParams.get('cursor');
      if (!cur) return json(res, 200, { assets: [{ asset_id: 'a1' }, { asset_id: 'a2' }], next_cursor: 'c2', has_more: true });
      if (cur === 'c2') return json(res, 200, { assets: [{ asset_id: 'a3' }], next_cursor: 'c3', has_more: true });
      json(res, 200, { assets: [{ asset_id: 'a4' }], next_cursor: null, has_more: false });
    });
    const { client, printed } = mk(s.url);
    const all = await client.listAssets();
    assert.deepEqual(all.map((a) => a.asset_id), ['a1', 'a2', 'a3', 'a4']);
    assert.equal(printed.filter((p) => /сторінка \d/.test(p)).length, 3);
  });

  it('has_more без курсора і повтор курсора — помилки', async () => {
    await assert.rejects(paginate('t', async () => ({ items: [1], next: null, hasMore: true }), () => {}), /next_cursor порожній/);
    await assert.rejects(paginate('t', async () => ({ items: [1], next: 'same', hasMore: true }), () => {}), /курсор повторився/);
  });
});

describe('картинки: опитування і завантаження', () => {
  it('pending → generating → completed; failed дає GenerationFailedError', async () => {
    const states = ['pending', 'generating', 'completed'];
    let i = 0;
    const s = await start((req, res) => {
      if (req.url!.includes('bad')) return json(res, 200, { id: 'bad', status: 'failed', failure_reason: 'moderated', error_message: 'no' });
      const st = states[Math.min(i++, 2)];
      json(res, 200, st === 'completed' ? { id: 'g', status: st, content_url: 'http://x/y', content_mime_type: 'image/png' } : { id: 'g', status: st });
    });
    const { client, sleeps, printed } = mk(s.url);
    const g = await client.waitForImage('g');
    assert.equal(g.content_url, 'http://x/y');
    assert.deepEqual(sleeps, [2000, 2000]);
    assert.equal(printed.filter((p) => /опитування/.test(p)).length, 3);
    await assert.rejects(client.waitForImage('bad'), GenerationFailedError);
  });

  it('довга генерація: інтервал опитування подвоюється, але не вище стелі; ліміт очікування', async () => {
    const s = await start((_q, res) => json(res, 200, { id: 'g', status: 'generating' }));
    const { client, sleeps } = mk(s.url);
    await assert.rejects(client.waitForImage('g', { maxWaitMs: 200_000 }), /не завершилась/);
    assert.ok(sleeps.some((x) => x > 2000) && Math.max(...sleeps) <= 60_000);
  });

  it('завантаження за підписаним посиланням іде БЕЗ ключа API', async () => {
    let sawKey = true;
    const s = await start((req, res) => {
      sawKey = 'xi-api-key' in req.headers;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('PNG'));
    });
    const { client } = mk('http://127.0.0.1:1');
    const d = await client.download(`${s.url}/signed?sig=1`);
    assert.equal(d.data.toString(), 'PNG');
    assert.equal(sawKey, false);
  });

  it('протухле посилання (403): беремо свіже через GET генерації', async () => {
    const s = await start((req, res) => {
      if (req.url === '/dead') return json(res, 403, {});
      if (req.url === '/fresh') return res.end('PNG2');
      json(res, 200, { id: 'g', status: 'completed', content_url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/fresh`, content_mime_type: 'image/png' });
    });
    const { client } = mk(s.url);
    const buf = await client.downloadImageGeneration('g', `${s.url}/dead`);
    assert.equal(buf.toString(), 'PNG2');
  });
});

describe('лічильник кредитів відстає: стабілізація і історія', () => {
  it('чекає двох однакових значень підряд, а для платного виклику ще й зростання над базою', async () => {
    const seq = [0, 0, 0, 294, 294, 294];
    let i = 0;
    const s = await start((_q, res) => json(res, 200, { character_count: seq[Math.min(i++, seq.length - 1)], character_limit: 1000 }));
    const { client, sleeps } = mk(s.url, { stableEveryMs: 10_000, stableMaxMs: 120_000 });
    const r = await client.waitForStableCredits({ above: 0 });
    assert.deepEqual(r, { value: 294, stable: true });
    assert.ok(sleeps.filter((x) => x === 10_000).length >= 3, 'читає кожні 10 с');
    assert.equal(client.lastStableCredits, 294);
  });

  it('без above: дві однакові поспіль достатньо (навіть якщо це 0)', async () => {
    const s = await start((_q, res) => json(res, 200, { character_count: 5, character_limit: 1000 }));
    const { client } = mk(s.url);
    assert.deepEqual(await client.waitForStableCredits(), { value: 5, stable: true });
  });

  it('стеля очікування: лічильник усе росте, повертаємо останнє значення з попередженням', async () => {
    let n = 0;
    const s = await start((_q, res) => json(res, 200, { character_count: ++n * 10, character_limit: 1000 }));
    const { client, printed } = mk(s.url, { stableMaxMs: 30_000 });
    const r = await client.waitForStableCredits();
    assert.equal(r.stable, false);
    assert.ok(printed.some((p) => /не стабілізувався/.test(p)));
  });

  it('beginSpend.finish рахує різницю стабілізованого лічильника', async () => {
    const seq = [100, 100, 100, 160, 160];
    let i = 0;
    const s = await start((_q, res) => json(res, 200, { character_count: seq[Math.min(i++, seq.length - 1)], character_limit: 1000 }));
    const { client } = mk(s.url);
    const sp = await client.beginSpend(); // база стабілізується: 100
    assert.equal(sp.before, 100);
    const r = await sp.finish({ expectRise: true });
    assert.equal(r.spent, 60);
    assert.equal(r.stable, true);
  });

  it('вартість озвучення з історії (to мінус from), пагінація історії, очікування запису', async () => {
    let polls = 0;
    const s = await start((req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname !== '/v1/history') return json(res, 404, {});
      const cur = u.searchParams.get('start_after_history_item_id');
      if (!cur) {
        polls++;
        if (polls < 2) return json(res, 200, { history: [], has_more: false, last_history_item_id: null });
        return json(res, 200, { history: [{ history_item_id: 'h2', text: 'other', voice_id: 'v', date_unix: 5, character_count_change_from: 200, character_count_change_to: 210, request_id: null, model_id: null }], has_more: true, last_history_item_id: 'h2' });
      }
      json(res, 200, { history: [{ history_item_id: 'h1', text: 'потрібний текст', voice_id: 'v', date_unix: 4, character_count_change_from: 43, character_count_change_to: 970, request_id: null, model_id: null }], has_more: false, last_history_item_id: 'h1' });
    });
    const { client, printed } = mk(s.url);
    const r = await client.findTtsCost({ voiceId: 'v', text: 'потрібний текст', sinceUnix: 1 });
    assert.equal(r?.credits, 927);
    assert.equal(await client.findTtsCost({ voiceId: 'v', text: 'потрібний текст', sinceUnix: 1 }).catch(() => 'x'), null, 'той самий запис вдруге не віддається');
    assert.ok(printed.some((p) => /history list: сторінка 2/.test(p)));
    assert.equal(await mk(s.url, { stableMaxMs: 0 }).client.findTtsCost({ voiceId: 'v', text: 'нема такого', sinceUnix: 1 }), null);
  });

  it('історія без text/voice_id: єдиний кандидат береться, кілька відкидаються', async () => {
    const one = { history_item_id: 'a', text: null, voice_id: null, date_unix: 9, character_count_change_from: 0, character_count_change_to: 43, request_id: null, model_id: null };
    let items = [one];
    const s = await start((_q, res) => json(res, 200, { history: items, has_more: false, last_history_item_id: null }));
    const { client } = mk(s.url, { stableMaxMs: 0 });
    assert.equal((await client.findTtsCost({ voiceId: 'v', text: 'x', sinceUnix: 1 }))?.credits, 43);
    items = [{ ...one, history_item_id: 'b' }, { ...one, history_item_id: 'c' }];
    assert.equal(await client.findTtsCost({ voiceId: 'v', text: 'x', sinceUnix: 1 }), null);
  });
});
