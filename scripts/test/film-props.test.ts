import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFilmProps, cameraSpec, parseAnchorTable, parseCameraNumbers, parseConstants, parseExceptions, titleLines } from '../lib/film-props';
import { FrameRuleError, parseRule, planFrames, splitSentences, type TimingsT } from '../lib/film-frames';
import { buildCards, cardFrames, normalizeWords, normalizeWordsLang, splitPhrases, type SubWord, type TimedWord } from '../lib/subtitles';
import { readDoc } from '../lib/md';
import { paths } from '../lib/paths';
import type { ScriptDoc } from '../lib/docs';

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


describe('субтитри: правила для мов', () => {
  const w = (text: string, i: number): TimedWord => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 });
  const toks = (...t: string[]): TimedWord[] => t.map(w);

  it('токен без літер приклеюється до попереднього, відкриваюча лапка до наступного', () => {
    const r = normalizeWordsLang(toks('déplacés', '?', 'Il', 'a', 'dit', ':', '«', 'bonjour', '»', '!'), []);
    assert.deepEqual(r.map((x) => x.text), ['déplacés?', 'Il', 'a', 'dit:', '«bonjour»!']);
    assert.equal(r[0]!.end, 0.3 + 0.25, 'час приклеєного токена зливається з основним');
    assert.equal(r[4]!.start, 6 * 0.3, 'відкриваюча лапка дає початок слову');
  });

  it('назва: «Contact to You» → Contact2u з розділовим знаком з кінця (англійська)', () => {
    const r = normalizeWordsLang(toks('team', 'of', 'Contact', 'to', 'You,', 'where'), [{ spoken: 'Contact to You', shown: 'Contact2u' }]);
    assert.deepEqual(r.map((x) => x.text), ['team', 'of', 'Contact2u,', 'where']);
    assert.ok(Math.abs(r[2]!.start - 2 * 0.3) < 1e-9);
    assert.ok(Math.abs(r[2]!.end - (4 * 0.3 + 0.25)) < 1e-9);
  });

  it('назва без урахування регістру і з лапками на краях; «Farba Fabra.» → «FarbaFabra.»', () => {
    const r = normalizeWordsLang(toks('«Farba', 'fabra».'), [{ spoken: 'Farba Fabra', shown: 'FarbaFabra' }]);
    assert.deepEqual(r.map((x) => x.text), ['FarbaFabra.']);
  });

  it('запис «Назв», якого немає в словах, дає помилку з назвою запису', () => {
    assert.throws(() => normalizeWordsLang(toks('hello', 'world'), [{ spoken: 'Contact tou you', shown: 'Contact2u' }], 'fr'), /«Contact tou you» → «Contact2u» не знайдено/);
  });

  it('прямий апостроф між літерами стає ’, прямі лапки поза назвами дають помилку', () => {
    assert.deepEqual(normalizeWordsLang(toks("wasn't", "l'avoir", "Donetsk'"), []).map((x) => x.text), ['wasn’t', 'l’avoir', "Donetsk'"]);
    assert.throws(() => normalizeWordsLang(toks('a', '"b"'), []), /прямі лапки/);
  });

  it('довге німецьке слово утворює окрему картку, а решта фрази не ламається', () => {
    const words = ['Die', 'Binnenvertriebenenunterstützung', 'hilft', 'uns.'].map((t, i): SubWord => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.25 }));
    const cards = buildCards(words).map((c) => c.text);
    assert.ok(cards.includes('Binnenvertriebenenunterstützung') || cards.some((c) => c.includes('Binnenvertriebenenunterstützung')), cards.join(' | '));
    assert.ok(cards.every((c) => c.length <= 22 || !c.includes(' ')), 'картка довша за 22 символи може бути лише одним словом');
  });

  it('розрив фрази за «…» і за закінченням з лапкою', () => {
    const words = ['Wait…', 'then', '«go.»', 'Now'].map((t, i): SubWord => ({ text: t, start: i * 0.1, end: i * 0.1 + 0.05 }));
    assert.deepEqual(splitPhrases(words).map((p) => p.length), [1, 2, 1]);
  });

  it('жодна картка не стартує раніше за кадр 90, остання не зникає пізніше за tD + 12', () => {
    const t = { fps: 30, offsetSeconds: 3, leadFrames: 2, fadeInFrames: 3, trailFrames: 6, fadeOutFrames: 3, minOnScreenFrames: 15, minInFrame: 90, maxOutEnd: 1000 };
    const c = cardFrames([
      { words: [{ text: 'a', start: 0, end: 0.2 }], text: 'a' },
      { words: [{ text: 'b', start: 30.0, end: 30.2 }], text: 'b' },
    ], t);
    assert.equal(c[0]!.inFrame, 90);
    assert.ok(c[1]!.outEnd <= 1000);
  });
});

