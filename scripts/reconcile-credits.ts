// Звірка витрат кредитів у маніфесті з лічильником підписки.
//
// Лічильник character_count оновлюється з відставанням до хвилини, тому запуски скриптів могли
// записати неточні числа. Скрипт чекає стабілізації лічильника, порівнює з маніфестом, друкує
// розбіжність і (з --apply) виправляє маніфест:
//   - вартість частин озвучення береться з історії (character_count_change_to мінус from);
//   - проби голосу: кількість знаків тексту проби (правило з документації), якщо в маніфесті інше;
//   - credits.total_spent = стабілізований лічильник мінус база (лічильник на старті історії, --base, 0 за замовчуванням);
//   - credits.runs перераховуються за витратами елементів у часових межах кожного запуску.
// Платних викликів не робить (лише безкоштовні GET підписки й історії).
//
//   npx tsx scripts/reconcile-credits.ts --story 01-natalia            показати розбіжність
//   npx tsx scripts/reconcile-credits.ts --story 01-natalia --apply    виправити маніфест

import { parseArgs } from 'node:util';
import { UsageError, runMain } from './lib/cli';
import { ElevenLabsClient, type HistoryItem } from './lib/elevenlabs';
import { log } from './lib/log';
import { type Manifest, readManifest, writeManifest } from './lib/manifest';
import { assertStoryExists } from './lib/paths';

const HELP = `Звірка витрат кредитів.
  --story <id>   історія (обов'язково)
  --apply        записати виправлені числа в маніфест (без нього лише показує)
  --base N       лічильник кредитів на старті історії (0 за замовчуванням)`;

interface Part {
  hash: string;
  chars_sent?: number;
  credits?: number;
  credits_source?: string;
  generated_at?: string;
}

const ts = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

