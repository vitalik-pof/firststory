import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Alignment } from '../lib/elevenlabs';
import { AlignmentMismatchError, alignToSentText, buildFragmentTimings, buildSpeechText, checkTimings } from '../lib/timings';

const fragments = [
  { n: 1, tagged: '[calmly] Ми виїхали влітку. [pause] [quietly] Було спекотно.' },
  { n: 2, tagged: '[softly] Дочки мали піти.' },
  { n: 5, tagged: '[pause] Але не судилося. [pause]' },
];

/** Синтетична відповідь: рівномірно 0.05 с на символ. `keep` вирішує, які символи потрапляють у відповідь. */
function fakeAlignment(sent: string, keep: (i: number) => boolean, mapChar: (c: string) => string = (c) => c): Alignment {
  const characters: string[] = [];
  const s: number[] = [];
  const e: number[] = [];
  let t = 0;
  for (let i = 0; i < sent.length; i++) {
    if (!keep(i)) continue;
    characters.push(mapChar(sent[i]!));
    s.push(Math.round(t * 1000) / 1000);
    t += 0.05;
    e.push(Math.round(t * 1000) / 1000);
  }
  return { characters, character_start_times_seconds: s, character_end_times_seconds: e };
}

describe('timings', () => {
  const { text, spans } = buildSpeechText(fragments, '\n\n');

  it('межі фрагментів і слова, теги у слова не потрапляють (теги є у відповіді)', () => {
    const t = buildFragmentTimings(text, spans, fakeAlignment(text, () => true), fragments);
    assert.deepEqual(t.map((f) => f.n), [1, 2, 5]);
    for (const f of t) for (const w of f.words) assert.doesNotMatch(w.text, /[\[\]]/);
    assert.deepEqual(t[0]!.words.map((w) => w.text), ['Ми', 'виїхали', 'влітку.', 'Було', 'спекотно.']);
    assert.equal(t[0]!.text, 'Ми виїхали влітку. Було спекотно.');
    assert.ok(t[0]!.end < t[1]!.start && t[1]!.end < t[2]!.start);
    assert.equal(t[2]!.words.length, 3);
    assert.deepEqual(checkTimings(t, 20), []);
  });

  it('те саме, коли API не повертає символи тегів', () => {
    const tagMask = new Set<number>();
    for (const m of text.matchAll(/\[[^\]]*\]/g)) for (let k = m.index!; k < m.index! + m[0].length; k++) tagMask.add(k);
    const a = fakeAlignment(text, (i) => !tagMask.has(i));
    const t = buildFragmentTimings(text, spans, a, fragments);
    assert.deepEqual(t[0]!.words.map((w) => w.text), ['Ми', 'виїхали', 'влітку.', 'Було', 'спекотно.']);
    assert.equal(t[2]!.words[0]!.text, 'Але');
  });

  it('пробіли в відповіді можуть відрізнятися (переноси рядків → пробіл, зайві пробіли)', () => {
    const a = fakeAlignment(text, () => true, (c) => (c === '\n' ? ' ' : c));
    const t = buildFragmentTimings(text, spans, a, fragments);
    assert.equal(t.length, 3);
  });

  it('розбіжність тексту — помилка з контекстом, а не вгадування', () => {
    const a = fakeAlignment(text, () => true, (c) => (c === 'Д' ? 'Б' : c));
    assert.throws(() => buildFragmentTimings(text, spans, a, fragments), AlignmentMismatchError);
    assert.throws(() => alignToSentText('abc def', [...'abc de']), /не озвучено/);
  });

  it('аудіо коротше за слова — попередження', () => {
    const t = buildFragmentTimings(text, spans, fakeAlignment(text, () => true), fragments);
    assert.ok(checkTimings(t, 1).length > 0);
  });
});