describe('розрив назви на два рядки', () => {
  it('назва з «/» береться як дана сценаристом', () => {
    assert.deepEqual(titleLines('Wie wurden wir / zu Binnenvertriebenen?'), ['Wie wurden wir', 'zu Binnenvertriebenen?']);
    assert.deepEqual(titleLines(['A', 'B']), ['A', 'B']);
  });
  it('назва в один рядок розривається за пробілом, найближчим до середини, лівіший при рівності', () => {
    assert.deepEqual(titleLines('Як ми стали переселенцями?'), ['Як ми стали', 'переселенцями?']);
    assert.deepEqual(titleLines('aaa bbb ccc ddd'), ['aaa bbb', 'ccc ddd']);
    assert.deepEqual(titleLines('aaaa bbbb'), ['aaaa', 'bbbb']);
  });
  it('без розриву після слова з 1–2 літер', () => {
    assert.deepEqual(titleLines('Wir in einer Zeit'), ['Wir in einer', 'Zeit']);
    assert.deepEqual(titleLines('in das Haus'), ['in das', 'Haus']);
  });
});

// ---------------------------------------------------------------- кадри за алгоритмом edit.md

const here = dirname(fileURLToPath(import.meta.url));
const uk118 = JSON.parse(readFileSync(join(here, 'data', 'timings-uk-118.json'), 'utf8')) as TimingsT;
const editFile = paths.storyFile('01-natalia', 'edit.md');
const haveEdit = existsSync(editFile);

// Довідкова таблиця з edit.md («Довідкова таблиця для української»): S, E, D для кадрів 1…25 (озвучення 118.518 с).
const REF = [
  [1, 0, 264, 75], [2, 189, 435, 90], [3, 345, 574, 90], [4, 484, 680, 75], [5, 605, 869, 90], [6, 779, 982, 60], [7, 922, 1068, 45],
  [8, 1023, 1176, 60], [9, 1116, 1274, 60], [10, 1214, 1368, 60], [11, 1308, 1533, 120], [12, 1413, 1655, 45], [13, 1610, 1784, 90],
  [14, 1694, 1999, 75], [15, 1924, 2078, 45], [16, 2033, 2210, 74], [17, 2136, 2299, 59], [18, 2240, 2436, 60], [19, 2376, 2586, 90],
  [20, 2496, 2714, 75], [21, 2639, 2859, 45], [22, 2814, 2974, 75], [23, 2899, 3200, 120], [24, 3080, 3489, 150], [25, 3339, 3803, 0],
] as const;
const REF_A = [7560, 13000, 17640, 21400, 27456, 31723, 34843, 38203, 41458, 44605, 49085, 54420, 57967, 65389, 68527, 72442, 75648, 80208, 84689, 89209, 94556, 97889, 104662, 113809];

describe('правила прив\'язки', () => {
  it('розбір токенів', () => {
    assert.deepEqual(parseRule('F1.start'), { kind: 'start', n: 1 });
    assert.deepEqual(parseRule('`F2.end`'), { kind: 'end', n: 2 });
    assert.deepEqual(parseRule('F5.S2'), { kind: 'sentence', n: 5, k: 2 });
    assert.deepEqual(parseRule('F1.W12/20'), { kind: 'word', n: 1, k: 12, of: 20 });
    assert.deepEqual(parseRule('F5.W3'), { kind: 'absWord', n: 5, j: 3 });
    assert.throws(() => parseRule('F1.middle'), /Не розумію правило/);
  });
  it('речення: кінець за . ! ? … після прибирання лапок і дужок', () => {
    const w = (t: string): TimedWord => ({ text: t, start: 0, end: 0 });
    assert.deepEqual(splitSentences([w('A'), w('b.'), w('«C'), w('d!»'), w('e')]), [[0, 1], [2, 3], [4]]);
  });
});

