import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildFilmProps, checkNumbers, parseCamera, type SheetRow } from '../lib/film-props';
import { buildCards, cardFrames, normalizeWords, splitPhrases, type SubWord, type TimedWord } from '../lib/subtitles';
import { paths } from '../lib/paths';

// Слова фрагмента 1 з timings.json фільму 01-natalia.
const F1: TimedWord[] = [
  ['У', 0.08, 0.12], ['липні', 0.16, 0.48], ['дві', 0.56, 0.68], ['тисячі', 0.72, 1.067], ['чотирнадцятого', 1.12, 1.92], ['року', 2, 2.4],
  ['з', 2.64, 2.72], ['родиною', 2.8, 3.2], ['виїхали', 3.28, 3.68], ['з', 3.76, 3.8], ['рідного', 3.84, 4.16], ['міста', 4.24, 4.48],
  ['Донецька', 4.56, 5.28], ['до', 6.16, 6.24], ['Донецької', 6.28, 6.88], ['області,', 6.96, 7.76], ['яка', 8.16, 8.32], ['не', 8.4, 8.48],
  ['була', 8.56, 8.8], ['окупована.', 8.88, 9.8],
].map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }));

describe('субтитри: алгоритм розбиття', () => {
  it('фрагмент 1 з edit.md розкладається на вісім карток з аркуша', () => {
    const cards = buildCards(normalizeWords(F1)).map((c) => c.text);
    assert.deepEqual(cards, ['У липні дві', 'тисячі чотирнадцятого', 'року з родиною', 'виїхали з рідного', 'міста Донецька', 'до Донецької області,', 'яка не була', 'окупована.']);
  });

  it('фрази ріжуться за розділовим знаком і за паузою від 0.4 с', () => {
    const phrases = splitPhrases(normalizeWords(F1)).map((p) => p.length);
    // пауза 5.28 → 6.16 після «Донецька», кома після «області,»
    assert.deepEqual(phrases, [13, 3, 4]);
  });

  it('жодна картка, крім останньої у фразі, не закінчується словом із 1–2 літер, якщо це можливо', () => {
    const cards = buildCards(normalizeWords(F1));
    for (const c of cards.slice(0, -1)) {
      const lastWord = c.words[c.words.length - 1]!.text.replace(/[^\p{L}]/gu, '');
      assert.ok(lastWord.length > 2 || /[.,]$/.test(c.words[c.words.length - 1]!.text), c.text);
    }
  });

  it('фраза без правильного розкладу береться з найменшим числом порушень і потрапляє в relaxed', () => {
    const w = (text: string, i: number): SubWord => ({ text, start: i * 0.1, end: i * 0.1 + 0.08 });
    const words = ['Знаю', 'це', 'не', 'з', 'чуток,'].map(w);
    const relaxed: string[] = [];
    const cards = buildCards(words, undefined, relaxed).map((c) => c.text);
    assert.deepEqual(cards, ['Знаю це не', 'з чуток,']);
    assert.equal(relaxed.length, 1);
  });

  it('«Контакт ту ю» і «Фарба Фабра» зливаються, апостроф стає U+2019', () => {
    const words: TimedWord[] = [
      { text: 'проекту', start: 0, end: 0.4 },
      { text: '"Контакт', start: 0.42, end: 0.9 },
      { text: 'ту', start: 0.95, end: 1.0 },
      { text: 'ю",', start: 1.05, end: 1.3 },
      { text: 'дев\'яти', start: 1.4, end: 1.8 },
      { text: '"Фарба', start: 1.9, end: 2.2 },
      { text: 'Фабра".', start: 2.25, end: 2.8 },
    ];
    const n = normalizeWords(words);
    assert.deepEqual(n.map((x) => x.text), ['проекту', '«Контакт2u»,', 'дев’яти', '«ФарбаФабра».']);
    assert.equal(n[1]!.start, 0.42);
    assert.equal(n[1]!.end, 1.3);
    assert.equal(n[3]!.end, 2.8);
  });

  it('прямі лапки поза правилами злиття дають помилку', () => {
    assert.throws(() => normalizeWords([{ text: '"слово"', start: 0, end: 1 }]), /прямі лапки/);
  });

  it('кадри: старт за 2 кадри до слова, 3 кадри поява, зникнення через 6 кадрів, не менше 15 кадрів', () => {
    const cards = cardFrames(buildCards(normalizeWords(F1)).slice(0, 1));
    // «У липні дві»: 0.08 + 3.0 = 3.08 с → 92 кадр, старт 90; кінець «дві» 0.68 + 3 = 3.68 с → 110, зникає з 116 до 119
    assert.deepEqual(cards[0], { text: 'У липні дві', inFrame: 90, inEnd: 93, outFrame: 116, outEnd: 119 });
  });

  it('коротка картка лишається на екрані не менше 15 кадрів', () => {
    const cards = cardFrames([{ words: [{ text: 'так', start: 1, end: 1.05 }], text: 'так' }]);
    assert.equal(cards[0]!.outEnd - cards[0]!.inFrame, 15);
  });

  it('наступна картка, що починається раніше, ніж старша зникла, розчиняється з нею за 3 кадри', () => {
    const cards = cardFrames([
      { words: [{ text: 'а', start: 1, end: 1.5 }], text: 'а' },
      { words: [{ text: 'б', start: 1.4, end: 1.8 }], text: 'б' },
    ]);
    assert.equal(cards[1]!.inFrame, Math.round(4.4 * 30) - 2);
    assert.equal(cards[0]!.outFrame, cards[1]!.inFrame);
    assert.equal(cards[0]!.outEnd, cards[1]!.inEnd);
  });
});

