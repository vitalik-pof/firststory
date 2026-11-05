import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { medianF0, speechSpan } from '../lib/pitch';
import { DocFormatError, readDoc } from '../lib/md';
import { paths } from '../lib/paths';
import {
  paceFromTimings, parseVoiceSamples, planShift, planVoices, rubberbandFilter, sampleHash, samplePace, MAX_SEMITONES, type SampleVoice,
} from '../lib/voice-samples';
import { pageTitle, renderPage, renderVoiceCard } from '../lib/voice-samples-page';
import { assembleSamples, recordSample, ttsParams } from '../lib/voice-samples-run';
import { STORY, makeMp3, mkProject } from './fixtures';

const SR = 16_000;

/** Синтетичне «мовлення»: гармоніки f0, обвідна на краях, тиша до й після. */
function voiced(f0: number, seconds: number, lead = 0, tail = 0, amp = 0.3): Float32Array {
  const n = Math.round((lead + seconds + tail) * SR);
  const x = new Float32Array(n);
  const a = Math.round(lead * SR);
  const b = Math.round((lead + seconds) * SR);
  for (let i = a; i < b; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    x[i] = amp * v * 0.5;
  }
  return x;
}

const SAMPLES_MD = `# Проби голосів v4: Як ми стали переселенцями?

## Текст проби
[warmly] Дочки мали піти в перший клас. [pause] [softly] Але не судилося.

## Голоси
- 49POAIkFDXsxrtR84sdj — natalia 01-natalia (наш нинішній, для порівняння)
- JOQst3wrnXwBfeTEW2ts — Yaryna Lisova - Natural Conversation
- BEprpS2vpgM32yNJpTXq — Alena

## Чому так
Пояснення.
`;

let root = '';
before(() => {
  root = mkProject();
  writeFileSync(paths.storyFile(STORY, 'voice-samples.md'), SAMPLES_MD);
});

describe('розбір voice-samples.md', () => {
  it('текст, голоси, примітки в дужках, заголовок', () => {
    const d = parseVoiceSamples(STORY);
    assert.equal(d.text, '[warmly] Дочки мали піти в перший клас. [pause] [softly] Але не судилося.');
    assert.equal(d.voices.length, 3);
    assert.deepEqual(d.voices[0], { voiceId: '49POAIkFDXsxrtR84sdj', name: 'natalia 01-natalia', note: 'наш нинішній, для порівняння', line: 7 });
    assert.equal(d.voices[1]!.name, 'Yaryna Lisova - Natural Conversation');
    assert.equal(d.voices[1]!.note, '');
    assert.equal(d.title, 'Як ми стали переселенцями?');
  });

  const doc = (text: string) => {
    const f = join(root, 'tmp-vs.md');
    writeFileSync(f, text);
    return readDoc(f, 'voice-director');
  };
  it('помилки формату називають рядок', async () => {
    const { parseVoiceSamplesText } = await import('../lib/voice-samples');
    assert.throws(() => parseVoiceSamplesText(doc('# X\n\n## Голоси\n- a — b\n')), DocFormatError);
    assert.throws(() => parseVoiceSamplesText(doc('# X\n\n## Текст проби\n[warmly Привіт.\n\n## Голоси\n- 49POAIkFDXsxrtR84sdj — A\n')), /квадратні дужки/);
    assert.throws(() => parseVoiceSamplesText(doc('# X\n\n## Текст проби\n[warmly] Привіт.\n\n## Голоси\n- 49POAIkFDXsxrtR84sdj — A\n- 49POAIkFDXsxrtR84sdj — B\n')), /уже є/);
    assert.throws(() => parseVoiceSamplesText(doc('# X\n\n## Текст проби\n[warmly] Привіт.\n\n## Голоси\nпросто текст\n')), /Рядок розділу «Голоси»/);
    assert.throws(() => parseVoiceSamplesText(doc('# X\n\n## Текст проби\n[warmly] [pause]\n\n## Голоси\n- 49POAIkFDXsxrtR84sdj — A\n')), /немає слів/);
  });
  it('голос у бектиках і з коротким тире', async () => {
    const { parseVoiceSamplesText } = await import('../lib/voice-samples');
    const d = parseVoiceSamplesText(doc('# X\n\n## Текст проби\n[warmly] Привіт.\n\n## Голоси\n- `49POAIkFDXsxrtR84sdj` - Alena (тест)\n'));
    assert.equal(d.voices[0]!.name, 'Alena');
    assert.equal(d.voices[0]!.note, 'тест');
  });
});

