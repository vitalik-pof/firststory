import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { endOfNarrationFrame, filmFrames, filmSecondsFromFrames } from '../lib/film-time';
import { baseMusicEnvelope, speechIntervals, withPatches } from '../lib/mix';
import { RULES, boostFileDb, boostFilmDb, checkRulesAgainstDoc, fileEventAtFilm, filmLengthFromArgs, isLanguageIndependentMix, musicLevelFn, musicSpeed, planLangMix, type TimingsForMix } from '../lib/mix-rules';
import type { EnvPatch } from '../lib/mix-spec';

const here = dirname(fileURLToPath(import.meta.url));
const uk126 = JSON.parse(readFileSync(join(here, 'data', 'timings-uk-126.json'), 'utf8')) as TimingsForMix;
const uk118 = JSON.parse(readFileSync(join(here, 'data', 'timings-uk-118.json'), 'utf8')) as TimingsForMix;
const near = (a: number, b: number, eps = 0.0011): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

describe('швидкість читання музики', () => {
  it('приклади з розділу «Зведення»', () => {
    assert.equal(musicSpeed(105).v, 1.056);
    assert.equal(musicSpeed(110).v, 1.009);
    assert.equal(musicSpeed(117.473).v, 0.946);
    assert.equal(musicSpeed(126.511).v, 0.88);
    assert.equal(musicSpeed(135).v, 0.826);
    assert.equal(musicSpeed(139.5).v, 0.8);
    assert.equal(musicSpeed(105).limited, null);
  });
  it('межі: за межею береться межа, і це видно', () => {
    assert.deepEqual(musicSpeed(145), { raw: 0.77, v: 0.8, limited: 'min' });
    assert.deepEqual(musicSpeed(100), { raw: 1.107, v: 1.08, limited: 'max' });
    assert.equal(musicSpeed(102.6).limited, null, '102.6 с ще в межах: 114/105.6 = 1.080 (округлено)');
    assert.equal(musicSpeed(139.5).limited, null);
    assert.equal(musicSpeed(139.6).limited, 'min');
    assert.equal(musicSpeed(102.5).limited, 'max');
  });
  it('події файлу на секундах фільму (f − 3) / v', () => {
    near(fileEventAtFilm(8, 0.88), 5.682);
    near(fileEventAtFilm(113, 0.88), 125);
  });
});

describe('підсилення початку в секундах файлу', () => {
  it('точки кривої і лінійність у дБ', () => {
    assert.equal(boostFileDb(3), 21);
    assert.equal(boostFileDb(4), 14);
    assert.equal(boostFileDb(8), 4);
    assert.equal(boostFileDb(12), 0);
    assert.equal(boostFileDb(50), 0);
    near(boostFileDb(9), 3, 1e-9);
    near(boostFileDb(3.5), 17.5, 1e-9);
  });
  it('для української (v = 0.88) точки лягають на секунди фільму 0, 1.14, 2.27, 3.41, 4.55, 5.68, 7.95, 10.23', () => {
    const v = 0.88;
    const film = RULES.boost.map(([f]) => Math.round(((f - 3) / v) * 100) / 100);
    assert.deepEqual(film, [0, 1.14, 2.27, 3.41, 4.55, 5.68, 7.95, 10.23]);
    assert.equal(boostFilmDb(0, v), 21);
    near(boostFilmDb(1.136, v), 14, 0.02);
  });
  it('залежить від v: при іншій швидкості та сама секунда файлу лягає на іншу секунду фільму', () => {
    assert.equal(boostFilmDb(0, 1.05), 21);
    assert.ok(boostFilmDb(2, 1.05) < boostFilmDb(2, 0.85), 'швидше читання: підсилення спадає раніше за секундами фільму');
  });
});

