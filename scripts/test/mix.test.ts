import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CH, SR, dbAt, envelopePoints, mixVoiceAndMusic, rmsOver, speechIntervals, toDb } from '../lib/mix';

/** Синусоїда стерео з амплітудою amp на інтервалах (або всюди). */
function sine(seconds: number, freq: number, amp: number, on?: Array<[number, number]>): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR) * CH);
  for (let f = 0; f < out.length / CH; f++) {
    const t = f / SR;
    if (on && !on.some(([a, b]) => t >= a && t < b)) continue;
    const v = amp * Math.sin(2 * Math.PI * freq * t);
    out[f * CH] = v;
    out[f * CH + 1] = v;
  }
  return out;
}

describe('зразок зведення', () => {
  it('інтервали мовлення: короткі проміжки між словами зливаються', () => {
    const iv = speechIntervals([{ start: 0, end: 1 }, { start: 1.2, end: 2 }, { start: 4, end: 5 }], 0.5);
    assert.deepEqual(iv, [{ a: 0, b: 2 }, { a: 4, b: 5 }]);
  });

  it('крива: у паузах pauseDb, під голосом underDb, приглушення починається за fade до слова', () => {
    const pts = envelopePoints([{ a: 2, b: 4 }, { a: 8, b: 9 }], -18, -8, 0.6);
    assert.equal(dbAt(pts, 0.5), -8);
    assert.equal(dbAt(pts, 3), -18);
    assert.equal(dbAt(pts, 1.4), -8);
    assert.ok(Math.abs(dbAt(pts, 1.7) - -13) < 1e-6, 'посередині ковзання -13');
    assert.equal(dbAt(pts, 4.6), -8);
    assert.equal(dbAt(pts, 6), -8);
    assert.equal(dbAt(pts, 8.5), -18);
    assert.equal(dbAt(pts, 20), -8);
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i]!.t >= pts[i - 1]!.t);
  });

  it('коротка пауза: точки лишаються впорядкованими, музика не піднімається повністю', () => {
    const pts = envelopePoints([{ a: 1, b: 2 }, { a: 2.5, b: 3 }], -18, -8, 0.6);
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i]!.t >= pts[i - 1]!.t);
    assert.ok(dbAt(pts, 2.25) < -8 && dbAt(pts, 2.25) > -18);
  });

  it('вимірювання: музика на заданому рівні відносно голосу в мовленні й у паузах', () => {
    const seconds = 12;
    const speech: Array<[number, number]> = [[1, 5], [8, 10]];
    const voice = sine(seconds, 220, 0.3, speech);
    const music = sine(seconds, 880, 0.05); // інший рівень, його має вирівняти
    const words = [{ start: 1, end: 3 }, { start: 3.1, end: 5 }, { start: 8, end: 10 }];
    const r = mixVoiceAndMusic(voice, music, { underDb: -18, pauseDb: -8, fade: 0.6, pauseMin: 0.5, words, musicFadeIn: 0.3, musicFadeOut: 1 });
    // Музика окремо: віднімаємо голос
    const musicOnly = new Float32Array(r.pcm.length);
    for (let i = 0; i < musicOnly.length; i++) musicOnly[i] = (r.pcm[i]! - voice[i]! * r.peakScale);
    const voiceRms = rmsOver(voice, r.intervals) * r.peakScale;
    const under = toDb(rmsOver(musicOnly, [{ a: 2, b: 4 }]) / voiceRms);
    const pause = toDb(rmsOver(musicOnly, [{ a: 6, b: 7 }]) / voiceRms);
    assert.ok(Math.abs(under - -18) < 0.7, `під голосом ${under.toFixed(2)} дБ`);
    assert.ok(Math.abs(pause - -8) < 0.7, `в паузах ${pause.toFixed(2)} дБ`);
    assert.equal(r.musicShorterBy, 0);
  });

  it('музика коротша за вікно: попередження через musicShorterBy; без мовлення помилка', () => {
    const voice = sine(6, 220, 0.3, [[1, 5]]);
    const r = mixVoiceAndMusic(voice, sine(3, 880, 0.1), { underDb: -18, pauseDb: -8, fade: 0.5, pauseMin: 0.5, words: [{ start: 1, end: 5 }], musicFadeIn: 0.3, musicFadeOut: 1 });
    assert.ok(r.musicShorterBy > 2.9);
    assert.throws(() => mixVoiceAndMusic(sine(2, 220, 0), sine(2, 880, 0.1), { underDb: -18, pauseDb: -8, fade: 0.5, pauseMin: 0.5, words: [{ start: 0, end: 1 }], musicFadeIn: 0.3, musicFadeOut: 1 }), /не знайдено мовлення/);
  });
});
