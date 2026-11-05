import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderAnimatic, renderTitleCard } from '../lib/review-html';
import { CLIENT_JS } from '../lib/review-assets';
import { parseTitleText } from '../lib/title-card';
import type { TimingsFile } from '../lib/timings';

// Розділ «Початковий титр» з edit.md фільму 01-natalia (як його записав монтажер).
const TITLE_TEXT = `Тривалість: 3.0 с (кадри 0–89 при 30 кадрах на секунду). Голосу немає, музика грає від першої секунди фільму.

Текст, три рядки, усе українською і тільки з \`source.md\`:

1. Назва, великими літерами не пишемо, звичайним реченням у два рядки: «Як ми стали / переселенцями?»
2. Автор: «Наталя, м. Донецьк»
3. Дрібний рядок: «Історії переселенців · Контакт2u»

Тло: чисте, без картинки. Тепло-кремовий акварельний папір (колір близько \`#F1E9DA\`), рівний по всьому кадру, з ледь помітною зернистістю паперу (шум на 5–6% прозорості) і дуже м'яким потемнінням по краях (близько 8%).

Де на екрані: по центру ширини. Назва займає приблизно 36–46% висоти, риска близько 47%, автор близько 50%, дрібний рядок близько 54%. Поля по боках не менше 120 пікселів.

Шрифт і розмір:
- назва: антиква з кирилицею (наприклад PT Serif або Lora, технік бере будь-який вільний шрифт із повною кирилицею), напівжирна, висота 96 пікселів, міжрядковий інтервал близько 1.15, колір глибокий індиго-сірий \`#2E3347\`;
- автор: той самий шрифт, звичайне накреслення, 44 пікселі, колір \`#2E3347\` на 80% прозорості;
- дрібний рядок: той самий шрифт, 30 пікселів, трохи розріджені літери, колір \`#2E3347\` на 60% прозорості;
- риска: колір теракотовий \`#B5502F\`, завтовшки 3 пікселі, завширшки 160 пікселів.

Як з'являється (секунди від початку фільму):
- 0.0–0.2: чистий папір без тексту.
- 0.2–1.0: назва проявляється з прозорості 0 до 100% і неквапливо піднімається на 16 пікселів до свого місця.
- 0.8–1.4: риска виростає від центру в обидва боки від 0 до повної ширини.
- 1.0–1.6: проявляється автор (без зсуву, тільки прозорість).
- 1.4–2.0: проявляється дрібний рядок (тільки прозорість).
- 2.0–2.2: усе стоїть нерухомо, музика тут найтонша.

Як переходить у перший кадр: наплив 0.8 с, від 2.2 до 3.0 с.`;

describe('початковий титр з edit.md', () => {
  const { card, warnings } = parseTitleText(TITLE_TEXT);
  const el = (k: string) => card!.elements.find((e) => e.kind === k)!;

  it('жодного попередження, чотири елементи', () => {
    assert.deepEqual(warnings, []);
    assert.deepEqual(card!.elements.map((e) => e.kind), ['title', 'rule', 'author', 'small']);
  });
  it('тривалість і наплив у кадр 1', () => {
    assert.equal(card!.duration, 3);
    assert.deepEqual(card!.crossfade, { from: 2.2, to: 3 });
  });
  it('текст: назва у два рядки, автор, дрібний рядок', () => {
    assert.deepEqual(el('title').lines, ['Як ми стали', 'переселенцями?']);
    assert.deepEqual(el('author').lines, ['Наталя, м. Донецьк']);
    assert.deepEqual(el('small').lines, ['Історії переселенців · Контакт2u']);
  });
  it('тло: колір, зернистість (середнє 5–6%), потемніння', () => {
    assert.deepEqual(card!.background, { color: '#F1E9DA', grain: 0.055, vignette: 0.08 });
  });
  it('шрифти, кольори, прозорість, ширина риски', () => {
    assert.equal(el('title').size, 96);
    assert.equal(el('title').weight, 700);
    assert.equal(el('title').lineHeight, 1.15);
    assert.equal(el('author').size, 44);
    assert.equal(el('author').alpha, 0.8);
    assert.equal(el('small').size, 30);
    assert.equal(el('small').alpha, 0.6);
    assert.equal(el('small').letterSpacing, 0.06);
    assert.equal(el('rule').color, '#B5502F');
    assert.equal(el('rule').width, 160);
    assert.equal(el('rule').size, 3);
    assert.match(card!.fontStack, /^"PT Serif", "Lora"/);
  });
  it('секунди появи, підйом назви на 16 px', () => {
    assert.deepEqual([el('title').from, el('title').to, el('title').rise], [0.2, 1, 16]);
    assert.deepEqual([el('rule').from, el('rule').to], [0.8, 1.4]);
    assert.deepEqual([el('author').from, el('author').to, el('author').rise], [1, 1.6, 0]);
    assert.deepEqual([el('small').from, el('small').to], [1.4, 2]);
  });
  it('положення: назва по центру проміжку 36–46%, решта за відсотками', () => {
    const t = el('title');
    const heightPct = ((2 * 96 * 1.15) / 1920) * 100;
    assert.ok(Math.abs(t.topPct + heightPct / 2 - 41) < 0.01);
    assert.deepEqual([el('rule').topPct, el('author').topPct, el('small').topPct], [47, 50, 54]);
  });
  it('чого немає в документі, те з попередженням, а не мовчки', () => {
    const r = parseTitleText('1. Назва: «Лише назва»');
    assert.equal(r.card!.elements.length, 2, 'назва й риска');
    assert.match(r.warnings.join(' '), /Тривалість/);
    assert.match(r.warnings.join(' '), /наплив/);
  });
  it('без тексту титра картки немає (попередження)', () => {
    const r = parseTitleText('Тривалість: 3.0 с.');
    assert.equal(r.card, undefined);
    assert.match(r.warnings.join(' '), /не знайдено тексту/);
  });
});