describe('регресія на українських таймінгах 126.511 с, L = 134.0', () => {
  const plan = planLangMix(uk126, 134.0);
  const w = (item: number) => plan.windows.find((x) => x.item === item)!;

  it('позначення з розділу «Зведення»', () => {
    assert.equal(plan.W1, 3.08);
    assert.equal(plan.E, 128.768);
    assert.equal(plan.O + plan.D, 129.511);
    assert.deepEqual(plan.P1, { a: 8.28, b: 9.16 });
    assert.deepEqual(plan.pauses, [{ a: 17.76, b: 19.067, g: 1.307 }]);
    assert.equal(plan.speed.v, 0.88);
    assert.equal(plan.speed.limited, null);
    assert.deepEqual(plan.warnings, []);
  });
  it('вікна пунктів 1–7 за значеннями «Україна: …»', () => {
    assert.deepEqual([w(1).from, w(1).to], [0, 3.08]);
    assert.deepEqual([w(2).from, w(2).to], [3.08, 8.28]);
    assert.deepEqual([w(3).from, w(3).to], [17.76, 20.66]);
    near(w(4).from, 45.99, 0.01);
    near(w(4).to, 52.04, 0.01);
    near(w(5).from, 80.37, 0.01);
    near(w(5).to, 84.85, 0.01);
    near(w(6).from, 109.7, 0.01);
    near(w(6).to, 119.41, 0.01);
    assert.deepEqual([w(7).from, w(7).to], [128.768, 134]);
  });
  it('події файлу для звіряння на слух', () => {
    assert.deepEqual(plan.fileEvents.map((e) => e.file), [8, 13, 16, 20, 27, 57, 103, 113]);
    near(plan.fileEvents[0]!.film, 5.682);
    near(plan.fileEvents[7]!.film, 125);
  });

  // Старі ділянки українського зведення (так їх розібрав попередній parseFilmMix із sound.md до переходу на правила).
  const P = (label: string, ...pts: Array<[number, number | 'base']>): EnvPatch => ({ label, points: pts.map(([t, db]) => ({ t, db })) });
  const oldPatches: EnvPatch[] = [
    P('початок', [0, -2], [1.8, -2], [3.08, -10]),
    P('фрагмент 1', [3.08, -10], [8.28, -10], [8.78, -4], [9.16, -4], [9.96, 'base']),
    P('кадр 4', [17.76, 'base'], [18.56, -4], [20.66, -4], [21.46, 'base']),
    P('кадр 18', [79.57, 'base'], [80.37, -8], [84.85, -8], [85.65, 'base']),
    P('фрагмент 16', [108.9, 'base'], [109.7, -10], [119.41, -10], [120.21, 'base']),
    P('кінець', [128.77, 'base'], [134, -2]),
  ];
  it('крива гучності збігається з нинішнім українським зведенням (допуск 0.05 дБ)', () => {
    const words = uk126.fragments.flatMap((f) => f.words).map((x) => ({ start: x.start + 3, end: x.end + 3 }));
    const oldLevel = withPatches(baseMusicEnvelope(speechIntervals(words, 1.2), -8, -2, 0.8), oldPatches);
    const newLevel = musicLevelFn(plan);
    let worst = 0;
    let at = 0;
    for (let t = 0; t <= 134; t += 0.02) {
      const d = Math.abs(oldLevel(t) - newLevel(t));
      if (d > worst) {
        worst = d;
        at = t;
      }
    }
    assert.ok(worst < 0.05, `найбільша різниця ${worst.toFixed(3)} дБ на ${at.toFixed(2)} с`);
  });
});

/** Синтетичні таймінги: 17 фрагментів по k слів, слова по 0.3 с із проміжком 0.1, між фрагментами 0.3 с (крім перед фрагментом 3). */
function synthetic(wordsPerFragment: number, gap3 = 1.5, wordLen = 0.3, innerGap = 0.1): TimingsForMix {
  let t = 0.08;
  const fragments: TimingsForMix['fragments'] = [];
  for (let n = 1; n <= 17; n++) {
    const words: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < wordsPerFragment; i++) {
      words.push({ start: Math.round(t * 1000) / 1000, end: Math.round((t + wordLen) * 1000) / 1000 });
      t += wordLen + (i < wordsPerFragment - 1 ? innerGap : 0);
      // у фрагменті 1 між третім і четвертим словом пауза 0.9 с (P1)
      if (n === 1 && i === 2) t += 0.9;
    }
    fragments.push({ n, start: words[0]!.start, end: words[words.length - 1]!.end, words });
    t += n === 2 ? gap3 : 0.3;
  }
  return { duration: Math.round((t - 0.3 + 0.05) * 1000) / 1000, fragments };
}