describe('кадри: українська 118.518 с проти довідкової таблиці edit.md', { skip: !haveEdit }, () => {
  const doc = readDoc(editFile, 'editor');
  const { props, plan } = buildFilmProps({ story: '01-natalia', doc, timings: uk118, audioExists: true });
  it('S, E і D усіх 25 кадрів збігаються з таблицею до кадра', () => {
    for (const [n, S, E, D] of REF) {
      assert.deepEqual([props.shots[n - 1]!.startFrame, props.shots[n - 1]!.endFrame], [S, E], `кадр ${n}`);
      if (n < 25) assert.equal(plan.D[n], D, `D після кадру ${n}`);
    }
  });
  it('A_ms, tD і довжина фільму', () => {
    assert.deepEqual(plan.A.slice(2), REF_A);
    assert.equal(plan.tD, 3646);
    assert.equal(props.durationInFrames, 3803);
    assert.deepEqual(plan.reduced, [16, 17]);
  });
  it('чисте вікно кожного кадру не менше 30 кадрів; кадр 17 рівно 30, кадр 4 31', () => {
    for (let n = 1; n <= 25; n++) assert.ok(plan.clean[n]! >= 30, `кадр ${n}: ${plan.clean[n]}`);
    assert.equal(plan.clean[17], 30);
    assert.equal(plan.clean[4], 31);
  });
  it('перехід у кадр N дорівнює перекриттю з попереднім; зерно маски в кожного своє; breath від 75 кадрів', () => {
    for (let i = 1; i < props.shots.length; i++) assert.equal(props.shots[i - 1]!.endFrame - props.shots[i]!.startFrame, props.shots[i]!.revealFrames);
    assert.equal(new Set(props.shots.slice(1).map((s) => s.reveal!.seed)).size, 24);
    assert.ok('breath' in props.shots[1]!.reveal! && !('breath' in props.shots[7]!.reveal!));
  });
  it('камера: кадр 25 від\'їжджає до tD + 7, решта до кінця вікна', () => {
    assert.equal(props.shots[24]!.camera.holdFrame, 3646 + 7 - 3339);
    assert.equal(props.shots[0]!.camera.holdFrame, 264);
    assert.equal(props.shots[1]!.camera.s1, 1.33);
  });
  it('титри: українські тексти з edit.md, шрифт і мінімальні розміри', () => {
    assert.deepEqual(props.opening.elements[0]!.lines, ['Як ми стали', 'переселенцями?']);
    assert.equal(props.opening.elements[0]!.minSize, 72);
    assert.equal(props.opening.elements[2]!.minSize, 44);
    assert.equal(props.closing.elements[0]!.lines[0], 'Наталя, м. Донецьк');
    assert.equal(props.closing.elements[3]!.lines[0], 'power-of-the-future.com');
    assert.equal(props.closing.elements[0]!.fromFrame, 3646 + 28);
    assert.equal(props.closing.hideFrom, 3646 + 142);
    assert.equal(props.closing.activeTo, 3803);
    assert.equal(props.opening.maxBottom, 1536);
  });
  it('субтитри: Контакт2u і ФарбаФабра, остання картка зникає не пізніше tD + 12', () => {
    const all = props.subtitles.cards.map((c) => c.text).join(' ');
    assert.match(all, /«Контакт2u»/);
    assert.match(all, /«ФарбаФабра»/);
    assert.doesNotMatch(all, /Контакт ту ю|Фарба Фабра/);
    assert.equal(props.subtitles.cards.at(-1)!.outEnd, 3646 + 12);
    assert.ok(props.subtitles.cards.every((c) => c.inFrame >= 90));
  });
  it('усе серіалізується в JSON без втрат', () => assert.deepEqual(JSON.parse(JSON.stringify(props)), props));
  it('розбір аркуша: константи, таблиця, камера, винятки', () => {
    const c = parseConstants(doc);
    assert.deepEqual(c, { tailFrames: 157, releaseEnd: 102, veilOffset: 7 });
    const t = parseAnchorTable(doc);
    assert.deepEqual(t.sentenceCounts, { 5: 2, 7: 2, 9: 3 });
    assert.equal(t.nominalD[24], 150);
    assert.deepEqual(t.rules[2], { kind: 'word', n: 1, k: 12, of: 20 });
    assert.deepEqual(t.rules[4], { kind: 'end', n: 2 });
    assert.equal(parseCameraNumbers(doc).length, 25);
    assert.deepEqual(parseExceptions(doc), []);
  });
});