describe('початковий титр в аніматику', () => {
  const { card } = parseTitleText(TITLE_TEXT);
  const timings = {
    duration: 10,
    silent_fragments: [],
    fragments: [
      { n: 1, start: 0.08, end: 4, text: 'а', words: [{ text: 'а', start: 0.08, end: 1 }] },
      { n: 2, start: 5, end: 9, text: 'б', words: [{ text: 'б', start: 5, end: 6 }] },
    ],
  } as unknown as TimingsFile;
  const items = [{ n: 1, fragment: 1, src: 'media/frames/frame-01.jpg' }, { n: 2, fragment: 2, src: 'media/frames/frame-02.jpg' }];
  const data = (html: string) => JSON.parse(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as { duration: number; delay: number; title: { crossfade: { from: number; to: number } } | null; slots: Array<{ start: number; end: number; frame: number }>; fragments: Array<{ n: number; start: number; words: Array<[string, number, number]> }> };

  it('кадри й слова зсунуті на затримку, тривалість = затримка + озвучення, є титр і наплив', () => {
    const html = renderAnimatic({ timings, audioSrc: 'media/mix.mp3', items, word: 'кадр', intro: 'x', title: card, offset: 3 });
    const d = data(html);
    assert.equal(d.duration, 13);
    assert.equal(d.delay, 3);
    assert.deepEqual(d.slots.map((s) => [s.frame, s.start]), [[1, 3], [2, 8]]);
    assert.equal(d.fragments[0]!.start, 3.08);
    assert.deepEqual(d.fragments[1]!.words[0], ['б', 8, 9]);
    assert.deepEqual(d.title!.crossfade, { from: 2.2, to: 3 });
    assert.match(html, /id="anim-title"/);
    assert.match(html, /Як ми стали<br>переселенцями\?/);
    assert.match(html, /#F1E9DA/);
    assert.match(html, /<audio id="anim-audio"[^>]*src="media\/mix\.mp3"/);
  });
  it('без титра аніматик як раніше: нуль зсуву, немає блоку титра', () => {
    const html = renderAnimatic({ timings, audioSrc: 'media/mix.mp3', items, word: 'кадр', intro: 'x' });
    const d = data(html);
    assert.equal(d.duration, 10);
    assert.equal(d.title, null);
    assert.deepEqual(d.slots.map((s) => s.start), [0, 5]);
    assert.doesNotMatch(html, /id="anim-title"/);
  });
  it('кольори титра лише в атрибутах style елементів, не в <style> сторінки', () => {
    const html = renderTitleCard(card!);
    assert.match(html, /style="[^"]*#B5502F/);
    assert.doesNotMatch(CLIENT_JS, /#[0-9a-fA-F]{6}/);
  });
  it('код сторінки обробляє титр і наплив', () => {
    assert.match(CLIENT_JS, /renderTitle/);
    assert.match(CLIENT_JS, /crossfade/);
  });
});