describe('зведення для іншої мови (синтетичні таймінги)', () => {
  it('усі вікна розраховано від слів цієї мови й не перекриваються', () => {
    const t = synthetic(8, 1.5, 0.7);
    const plan = planLangMix(t, 3.0 + t.duration + 5.2333);
    assert.equal(plan.W1, 3.08);
    assert.deepEqual(plan.P1, { a: 3 + t.fragments[0]!.words[2]!.end, b: 3 + t.fragments[0]!.words[3]!.start });
    assert.equal(plan.windows.length, 7);
    const s = (n: number) => t.fragments[n - 1]!.words[0]!.start + 3;
    near(plan.windows.find((x) => x.item === 3)!.to, s(4));
    near(plan.windows.find((x) => x.item === 4)!.from, s(8));
    near(plan.windows.find((x) => x.item === 4)!.to, s(9));
    const w5 = plan.windows.find((x) => x.item === 5)!;
    near(w5.from, s(12) + (s(13) - s(12)) / 3);
    near(w5.to, s(12) + (2 * (s(13) - s(12))) / 3);
    near(plan.E, t.fragments[16]!.words[7]!.end + 3);
    assert.equal(plan.pauses.length, 1, 'одна пауза довша за 1.2 с: перед фрагментом 3');
    assert.deepEqual(plan.warnings, []);
    // у вікні пункту 3 підйом пауз вимкнено: музика на -4 дБ там, де загальне правило підняло б до -2 дБ
    const level = musicLevelFn(plan);
    near(level(plan.pauses[0]!.a + 1.0), -4, 1e-6);
    // поза вікнами пауза піднімає: тут немає такої, перевіряємо -8 під голосом у середині фрагмента 10
    near(level(t.fragments[9]!.words[3]!.start + 3), -8, 1e-6);
  });
  it('пауза поза вікнами піднімає музику до -2 і повертає за 0.8 с після її кінця', () => {
    const t = synthetic(8, 1.5, 0.7);
    // розсуваємо фрагмент 13 на 2 с: між фрагментами 12 і 13 з'являється пауза 2.3 с поза вікнами пунктів
    // (вікно 5 це друга третина фрагмента 12, пауза в його кінці, після S(13) нічого не змінюється)
    const shifted: TimingsForMix = { duration: t.duration + 2, fragments: t.fragments.map((f) => (f.n < 14 ? f : { ...f, start: f.start + 2, end: f.end + 2, words: f.words.map((w) => ({ start: w.start + 2, end: w.end + 2 })) })) };
    const plan = planLangMix(shifted, 3 + shifted.duration + 5.2333);
    const p = plan.pauses.find((x) => x.a > 60 && Math.abs(x.g - 2.3) < 0.01)!;
    assert.ok(p, 'пауза знайдена');
    const level = musicLevelFn(plan);
    near(level(p.a), -8, 1e-6);
    near(level(p.a + 0.8), -2, 1e-6);
    near(level(p.b), -2, 1e-6);
    near(level(p.b + 0.4), -5, 1e-6);
    near(level(p.b + 0.8), -8, 1e-6);
  });
  it('найкоротша пауза, що вважається паузою (1.3 с), встигає піднятися до -2 дБ, а повернення починається з її кінця', () => {
    const t = synthetic(8, 1.5, 0.7);
    const shifted: TimingsForMix = { duration: t.duration + 1, fragments: t.fragments.map((f) => (f.n < 14 ? f : { ...f, start: f.start + 1, end: f.end + 1, words: f.words.map((w) => ({ start: w.start + 1, end: w.end + 1 })) })) };
    const plan = planLangMix(shifted, 3 + shifted.duration + 5.2333);
    const p = plan.pauses.find((x) => x.a > 60 && Math.abs(x.g - 1.3) < 0.01)!;
    const level = musicLevelFn(plan);
    near(level(p.a + 0.8), -2, 1e-6);
    near(level(p.b), -2, 1e-6);
    near(level(p.b + 0.8), -8, 1e-6);
  });
  it('швидкість і УВАГА за межами: довге озвучення', () => {
    const t = synthetic(10, 1.5, 0.7);
    assert.ok(t.duration > 139.5, `duration ${t.duration}`);
    const plan = planLangMix(t, 3 + t.duration + 5.2333);
    assert.equal(plan.speed.v, 0.8);
    assert.equal(plan.speed.limited, 'min');
    assert.match(plan.warnings.join(' '), /довше за 139\.5 с/);
    assert.match(plan.warnings.join(' '), /142\.5 с/);
    assert.match(plan.warnings.join(' '), /нова музика/i);
  });
  it('швидкість і УВАГА за межами: коротке озвучення', () => {
    const t = synthetic(6, 1.5, 0.8);
    assert.ok(t.duration < 102.6, `duration ${t.duration}`);
    const plan = planLangMix(t, 3 + t.duration + 5.2333);
    assert.equal(plan.speed.v, 1.08);
    assert.equal(plan.speed.limited, 'max');
    assert.match(plan.warnings.join(' '), /коротше за 102\.6 с/);
    assert.match(plan.warnings.join(' '), /101\.85\d* с/);
  });
  it('УВАГА, якщо перед «Але не судилося» немає довгої паузи; P1 нема чи коротка', () => {
    const t = synthetic(8, 0.3, 0.7);
    const plan = planLangMix(t, 3 + t.duration + 5.2333);
    assert.match(plan.warnings.join(' '), /немає паузи довшої за 1\.2 с/);
    const short = synthetic(8, 1.5, 0.7);
    short.fragments[0]!.words = short.fragments[0]!.words.map((w, i) => ({ start: 0.08 + i * 0.4, end: 0.08 + i * 0.4 + 0.3 }));
    const p2 = planLangMix({ ...short, fragments: short.fragments.map((f) => (f.n === 1 ? { ...f, start: 0.08, end: short.fragments[0]!.words[7]!.end } : f)) }, 130);
    assert.match(p2.warnings.join(' '), /P1 .* коротша за 0\.5 с/);
    near(p2.patches[1]!.points.length, 3, 0);
  });
  it('помилки з поясненням: L коротша за озвучення, немає фрагмента', () => {
    const t = synthetic(8);
    assert.throws(() => planLangMix(t, 3 + t.duration - 1), /коротша за O \+ D/);
    assert.throws(() => planLangMix({ ...t, duration: t.duration - 0.5, fragments: t.fragments }, 3 + t.fragments[16]!.words[7]!.end + 0.3), /E \+ 0\.75/);
    assert.throws(() => planLangMix({ ...t, fragments: t.fragments.filter((f) => f.n !== 8) }, 200), /немає фрагмента 8/);
  });
});

