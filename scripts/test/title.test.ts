import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderAnimatic, renderTitleBase, renderTitleCard } from '../lib/review-html';
import { CLIENT_JS, CSS } from '../lib/review-assets';
import { parseTitleText } from '../lib/title-card';
import type { TimingsFile } from '../lib/timings';

// Розділ «Початковий титр» з edit.md фільму 01-natalia (як його записав монтажер, версія з розмитим кадром 1 і Lora).
const TITLE_TEXT = `Тривалість: 3.0 с (кадри 0–89 при 30 кадрах на секунду). Голосу немає, музика грає від першої секунди фільму. Голос починається на 3.08 с, коли малюнок під титром ще дорозфокусовується.

### Текст

Чотири елементи, усе українською і тільки з \`source.md\`, текст як у джерелі:

1. Назва в два рядки, звичайним реченням, без великих літер: «Як ми стали / переселенцями?»
2. Тонка теракотова риска.
3. Автор: «Наталя, м. Донецьк»
4. Рядок про проєкт: «Історії переселенців · Контакт2u»

Більше нічого на титрі немає: ні дати, ні міст, ні слів про війну, ні слів про героїню, яких немає в \`source.md\`.

### Тло: кадр 1 під напівпрозорою паперовою вуаллю

Тло це той самий \`frame-01.png\`, який одразу після титру стає першим кадром. Він лежить на всю картинку від першої секунди, але приглушений так, щоб його не можна було прочитати як сцену:

- розмиття: Гаусове, близько 32 пікселів на ширині 1080 (у CSS \`blur(32px)\`): лишаються тільки теплі плями (руда сорочка ліворуч, охра стіни посередині, коричнева двері праворуч), ні руки, ні ручки, ні валіз упізнати не можна;
- паперова вуаль: суцільний колір \`#F1E9DA\` поверх кадру з прозорістю 72% (кадр проглядає на 28%), а поверх вуалі ще та сама зернистість паперу (шум 5–6%) і м'яке потемніння по краях (близько 8%), щоб це виглядало як акварель на папері, а не як фото під склом;
- колір: насиченість кадру знижена приблизно до 80%, щоб теплі плями не кричали проти тексту;
- пляма світла під текстом: м'який овал кольору \`#F1E9DA\`, шириною близько 900, висотою близько 800 пікселів, з центром у центрі текстової групи, прозорість 45% посередині, до 0% на краях (розтушовка близько 200 пікселів); він вирівнює тло саме там, де стоїть текст, і де коричневі двері або руда сорочка інакше б «вкусили» літери;
- краї: щоб розмиття не давало прозорих країв, кадр у титрі стоїть на масштабі +4% від початкового і на тлі суцільного \`#F1E9DA\`; ці 4% зникають до 3.4 с разом із розфокусом.

Чому саме кадр 1, а не інший: він єдиний, чиє розкриття збігається з початком голосу, тож розмите тло нічого не розповідає наперед (глядач бачить лише теплі кольорові плями), а коли розфокус знімається, це і є початок розповіді. Палітра кадру (руда, охра, індиго) та сама, що в тексту й риски. Про альтернативи див. файл рішень.

Рух камери кадру 1 (масштаб і зсув з майбутнього монтажного аркуша) починається на 0.0 с і йде безперервно крізь титр: тло повільно дихає, а не стоїть мертвою картинкою.

### Де на екрані і розміри

Усе тільки по центру ширини: текст вирівняний по центру (\`text-align: center\`) у блоці завширшки 840 пікселів (відступи по 120 зліва і справа, однакові), блок стоїть рівно посередині кадру. Літерна розрідженість (\`letter-spacing\`) додає пробіл і після останньої літери, тому в рядках із розрідженням зсунути рядок вправо на половину цього пробілу (або додати такий самий відступ \`padding-left\`), інакше рядок зміститься вліво.

Вертикально (пікселі від верху кадру 1920, елемент за елементом; відступи між ними задано, не «на око»):

- назва: два рядки, міжрядковий інтервал 1.2, разом близько 230 пікселів, від y 540 до 770 (28–40% висоти);
- відступ 56 пікселів;
- риска: y близько 826, завтовшки 4 пікселі, завширшки 180, по центру;
- відступ 56 пікселів;
- автор: рядок від y 882 до 950;
- відступ 40 пікселів;
- рядок про проєкт: від y 990 до 1042 (52–54% висоти).

Вся група лежить від 28% до 54% висоти, її центр близько 41%. Верхні 10% і нижня п'ята кадру (від y 1536) порожні, бо там інтерфейс Reels.

### Шрифт

Один шрифт на весь титр: Lora з Google Fonts (вільний, повна кирилиця, підключати з підмножиною \`cyrillic\`, накреслення 500 і 700, звичайний нахил). Підключення: \`https://fonts.googleapis.com/css2?family=Lora:wght@500;700&subset=cyrillic&display=swap\`. Перед першим кадром дочекатися завантаження шрифту (Remotion: \`delayRender\` до \`document.fonts.ready\`; на сторінці огляду: показувати титр тільки після \`document.fonts.load\`), інакше підставиться системний.

- назва: Lora 700, 96 пікселів, колір \`#2E3347\` без прозорості. Якщо рядок «переселенцями?» ширший за 840 пікселів (виходить за поля), зменшувати обидва рядки назви однаково кроком у 2 пікселі, поки вміститься;
- автор: Lora 500, 52 пікселі, колір \`#2E3347\` без прозорості;
- рядок про проєкт: Lora 500, 40 пікселів, розрідження 0.02 em, колір \`#2E3347\` на 85% прозорості. 40 пікселів на ширині 1080 відповідає приблизно 14 пунктам на телефоні, це читається; нижче 38 пікселів не спускати;
- риска: колір \`#B5502F\` (теракотовий з \`art/style.md\`);
- для читабельності на тлі: до всього тексту тінь без зсуву \`0 0 20px\` кольору \`#F1E9DA\` на 70%.

### Як з'являється і зникає (секунди від початку фільму)

Текст майже весь час на екрані: усе з'являється за перші півсекунди, лишається повністю видимим 2.35 с, і зникає вже під перший звук голосу.

- 0.0–0.3: назва проявляється з прозорості 0 до 100% і піднімається на 12 пікселів до свого місця;
- 0.1–0.4: риска виростає від центру в обидва боки від 0 до повної ширини;
- 0.15–0.4: проявляється автор (тільки прозорість);
- 0.2–0.45: проявляється рядок про проєкт (тільки прозорість);
- 0.45–2.8: усе стоїть нерухомо, текст повністю видно (2.35 с);
- 2.8–3.1: увесь текст і риска разом гаснуть з 100% до 0%.

### Як переходить у перший кадр

Окремого напливу між «титром» і «кадром 1» немає, бо це один кадр: з нього знімається вуаль і розфокус. Склейки теж немає.

- 2.7–3.4: паперова вуаль, пляма світла і розмиття знімаються разом за однією плавною кривою (повільний початок і м'який кінець): вуаль від 72% до 0%, пляма від 45% до 0%, розмиття від 32 пікселів до 0, насиченість від 80% до 100%, додаткові +4% масштабу до 0;
- зернистість паперу й потемніння по краях лишаються на кадрі (їхній стан у кадрі 1 і далі визначає монтажний аркуш);
- 3.08: перше слово озвучення, до цього моменту кадр уже майже різкий (вуаль десь 25%, розмиття 8 пікселів), до 3.4 с кадр 1 різкий і насичений повністю.

Музика тут плавно підіймається разом із розфокусом (рішення за композитором).`;