async function main(): Promise<void> {
  let values: { story?: string; apply?: boolean; base?: string; help?: boolean };
  try {
    values = parseArgs({ options: { story: { type: 'string' }, apply: { type: 'boolean' }, base: { type: 'string' }, help: { type: 'boolean' } }, strict: true }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return void log(HELP);
  if (!values.story) throw new UsageError('Потрібен --story <id>.');
  const story = values.story;
  assertStoryExists(story);
  const base = Number(values.base ?? 0);
  if (!Number.isFinite(base)) throw new UsageError('--base має бути числом.');

  const client = new ElevenLabsClient();
  const m = readManifest(story);
  log('Чекаємо, поки лічильник кредитів стабілізується…');
  const counter = await client.waitForStableCredits();
  const actual = counter.value - base;
  log(`\nЛічильник підписки: ${counter.value}${counter.stable ? '' : ' (НЕ стабілізувався, число може бути неточним)'}, база ${base}: фактично витрачено ${actual}.`);
  log(`Маніфест: credits.total_spent = ${m.credits.total_spent}. Розбіжність: ${actual - m.credits.total_spent >= 0 ? '+' : ''}${actual - m.credits.total_spent}.`);

  // Озвучення: вартість з історії.
  const parts = Object.values(((m.narration?.parts ?? {}) as Record<string, Part>));
  const voiceId = m.narration?.voice_id as string | undefined;
  const fixes = new Map<string, { credits: number; item: HistoryItem }>();
  if (parts.length && voiceId) {
    const times = parts.map((p) => ts(p.generated_at)).filter((t) => !Number.isNaN(t));
    const from = Math.floor(Math.min(...times) / 1000) - 600;
    const to = Math.ceil(Math.max(...times) / 1000) + 600;
    // У списку історії text і voice_id можуть бути порожні, тому зіставляємо за часом: запис історії
    // з'являється в момент завершення виклику, а generated_at ми записали одразу після нього.
    const items = (await client.listHistory({ voiceId, afterUnix: from, beforeUnix: to })).filter((i) => !i.model_id || i.model_id === (m.narration?.model_id ?? i.model_id));
    const used = new Set<string>();
    for (const p of [...parts].sort((x, y) => ts(x.generated_at) - ts(y.generated_at))) {
      const near = items
        .filter((i) => !used.has(i.history_item_id) && (i.text === null || i.text.length === p.chars_sent) && Math.abs(i.date_unix * 1000 - ts(p.generated_at)) <= 180_000)
        .sort((a, b) => Math.abs(a.date_unix * 1000 - ts(p.generated_at)) - Math.abs(b.date_unix * 1000 - ts(p.generated_at)))[0];
      if (near) {
        used.add(near.history_item_id);
        fixes.set(p.hash, { credits: near.character_count_change_to - near.character_count_change_from, item: near });
      }
    }
  }
  log('\nОзвучення (за історією):');
  for (const p of parts) {
    const f = fixes.get(p.hash);
    log(`  частина ${p.hash}: ${p.chars_sent} знаків; у маніфесті ${p.credits ?? '?'}; ${f ? `в історії ${f.credits} (${f.item.character_count_change_from} → ${f.item.character_count_change_to})` : 'в історії не знайдено'}`);
  }
  const probe = (m.voice?.probe_text as string | undefined)?.length;
  const designNow = (m.voice?.design_credits as number | undefined) ?? 0;
  if (probe !== undefined) log(`Проби голосу: у маніфесті ${designNow}; за документацією (знаки тексту проби) ${probe}.`);
  log('Музика й шуми:');
  for (const [k, a] of Object.entries(m.audio)) log(`  ${k}: у маніфесті ${a.credits ?? '?'}${a.character_cost_header !== undefined ? `, character-cost у відповіді ${a.character_cost_header}` : ''}`);
  if (!values.apply) {
    log('\nЦе показ. Щоб виправити маніфест: --apply.');
    return;
  }

  apply(m, { fixes, probe, actual, base });
  writeManifest(story, m);
  log(`\nМаніфест виправлено: total_spent = ${m.credits.total_spent}, запусків перераховано ${m.credits.runs.length}.`);
}

function apply(m: Manifest, o: { fixes: Map<string, { credits: number; item: HistoryItem }>; probe: number | undefined; actual: number; base: number }): void {
  const parts = (m.narration?.parts ?? {}) as Record<string, Part>;
  for (const [hash, f] of o.fixes) {
    const p = parts[hash]!;
    p.credits = f.credits;
    p.credits_source = 'history';
  }
  if (o.probe !== undefined && m.voice && m.voice.design_credits !== o.probe) {
    m.voice.design_credits = o.probe;
    m.voice.design_credits_source = 'docs';
  }
  // Музика й шуми: лічильник показує їх із запізненням (хвилини), а окремої ціни в API немає. Те, чого бракує
  // до сумарного лічильника, відносимо на аудіо-елементи без вартості: шум за character-cost із відповіді,
  // решту розподіляємо між музичними зразками пропорційно до тривалості (позначка counter-remainder, це наближення).
  const known = (m.voice?.design_credits as number | undefined ?? 0) + Object.values(parts).reduce((n, p) => n + (p.credits ?? 0), 0)
    + Object.values(m.images).reduce((n, r) => n + [r.current, ...r.history].reduce((k, v) => k + (v?.credits ?? 0), 0), 0)
    + Object.values(m.audio).reduce((n, a) => n + ((a.credits as number | undefined) ?? 0), 0);
  let remainder = o.actual - known;
  const unpriced = Object.values(m.audio).filter((a) => !a.credits);
  if (remainder > 0 && unpriced.length) {
    for (const a of unpriced.filter((x) => x.kind === 'sfx' && typeof x.character_cost_header === 'number')) {
      const c = Math.min(remainder, a.character_cost_header as number);
      a.credits = c;
      a.credits_source = 'header';
      remainder -= c;
    }
    const music = unpriced.filter((x) => !x.credits && x.kind === 'music');
    const secs = music.reduce((n, a) => n + ((a.seconds_requested as number | undefined) ?? 0), 0);
    if (remainder > 0 && music.length && secs > 0) {
      let left = remainder;
      music.forEach((a, i) => {
        const c = i === music.length - 1 ? left : Math.round((remainder * ((a.seconds_requested as number) ?? 0)) / secs);
        a.credits = c;
        a.credits_source = 'counter-remainder';
        left -= c;
      });
    }
  }
  for (const a of Object.values(m.audio)) if (!a.credits && a.credits_source === undefined) a.credits_source = 'unknown';
  // Елементи з часом: для розкладу за запусками.
  const items: Array<{ at: number; credits: number }> = [];
  const add = (at: unknown, credits: unknown): void => {
    const t = ts(at as string | undefined);
    if (!Number.isNaN(t) && typeof credits === 'number') items.push({ at: t, credits });
  };
  add(m.voice?.designed_at, m.voice?.design_credits);
  for (const p of Object.values(parts)) add(p.generated_at, p.credits);
  for (const a of Object.values(m.audio)) add(a.generated_at, a.credits);
  for (const rec of Object.values(m.images)) for (const v of [rec.current, ...rec.history]) add(v?.completed_at, v?.credits);
  const runs = [...m.credits.runs].sort((x, y) => ts(x.started_at) - ts(y.started_at));
  let cum = o.base;
  for (const r of runs) {
    const a = ts(r.started_at);
    const b = ts(r.finished_at) || a;
    const spent = items.filter((i) => i.at >= a - 1000 && i.at <= b + 1000).reduce((n, i) => n + i.credits, 0);
    r.credits_before = cum;
    r.credits_after = cum + spent;
    r.spent_run = spent;
    (r as unknown as Record<string, unknown>).reconciled = true;
    cum += spent;
  }
  m.credits.runs = runs;
  m.credits.total_spent = o.actual;
  (m.credits as unknown as Record<string, unknown>).reconciled_at = new Date().toISOString();
}

runMain(main);