describe('камера з аркуша', () => {
  it('наїзд з центром без зсуву', () => {
    const c = parseCamera('наїзд 100% → 103%, центр (0.50; 0.50) без зсуву, дуже повільно', 1, 264, 0);
    assert.deepEqual(c, { s0: 1, s1: 1.03, cx0: 0.5, cy0: 0.5, cx1: 0.5, cy1: 0.5, holdFrame: 264 });
  });
  it('статика: «масштаб N%» і один центр', () => {
    const c = parseCamera('статика, масштаб 106%, центр (0.50; 0.50), точно як кадр 4', 3, 229, 349);
    assert.equal(c.s0, 1.06);
    assert.equal(c.s1, 1.06);
  });
  it('панорама: «при масштабі N%» і два центри', () => {
    const c = parseCamera('вертикальна панорама вниз при масштабі 125%: центр (0.50; 0.43) → (0.50; 0.57), від рук', 12, 246, 1501);
    assert.equal(c.s0, 1.25);
    assert.equal(c.cy1, 0.57);
  });
  it('«від A до B с» зупиняє камеру в кадрі B', () => {
    const c = parseCamera('повільний від\'їзд 116% → 104%, центр (0.45; 0.52) → (0.50; 0.50) від 117.23 до 129.00 с, далі масштаб 104% нерухомий', 25, 503, 3517);
    assert.equal(c.holdFrame, 3870 - 3517);
  });
  it('вікно, що виходить за зображення, дає помилку', () => {
    assert.throws(() => parseCamera('наїзд 120% → 130%, центр (0.20; 0.50) → (0.50; 0.50)', 9, 100, 0), /виходить за зображення/);
  });
  it('без центру або масштабу падає з поясненням', () => {
    assert.throws(() => parseCamera('наїзд 100% → 103%', 1, 10, 0), /центр/);
    assert.throws(() => parseCamera('центр (0.5; 0.5)', 1, 10, 0), /масштаб/);
  });
});

describe('числа для збирання', () => {
  const rows = (): SheetRow[] => [
    { n: 1, start: 0, end: 100, length: 100, transition: 30 },
    { n: 2, start: 70, end: 200, length: 130, transition: 0 },
  ];
  it('узгоджена таблиця проходить', () => checkNumbers(rows(), 200, 2));
  it('перехід, що не збігається з перекриттям, дає помилку', () => {
    const r = rows();
    r[1]!.start = 60;
    r[1]!.length = 140;
    assert.throws(() => checkNumbers(r, 200, 2), /перехід у таблиці 30/);
  });
  it('сума, що не дорівнює довжині фільму, дає помилку', () => assert.throws(() => checkNumbers(rows(), 201, 2), /фільм має 201/));
});

describe('збирання пропсів із поточного edit.md', { skip: !existsSync(paths.storyFile('01-natalia', 'edit.md')) || !existsSync(paths.timings('01-natalia')) }, () => {
  const { props } = buildFilmProps({ story: '01-natalia', audioExists: true });
  it('25 кадрів, кінець останнього збігається з довжиною фільму', () => {
    assert.equal(props.shots.length, 25);
    assert.equal(props.shots[24]!.endFrame, props.durationInFrames);
    assert.equal(props.shots[0]!.startFrame, 0);
  });
  it('перехід у кадр N дорівнює перекриттю з попереднім, зерно маски в кожному своє', () => {
    for (let i = 1; i < props.shots.length; i++) assert.equal(props.shots[i - 1]!.endFrame - props.shots[i]!.startFrame, props.shots[i]!.revealFrames);
    const seeds = new Set(props.shots.slice(1).map((s) => s.reveal!.seed));
    assert.equal(seeds.size, 24);
  });
  it('усе серіалізується в JSON без втрат', () => assert.deepEqual(JSON.parse(JSON.stringify(props)), props));
  it('у субтитрах Контакт2u і ФарбаФабра', () => {
    const all = props.subtitles.cards.map((c) => c.text).join(' ');
    assert.match(all, /Контакт2u/);
    assert.match(all, /ФарбаФабра/);
    assert.doesNotMatch(all, /Контакт ту ю|Фарба Фабра/);
  });
});