describe('початковий титр з edit.md', () => {
  const { card, warnings } = parseTitleText(TITLE_TEXT);
  const el = (k: string) => card!.elements.find((e) => e.kind === k)!;

  it('жодного попередження, чотири елементи', () => {
    assert.deepEqual(warnings, []);
    assert.deepEqual(card!.elements.map((e) => e.kind), ['title', 'rule', 'author', 'small']);
  });
  it('тривалість, зняття вуалі, зникнення тексту', () => {
    assert.equal(card!.duration, 3);
    assert.deepEqual(card!.release, { from: 2.7, to: 3.4 });
    assert.deepEqual(card!.hide, { from: 2.8, to: 3.1 });
  });
  it('текст: назва у два рядки, автор, рядок про проєкт', () => {
    assert.deepEqual(el('title').lines, ['Як ми стали', 'переселенцями?']);
    assert.deepEqual(el('author').lines, ['Наталя, м. Донецьк']);
    assert.deepEqual(el('small').lines, ['Історії переселенців · Контакт2u']);
  });
  it('тло: вуаль 72%, розмиття 32 px, насиченість 80%, +4%, зерно, потемніння, пляма світла', () => {
    const b = card!.background;
    assert.equal(b.paper, '#F1E9DA');
    assert.equal(b.veil, 0.72);
    assert.equal(b.blur, 32);
    assert.equal(b.saturation, 0.8);
    assert.equal(b.scale, 0.04);
    assert.equal(b.grain, 0.055);
    assert.equal(b.vignette, 0.08);
    assert.deepEqual(b.glow, { width: 900, height: 800, alpha: 0.45, feather: 200 });
  });
  it('шрифт Lora з Google Fonts (cyrillic, 500 і 700), тінь, крок підгонки', () => {
    assert.equal(card!.font.family, 'Lora');
    assert.equal(card!.font.url, 'https://fonts.googleapis.com/css2?family=Lora:wght@500;700&subset=cyrillic&display=swap');
    assert.deepEqual(card!.font.weights, [500, 700]);
    assert.deepEqual(card!.textShadow, { blur: 20, color: '#F1E9DA', alpha: 0.7 });
    assert.equal(card!.fitStep, 2);
    assert.equal(card!.blockWidth, 840);
  });
  it('розміри, вага, колір, прозорість, розрідження, риска', () => {
    assert.deepEqual([el('title').size, el('title').weight, el('title').lineHeight], [96, 700, 1.2]);
    assert.deepEqual([el('author').size, el('author').weight], [52, 500]);
    assert.deepEqual([el('small').size, el('small').weight, el('small').alpha, el('small').letterSpacing], [40, 500, 0.85, 0.02]);
    assert.equal(el('title').alpha, 1);
    assert.deepEqual([el('rule').color, el('rule').width, el('rule').size], ['#B5502F', 180, 4]);
  });
  it('вертикальні положення в пікселях і секунди появи', () => {
    assert.deepEqual([el('title').topPx, el('rule').topPx, el('author').topPx, el('small').topPx], [540, 826, 882, 990]);
    assert.deepEqual([el('title').from, el('title').to, el('title').rise], [0, 0.3, 12]);
    assert.deepEqual([el('rule').from, el('rule').to], [0.1, 0.4]);
    assert.deepEqual([el('author').from, el('author').to, el('author').rise], [0.15, 0.4, 0]);
    assert.deepEqual([el('small').from, el('small').to], [0.2, 0.45]);
  });
  it('значення з документа, а не зашиті: змінені числа дають інші', () => {
    const r = parseTitleText(TITLE_TEXT.replace('blur(32px)', 'blur(20px)').replace('з прозорістю 72%', 'з прозорістю 60%').replace('- 2.7–3.4:', '- 2.5–3.6:').replace('блоці завширшки 840 пікселів', 'блоці завширшки 800 пікселів').replace('Lora 700, 96 пікселів', 'Lora 700, 90 пікселів'));
    assert.equal(r.card!.background.blur, 20);
    assert.equal(r.card!.background.veil, 0.6);
    assert.deepEqual(r.card!.release, { from: 2.5, to: 3.6 });
    assert.equal(r.card!.blockWidth, 800);
    assert.equal(r.card!.elements[0]!.size, 90);
  });
  it('чого немає в документі, те з попередженням, а не мовчки', () => {
    const r = parseTitleText('1. Назва: «Лише назва»');
    assert.equal(r.card!.elements.length, 2, 'назва й риска');
    assert.match(r.warnings.join(' '), /Тривалість/);
    assert.match(r.warnings.join(' '), /Google Fonts/);
    assert.match(r.warnings.join(' '), /вуал/);
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
  type Data = { duration: number; delay: number; title: { release: { from: number; to: number }; hide: { from: number; to: number }; fontUrl: string; fontChecks: Array<{ spec: string }>; blur: number } | null; slots: Array<{ start: number; end: number; frame: number }>; fragments: Array<{ n: number; start: number; words: Array<[string, number, number]> }> };
  const data = (html: string) => JSON.parse(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as Data;

  it('кадри й слова зсунуті на затримку, тривалість = затримка + озвучення, дані титру в JSON', () => {
    const html = renderAnimatic({ timings, audioSrc: 'media/mix.mp3', items, word: 'кадр', intro: 'x', title: card, offset: 3 });
    const d = data(html);
    assert.equal(d.duration, 13);
    assert.equal(d.delay, 3);
    assert.deepEqual(d.slots.map((s) => [s.frame, s.start]), [[1, 3], [2, 8]]);
    assert.equal(d.fragments[0]!.start, 3.08);
    assert.deepEqual(d.fragments[1]!.words[0], ['б', 8, 9]);
    assert.deepEqual(d.title!.release, { from: 2.7, to: 3.4 });
    assert.deepEqual(d.title!.hide, { from: 2.8, to: 3.1 });
    assert.equal(d.title!.blur, 32);
    assert.match(d.title!.fontUrl, /fonts\.googleapis\.com.*Lora/);
    assert.ok(d.title!.fontChecks.some((c) => c.spec.startsWith('700 96px "Lora"')));
    assert.match(html, /id="anim-title"/);
    assert.match(html, /id="anim-tcbase"/);
    assert.match(html, /Як ми стали<\/span><span[^>]*>переселенцями\?/);
    assert.match(html, /<audio id="anim-audio"[^>]*src="media\/mix\.mp3"/);
  });
  it('без титра аніматик як раніше: нуль зсуву, немає блоку титра', () => {
    const html = renderAnimatic({ timings, audioSrc: 'media/mix.mp3', items, word: 'кадр', intro: 'x' });
    const d = data(html);
    assert.equal(d.duration, 10);
    assert.equal(d.title, null);
    assert.deepEqual(d.slots.map((s) => s.start), [0, 5]);
    assert.doesNotMatch(html, /id="anim-title"/);
    assert.doesNotMatch(html, /id="anim-tcbase"/);
  });
  it('блок тексту по центру кадру: left = (1080 − 840) / 2, однакові поля; риска теж по центру', () => {
    const html = renderTitleCard(card!);
    const left = (11.111 * 1080) / 100; // cqw -> px кадру
    assert.ok(Math.abs(left - 120) < 0.1);
    assert.match(html, /left:11\.111cqw;width:77\.778cqw/);
    assert.match(html, /tc-rule[^>]*left:41\.667cqw;width:16\.667cqw/);
    assert.match(html, /padding-left:0\.02em/, 'розрідження: відступ зліва на ту саму величину');
    assert.match(html, /text-shadow:0 0 1\.852cqw/);
  });
  it('кольори титра лише в атрибутах style елементів, не в <style> сторінки', () => {
    assert.match(renderTitleCard(card!), /style="[^"]*#B5502F/);
    assert.match(renderTitleBase(card!), /#F1E9DA/);
    assert.doesNotMatch(CLIENT_JS, /#[0-9a-fA-F]{6}/);
  });
  it('код сторінки: шрифт підключається посиланням і чекає document.fonts.load, вуаль і розмиття знімаються за кривою', () => {
    assert.match(CLIENT_JS, /document\.fonts\.load/);
    assert.match(CLIENT_JS, /createElement\('link'\)/);
    assert.match(CLIENT_JS, /release/);
    assert.match(CLIENT_JS, /blur\(/);
    assert.match(CSS, /\.title-card \{[^}]*visibility: hidden/);
  });
});