describe('голоси і хеш', () => {
  const v = (id: string, name: string): SampleVoice => ({ voiceId: id, name, note: '', line: 1 });
  it('наш голос першим, slug унікальні', () => {
    const p = planVoices([v('A'.repeat(20), 'Alena'), v('B'.repeat(20), 'Our'), v('C'.repeat(20), 'Alena')], 'B'.repeat(20), 'наш');
    assert.deepEqual(p.map((x) => x.slug), ['current', 'alena', 'alena-cccccc']);
    assert.equal(p[0]!.name, 'Our');
    assert.ok(p[0]!.current && !p[1]!.current);
  });
  it('нинішнього голосу немає в списку: додається', () => {
    const p = planVoices([v('A'.repeat(20), 'Alena')], 'Z'.repeat(20), 'наш голос');
    assert.equal(p.length, 2);
    assert.equal(p[0]!.voiceId, 'Z'.repeat(20));
  });
  it('хеш залежить від голосу, тексту і параметрів', () => {
    const p = ttsParams();
    const h = sampleHash('v1', 'текст', p);
    assert.equal(h, sampleHash('v1', 'текст', ttsParams()));
    assert.notEqual(h, sampleHash('v2', 'текст', p));
    assert.notEqual(h, sampleHash('v1', 'текст.', p));
    assert.notEqual(h, sampleHash('v1', 'текст', ttsParams({ stability: 0.5 })));
  });
});

describe('вимір: F0 і мовлення на синтетичному сигналі', () => {
  it('медіана F0 в межах 2% для 120, 225 і 300 Гц', () => {
    for (const f0 of [120, 225, 300]) {
      const m = medianF0(voiced(f0, 2), SR);
      assert.ok(m.hz !== null && Math.abs(m.hz - f0) / f0 < 0.02, `${f0} Гц виміряно як ${m.hz}`);
    }
  });
  it('тиша й шум не дають F0, медіана ігнорує неозвучені відрізки', () => {
    assert.equal(medianF0(new Float32Array(SR * 2), SR).hz, null);
    let s = 12345;
    const noise = new Float32Array(SR * 2).map(() => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.2);
    assert.equal(medianF0(noise, SR).hz, null);
    const a = voiced(200, 1);
    const mixed = new Float32Array(a.length * 3);
    mixed.set(a, 0);
    mixed.set(noise.subarray(0, a.length), a.length);
    mixed.set(voiced(200, 1), a.length * 2);
    const m = medianF0(mixed, SR);
    assert.ok(m.hz !== null && Math.abs(m.hz - 200) < 4);
  });
  it('тривалість мовлення без тиші на краях, пауза всередині лишається', () => {
    const sp = speechSpan(voiced(200, 3, 1, 0.5), SR);
    assert.ok(Math.abs(sp.duration - 3) < 0.06, `duration ${sp.duration}`);
    assert.ok(Math.abs(sp.start - 1) < 0.03);
    assert.ok(Math.abs(sp.total - 4.5) < 0.001);
    const a = voiced(200, 1);
    const x = new Float32Array(a.length * 2 + SR);
    x.set(a, 0);
    x.set(a, a.length + SR);
    assert.ok(Math.abs(speechSpan(x, SR).duration - 3) < 0.06);
  });
  it('темп: знаки без тегів на секунду, темп із timings.json', () => {
    assert.equal(samplePace('[warmly] абвгд [pause] еєжзи', 2), 11 / 2);
    const p = paceFromTimings({ fragments: [{ n: 1, start: 1, end: 3, text: 'abcdef', words: [] }, { n: 2, start: 5, end: 7, text: 'ghij', words: [] }] });
    assert.equal(p.chars, 10);
    assert.equal(p.seconds, 4);
    assert.equal(p.cps, 2.5);
  });
});

describe('розрахунок зсувів', () => {
  const target = { f0Hz: 225, paceCps: 14.8 };
  it('малий зсув застосовується повністю', () => {
    const p = planShift({ f0Hz: 200, paceCps: 13 }, target);
    assert.ok(Math.abs(p.appliedSemitones - 12 * Math.log2(225 / 200)) < 1e-9);
    assert.ok(Math.abs(p.appliedTempo - 14.8 / 13) < 1e-9);
    assert.ok(!p.pitchClamped && !p.tempoClamped && p.notes.length === 0);
    assert.ok(Math.abs(p.pitchRatio - 225 / 200) < 1e-9);
  });
  it('великий зсув обмежується і записується', () => {
    const p = planShift({ f0Hz: 150, paceCps: 9 }, target);
    assert.equal(p.appliedSemitones, MAX_SEMITONES);
    assert.ok(p.requestedSemitones > MAX_SEMITONES && p.pitchClamped);
    assert.equal(p.appliedTempo, 1.25);
    assert.ok(p.tempoClamped);
    assert.equal(p.notes.length, 2);
    const down = planShift({ f0Hz: 400, paceCps: 40 }, target);
    assert.equal(down.appliedSemitones, -MAX_SEMITONES);
    assert.equal(down.appliedTempo, 0.75);
  });
  it('F0 не виміряно: висоту не чіпаємо', () => {
    const p = planShift({ f0Hz: null, paceCps: 14.8 }, target);
    assert.equal(p.appliedSemitones, 0);
    assert.match(p.notes.join(), /F0/);
  });
  it('фільтр rubberband зберігає форманту', () => {
    const f = rubberbandFilter({ appliedTempo: 1.1, pitchRatio: 1.05 });
    assert.match(f, /^rubberband=tempo=1\.100000:pitch=1\.050000:formant=preserved/);
  });
});

