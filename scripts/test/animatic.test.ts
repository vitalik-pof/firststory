import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSchedule, slotAt } from '../lib/animatic';
import { renderAnimatic } from '../lib/review-html';
import type { TimingsFile } from '../lib/timings';

describe('розклад аніматика', () => {
  const frags = [{ n: 1, start: 0.4 }, { n: 2, start: 10 }, { n: 3, start: 14 }, { n: 4, start: 20 }];
  it('кадр від початку свого фрагмента, кілька кадрів ділять час порівну', () => {
    const { slots, fragmentsWithoutFrames } = buildSchedule(
      frags,
      [{ n: 1, fragment: 1 }, { n: 2, fragment: 1 }, { n: 3, fragment: 2 }, { n: 4, fragment: 4 }, { n: 5, fragment: 4 }, { n: 6, fragment: 4 }],
      32,
    );
    assert.deepEqual(fragmentsWithoutFrames, [3]);
    // фрагмент 1: вікно 0–10, два кадри по 5 с; перший з нуля
    assert.deepEqual(slots.slice(0, 2).map((s) => [s.frame, s.start, s.end]), [[1, 0, 5], [2, 5, 10]]);
    assert.deepEqual([slots[2]!.frame, slots[2]!.start, slots[2]!.end], [3, 10, 14]);
    // останній фрагмент: 20–32, три кадри по 4 с
    assert.deepEqual(slots.slice(3).map((s) => s.start), [20, 24, 28]);
    assert.equal(slotAt(slots, 0)!.frame, 1);
    assert.equal(slotAt(slots, 9.99)!.frame, 2);
    assert.equal(slotAt(slots, 10)!.frame, 3);
    assert.equal(slotAt(slots, 15)!.frame, 3, 'фрагмент без кадру: тримається попередній');
    assert.equal(slotAt(slots, 31)!.frame, 6);
  });
  it('кадр на неіснуючий фрагмент — помилка', () => {
    assert.throws(() => buildSchedule(frags, [{ n: 1, fragment: 9 }], 30), /фрагмент 9/);
  });
});

describe('плеєр аніматика', () => {
  const timings = { duration: 10, silent_fragments: [], fragments: [{ n: 1, start: 0, end: 9, text: 'а', words: [{ text: 'а', start: 0, end: 1 }] }] } as unknown as TimingsFile;
  const items = [{ n: 1, fragment: 1, src: 'media/frames/frame-01.jpg' }];
  it('грає звук, який йому дали (зведення), а кадри йдуть за таймінгами голосу', () => {
    const html = renderAnimatic({ timings, audioSrc: 'media/mix.mp3', items, word: 'кадр', intro: 'x' });
    assert.match(html, /<audio id="anim-audio"[^>]*src="media\/mix\.mp3"/);
    assert.doesNotMatch(html, /narration\.mp3/);
    assert.match(html, /"slots":\[\{"start":0,"end":10,"frame":1/);
  });
  it('без звуку аніматик недоступний', () => {
    assert.match(renderAnimatic({ timings, items, word: 'кадр', intro: 'x' }), /недоступний/);
  });
});