// Синтетична «інша мова»: ті самі слова, час розтягнуто, тексти титрів і назви як із мовного script.md.
function stretched(k: number, shift = 0): TimingsT {
  const f = (x: number): number => Math.round((x * k + shift) * 1000) / 1000;
  return {
    duration: f(uk118.duration),
    fragments: uk118.fragments.map((fr) => ({ ...fr, start: f(fr.start), end: f(fr.end), words: fr.words.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })) })),
  };
}
const SYN_SCRIPT: ScriptDoc = {
  title: 'x', language: 'німецька', fragments: [], changes: '', questions: '', raw: '',
  names: [
    { what: 'Проєкт', spoken: 'Контакт ту ю', shown: 'Contact2u', rename: true, line: 1 },
    { what: 'Спільнота', spoken: 'Фарба Фабра', shown: 'FarbaFabra', rename: true, line: 2 },
  ],
  titles: {
    line: 1,
    opening: { title: ['Wie wurden wir', 'zu Binnenvertriebenen?'], author: 'Natalja, Donezk', project: 'Geschichten Binnenvertriebener · Contact2u' },
    closing: { author: 'Natalja, Donezk', project: 'Geschichten Binnenvertriebener · Contact2u', site: 'power-of-the-future.com' },
  },
};

describe('кадри й пропси для іншої мови (синтетичні таймінги)', { skip: !haveEdit }, () => {
  const doc = readDoc(editFile, 'editor');
  it('розтягнуті на 8% таймінги: кадри йдуть за словами, довжина фільму від duration мови', () => {
    const t = stretched(1.08);
    const { props, plan } = buildFilmProps({ story: '01-natalia', lang: 'de', doc, timings: t, script: SYN_SCRIPT, audioExists: true });
    assert.equal(props.lang, 'de');
    assert.equal(plan.tD, Math.floor(((Math.round(t.duration * 1000) + 3000) * 30 + 500) / 1000));
    assert.equal(props.durationInFrames, plan.tD + 157);
    assert.equal(props.shots[24]!.endFrame, props.durationInFrames);
    for (let n = 1; n <= 25; n++) assert.ok(plan.clean[n]! >= 30, `кадр ${n}`);
    // кадр 2 прив'язаний до слова «Донецька» (12-те слово фрагмента 1) у цій мові: центр переходу на його початку
    const w = t.fragments[0]!.words[12]!;
    assert.equal(plan.A[2], Math.round(w.start * 1000) + 3000);
  });
  it('титри з мовного сценарію, субтитри з назвами зі «Назв»', () => {
    const { props } = buildFilmProps({ story: '01-natalia', lang: 'de', doc, timings: stretched(1.08), script: SYN_SCRIPT, audioExists: true });
    assert.deepEqual(props.opening.elements[0]!.lines, ['Wie wurden wir', 'zu Binnenvertriebenen?']);
    assert.equal(props.opening.elements[1]!.kind, 'rule');
    assert.equal(props.opening.elements[2]!.lines[0], 'Natalja, Donezk');
    assert.equal(props.closing.elements[2]!.lines[0], 'Geschichten Binnenvertriebener · Contact2u');
    assert.equal(props.closing.maxBottom, 1536);
    assert.equal(props.closing.lang, 'de');
    const all = props.subtitles.cards.map((c) => c.text).join(' ');
    assert.match(all, /Contact2u/);
    assert.match(all, /FarbaFabra/);
    assert.doesNotMatch(all, /Контакт ту ю/);
    assert.match(props.font.checks.at(-1)!.text, /ü|Ü|ä|ö|ß|і/);
  });
  it('таймінги, що не вкладаються: не вистачає місця для кадру → падіння з числами', () => {
    const t = stretched(0.55);
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'de', doc, timings: t, script: SYN_SCRIPT, audioExists: true }), (e: Error) => e instanceof FrameRuleError && /не вистачає місця/.test(e.message) && /de/.test(e.message));
  });
  it('кількість речень у фрагменті 5 не така: правило F5.S2 не застосовується, падіння з поділом', () => {
    const t = stretched(1.08);
    t.fragments[4]!.words = t.fragments[4]!.words.map((w) => ({ ...w, text: w.text.replace(/\.$/, ',') }));
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'fr', doc, timings: t, script: SYN_SCRIPT, audioExists: true }), (e: Error) => /F5\.S2 не застосовується/.test(e.message) && /fr/.test(e.message) && /речення 1: перше слово/.test(e.message));
  });
  it('виняток із «Мовних винятків» має перевагу над правилом', () => {
    const t = stretched(1.08);
    const exc = [{ lang: 'de', frame: 2, what: 'A' as const, rule: parseRule('F1.W5') }];
    const plan = planFrames({ lang: 'de', timings: t, rules: parseAnchorTable(doc).rules, nominalD: parseAnchorTable(doc).nominalD, sentenceCounts: { 5: 2, 7: 2, 9: 3 }, exceptions: exc, releaseEnd: 102, veilOffset: 7, tailFrames: 157, minClean: 30, frameCount: 25, fragmentCount: 17 });
    assert.equal(plan.A[2], Math.round(t.fragments[0]!.words[5]!.start * 1000) + 3000);
  });
  it('прив\'язки, що не зростають, дають помилку', () => {
    const t = stretched(1.08);
    // фрагмент 4 раніше за кінець фрагмента 2: ламаємо часи фрагмента 4
    t.fragments[3]!.words = t.fragments[3]!.words.map((w) => ({ ...w, start: w.start - 3, end: w.end - 3 }));
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'de', doc, timings: t, script: SYN_SCRIPT, audioExists: true }), /не зростають|назад у часі/);
  });
  it('перевірка таймінгів: не 17 фрагментів', () => {
    const t = stretched(1.08);
    t.fragments.pop();
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'en', doc, timings: t, script: SYN_SCRIPT, audioExists: true }), /фрагментів 16, а має бути 17/);
  });
  it('кінець останнього слова пізніший за duration + 0.2 с: падіння', () => {
    const t = stretched(1.08);
    t.duration -= 1;
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'en', doc, timings: t, script: SYN_SCRIPT, audioExists: true }), /duration \+ 0\.2/);
  });
  it('бракує тексту титру: падіння називає мову й текст', () => {
    const noAuthor: ScriptDoc = { ...SYN_SCRIPT, titles: { line: 1, opening: { ...SYN_SCRIPT.titles!.opening!, author: undefined }, closing: SYN_SCRIPT.titles!.closing } };
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'fr', doc, timings: stretched(1.08), script: noAuthor, audioExists: true }), /мова fr.*«Автор…»/);
    const noSite: ScriptDoc = { ...SYN_SCRIPT, titles: { line: 1, opening: SYN_SCRIPT.titles!.opening, closing: { ...SYN_SCRIPT.titles!.closing!, site: undefined } } };
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'fr', doc, timings: stretched(1.08), script: noSite, audioExists: true }), /мова fr.*«Адреса сайту…»/);
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'fr', doc, timings: stretched(1.08), script: { ...SYN_SCRIPT, titles: undefined }, audioExists: true }), /мова fr.*немає розділу «Титри»/);
  });
  it('запис «Назв» не знайдено в словах: падіння називає запис', () => {
    const bad: ScriptDoc = { ...SYN_SCRIPT, names: [{ what: 'x', spoken: 'Kontakt tu ju', shown: 'Contact2u', rename: true, line: 1 }] };
    assert.throws(() => buildFilmProps({ story: '01-natalia', lang: 'de', doc, timings: stretched(1.08), script: bad, audioExists: true }), /«Kontakt tu ju» → «Contact2u» не знайдено/);
  });
});

describe('камера з таблиці «Камера числами»', () => {
  const row = { n: 2, s0: 1, s1: 1.33, cx0: 0.5, cy0: 0.5, cx1: 0.495, cy1: 0.625 };
  it('вікно кадру і holdFrame', () => assert.deepEqual(cameraSpec(row, 246), { s0: 1, s1: 1.33, cx0: 0.5, cy0: 0.5, cx1: 0.495, cy1: 0.625, holdFrame: 246 }));
  it('вікно, що виходить за зображення, дає помилку', () => assert.throws(() => cameraSpec({ ...row, s0: 1.2, s1: 1.3, cx0: 0.2 }, 100), /виходить за зображення/));
  it('масштаб менший за 100% дає помилку', () => assert.throws(() => cameraSpec({ ...row, s0: 0.9 }, 100), /менший за 100%/));
});