describe('сторінка', () => {
  const pv = { name: 'Alena <b>', note: 'нота', current: false, alignedSrc: 'alena.mp3', rawSrc: 'raw/alena.mp3', f0Before: 198.4, f0After: 224.6, paceBefore: 12.94, paceAfter: 14.8, notes: [] };
  it('картка: два плеєри, рядок висоти й темпу, екранування', () => {
    const h = renderVoiceCard(pv);
    assert.match(h, /висота 198 → 225 Гц, темп 12,9 → 14,8 зн\/с/);
    assert.match(h, /src="alena\.mp3"/);
    assert.match(h, /src="raw\/alena\.mp3"/);
    assert.match(h, /Alena &lt;b&gt;/);
  });
  it('заголовок 2–4 слова, дизайн-вимоги', () => {
    assert.equal(pageTitle('Як ми стали переселенцями?'), 'Як ми стали переселенцями?');
    assert.equal(pageTitle('Одне'), 'Проби голосів v4');
    assert.equal(pageTitle('Дуже довгий заголовок на п’ять слів'), 'Проби голосів v4');
    const html = renderPage({ title: 'Проби голосів v4', textPlain: 'Текст', textTagged: '[a] Текст', targetF0: 225, targetPace: 14.8, voices: [pv], skipped: [] });
    assert.match(html, /:root \{/);
    assert.match(html, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
    assert.match(html, /:root\[data-theme="dark"\]/);
    assert.match(html, /body \{[^}]*background: var\(--bg\)/);
    assert.match(html, /padding: 16px 16px/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href="http|https?:\/\//);
    assert.match(html, /<details><summary>З тегами/);
  });
});

describe('наскрізно на підставних файлах: вирівнювання через rubberband', () => {
  it('проби вирівнюються, зсув обмежується, summary.json і index.html пишуться', () => {
    const doc = parseVoiceSamples(STORY);
    const params = ttsParams();
    const voices = planVoices(doc.voices, '49POAIkFDXsxrtR84sdj', 'наш');
    const dir = paths.workFile(STORY, 'voice-samples');
    mkdirSync(join(dir, 'raw'), { recursive: true });
    // Проба 1: 200 Гц, довжина така, що темп 13 зн/с (плавний зсув). Проба 2: 150 Гц, темп 9 (обидва зсуви обмежено).
    const plain = 'Дочки мали піти в перший клас. Але не судилося.'.length;
    const mk = (slug: string, f0: number, pace: number, voiceId: string, name: string) => {
      const file = join(dir, 'raw', `${slug}.mp3`);
      makeMp3(file, plain / pace, f0);
      recordSample(STORY, { hash: sampleHash(voiceId, doc.text, params), slug, voice_id: voiceId, name, raw_file: paths.rel(file), response_file: '', chars_sent: doc.text.length, credits: 100, credits_source: 'history', generated_at: 'x' }, params);
    };
    mk('current', 200, 13, voices[0]!.voiceId, voices[0]!.name);
    mk('yaryna-lisova-natural-conversation', 150, 9, voices[1]!.voiceId, voices[1]!.name);
    const res = assembleSamples({ story: STORY, doc, voices, params, targets: { f0Hz: 225, paceCps: 14.8, paceChars: 100, paceSeconds: 6.7, narrationFile: 'x.mp3' }, failures: new Map([[voices[2]!.voiceId, 'помилка 404']]) });
    assert.equal(res.voices.length, 2);
    const [a, b] = res.voices as [typeof res.voices[0], typeof res.voices[0]];
    assert.ok(a.f0_after_hz && Math.abs(a.f0_after_hz - 225) / 225 < 0.03, `F0 після ${a.f0_after_hz}`);
    assert.ok(Math.abs(a.pace_after_cps - 14.8) / 14.8 < 0.05, `темп після ${a.pace_after_cps}`);
    assert.equal(a.shifts.pitch_clamped, false);
    assert.ok(b.shifts.pitch_clamped && b.shifts.tempo_clamped);
    assert.equal(b.shifts.semitones_applied, 4);
    assert.equal(b.shifts.tempo_applied, 1.25);
    assert.ok(b.f0_after_hz && Math.abs(b.f0_after_hz - 150 * 2 ** (4 / 12)) / 190 < 0.03, `F0 після ${b.f0_after_hz}`);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0]!.reason, /404/);
    const summary = JSON.parse(readFileSync(res.summaryFile, 'utf8'));
    assert.equal(summary.voices.length, 2);
    assert.equal(summary.credits_total, 200);
    assert.equal(summary.voices[0].slug, 'current');
    assert.ok(existsSync(join(dir, 'current.mp3')));
    const html = readFileSync(res.indexFile, 'utf8');
    assert.match(html, /src="current\.mp3"/);
    assert.match(html, /Зсув обмежено/);
    assert.ok(res.pageBytes < 16 * 1024 * 1024);
  });
});