describe('довжина фільму', () => {
  it('рівно один параметр; без жодного помилка', () => {
    assert.throws(() => filmLengthFromArgs(118.518, {}), /Не задано жодного/);
    assert.throws(() => filmLengthFromArgs(118.518, { tail: '5', 'film-length': '130' }), /кілька/);
    assert.throws(() => filmLengthFromArgs(118.518, { tail: '-1' }), /додатним/);
    assert.throws(() => filmLengthFromArgs(118.518, { 'tail-frames': '1.5' }), /цілим/);
  });
  it('--tail, --film-length і --tail-frames', () => {
    assert.equal(filmLengthFromArgs(118.518, { 'film-length': '126.8' }).L, 126.8);
    assert.equal(filmLengthFromArgs(118.518, { tail: '5.2333' }).L, 126.751);
    assert.equal(filmLengthFromArgs(118.518, { 'tail-frames': '157' }).L, 3803 / 30);
  });
  it('кадри за правилами edit.md: українська 118.518 с дає tD = 3646 і 3803 кадри', () => {
    assert.equal(endOfNarrationFrame(118.518), 3646);
    assert.equal(filmFrames(118.518), 3803);
    assert.equal(filmSecondsFromFrames(118.518), 3803 / 30);
  });
});

describe('звіряння коду з розділом «Зведення» sound.md', () => {
  const sound = readFileSync(join(here, '..', '..', 'stories', '01-natalia', 'sound.md'), 'utf8');
  const mix = sound.slice(sound.indexOf('## Зведення'), sound.indexOf('## Питання'));
  it('поточний sound.md у новому форматі й збігається з кодом', () => {
    assert.equal(isLanguageIndependentMix(mix), true);
    assert.deepEqual(checkRulesAgainstDoc(mix), []);
  });
  it('змінене число в документі дає УВАГА, старий формат не вважається новим', () => {
    assert.match(checkRulesAgainstDoc(mix.replace('Музика під голосом -8 дБ', 'Музика під голосом -9 дБ')).join(' '), /-9, а в коді -8/);
    assert.match(checkRulesAgainstDoc(mix.replace('v = 114.0 / (O + D)', 'v = 110.0 / (O + D)')).join(' '), /110/);
    assert.match(checkRulesAgainstDoc(mix.replace('4.0 +14', '4.0 +13')).join(' '), /Крива підсилення/);
    assert.match(checkRulesAgainstDoc(mix.replace('Крива підсилення початку, у секундах файлу', 'Підсилення початку')).join(' '), /немає рядка/);
    assert.equal(isLanguageIndependentMix('Музика під голосом -20 дБ. Швидкість читання 0.95'), false);
  });
  it('регресія на поточних українських таймінгах 118.518 с: швидкість 0.938, довжина 126.767 с', () => {
    const plan = planLangMix(uk118, filmSecondsFromFrames(118.518));
    assert.equal(plan.speed.v, 0.938);
    near(plan.L, 126.767, 0.001);
  });
});
