import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CH, SR, baseMusicEnvelope, mixFilm, rmsOver, speechIntervals, toDb, withPatches } from '../lib/mix';
import { parseFilmMix, parseNumberList, parseWhere } from '../lib/mix-spec';
import type { SfxSpec } from '../lib/docs';

// Розділ «Зведення» зі sound.md фільму 01-natalia (як його записав композитор).
const MIX_TEXT = `Голос завжди головний і стоїть на 0 дБ. Музика під голосом -20 дБ відносно голосу, у паузах голосу довших за 0.8 с піднімається до -8 дБ за 0.8 с і так само повертається. Пауза визначається за таймінгами слів. Поріг 0.8 с, а не 0.4 с зразка: фрагменти тут майже без пауз між собою (0.07–0.56 с), і з плавною зміною 0.8 с коротша пауза дала б тільки вібрацію гучності. За таймінгами така пауза всередині фільму одна: 5.36–6.32 с (між «Донецька» і «до Донецької області», 0.96 с). У ній музика лише ледь встигає піднятися, тому там підйом іде до -12 дБ за 0.5 с, щоб теплий акорд справді прозвучав. На кінці фільму пауза 116.72–117.47 с (0.75 с) теж рахується як пауза, див. нижче. У решті місць музика просто лишається на -20 дБ. Музика грає з першої секунди, змінюється тільки її гучність, вона не вмикається з нуля.

Відхилення від загального правила:
- Фрагмент 1 до слова «Донецька» (0.08–5.36 с): музика -24 дБ під голосом. У паузі 5.36–6.32 с піднімається до -12 дБ, далі до -20 дБ за 0.8 с.
- Кадр 4, «Але не судилося» (від 14.08 с, кінця слова «повернемося», і до початку фрагмента 4 на 16.24 с): музика не піднімається, а тримається на -14 дБ найтоншою нотою (треку в цей час майже немає, тож -14 дБ це чутна одна нота, а не гучність), шумів немає. Звідти до -20 дБ повертається за 0.8 с після початку фрагмента 4. Якщо монтажер розтягне кадр 4 довше за фразу, ця тиша триває стільки, скільки він поставить, а всі шуми й зведення далі зсуваються на ту саму різницю.
- Кадр 18 («букет», 72.2–76.3 с): шумів немає, музика на -20 дБ, акорд тримається.
- Фрагмент 16 (100.61–109.6 с): музика -22 дБ, бо тоншає сама.
- Кінець (116.72 с і далі): музика до -8 дБ, шум 9 теж виходить уперед, останні 0.75 с обидва плавно гаснуть до кінця фільму.

Шуми за часом, з прив'язкою до кадрів.
- 0.3–3.3 с, кадр 1, шум 2. Ривок ручки чути майже з початку: перед ним немає кадру, тож вступає за 0.2 с, а гасне за 1 с до 3.3 с. Кадр 1 триває до 4.9 с, решту він без шуму, під музикою.
- 4.9–9.9 с, кадр 2, шум 3. Вступає за 1 с, у паузі 5.36–6.32 с виходить на перший план разом із акордом, гасне до 10.4 с. У кадрі 3 (доньки з ранцями, 9.8–14.6 с) шуму немає.
- 31.6–34.6 с, кадр 8, шум 11. Тече кран, голос поверх нього; гасне до 34.6 с. У кадрі 9 (аптека, 34.1–37.3 с) шуму немає.
- 37.3–40.3 с, кадр 10, шум 4. Гасне до 41.0 с, на 40.5 с вступає шум 5, і вони перетікають одне в одне: автобус зовні, потім зсередини.
- 40.5–45.5 с, кадр 11, шум 5. Гасне до 45.5 с. У кадрах 12 і 13 (парапет, мотузка) шуму немає.
- 53.8–59.8 с, кадр 14, шум 6. Гасне до 60.0 с; до кадру 15 лишається 1.2 с без шуму.
- 61.2–64.2 с, кадр 15, шум 10. Гасне до 64.7 с, кадр 16 (лавка у дворі) без шуму.
- 89.0–93.0 с, кадр 22, шум 7. Вступає тихо й гасне до 93.6 с.
- 100.6–106.6 с, кадр 24, шум 8. Звучить трохи приглушено, ніби за вікном із середини офісу, гасне за останню секунду. Решту фрагмента 16 (до 109.7 с) лишаються тільки голос і музика: тонка тепла нота й друга, що долучилася.
- 109.7–117.5 с, кадр 25, шум 9. Тримається до кінця фільму, після останнього слова (116.72 с) виходить на перший план разом із музикою, останні 0.75 с гасне разом із нею. Файл 8 с, фільм закінчується на 117.47 с, зайві 0.2 с обрізаються.

Шуми стоять тихіше за голос і нічого не розповідають замість нього. Шум 2 -20 дБ відносно голосу (єдиний звук першої секунди), у паузі 5.36–6.32 с шум 3 до -14 дБ; шуми 3–6, 10 і 11 -22 дБ; шум 7 -24 дБ; шум 8 -20 дБ; шум 9 -20 дБ, після останнього слова -12 дБ. Кожен шум входить і виходить плавно за 0.8–1 с, щоб кадр не мав різкого шва.

Голос сам, без музики на першому плані і без шумів: ніде. Найближче до цього кадр 4 і кадр 18.`;

const sfxSpec = (n: number, second: number, frame: number): SfxSpec => ({ n, prompt: 'x', seconds: 3, where: `кадр ${frame}, секунда ${second}`, loudness: 'тихо', line: 1 });
const SFX = [sfxSpec(2, 0.3, 1), sfxSpec(3, 4.9, 2), sfxSpec(4, 37.3, 10), sfxSpec(5, 40.5, 11), sfxSpec(6, 53.8, 14), sfxSpec(7, 89, 22), sfxSpec(8, 100.6, 24), sfxSpec(9, 109.7, 25), sfxSpec(10, 61.2, 15), sfxSpec(11, 31.6, 8)];
const CTX = { filmEnd: 117.473, lastWordEnd: 116.72 };

describe('розбір «Зведення» для повного зведення', () => {
  const spec = parseFilmMix(MIX_TEXT, SFX, CTX);
  const sfx = (n: number) => spec.sfx.find((s) => s.n === n)!;

  it('загальне правило', () => {
    assert.equal(spec.underDb, -20);
    assert.equal(spec.pauseDb, -8);
    assert.equal(spec.fade, 0.8);
    assert.equal(spec.pauseMin, 0.8);
    assert.equal(spec.endFade, 0.75);
  });

  it('відхилення: п’ять ділянок музики, жодного нерозібраного пункту', () => {
    assert.deepEqual(spec.warnings, []);
    assert.equal(spec.musicPatches.length, 5);
    const env = withPatches((t) => (t < 1 ? -8 : -20), spec.musicPatches);
    assert.equal(env(2), -24, 'фрагмент 1 до «Донецька»');
    assert.equal(env(5.9), -12, 'у паузі 5.36–6.32 піднято до -12');
    assert.equal(env(6.32), -12);
    assert.ok(Math.abs(env(6.32 + 0.4) - -16) < 1e-9, 'за 0.8 с після паузи повертається до -20');
    assert.equal(env(15), -14, 'кадр 4 тримається на -14');
    assert.equal(env(16.24 + 0.8), -20);
    assert.equal(env(105), -22, 'фрагмент 16');
    assert.equal(env(74), -20, 'кадр 18');
    assert.equal(env(116.72), -20);
    assert.equal(env(117.473), -8, 'кінець: до -8');
  });

  it('шуми: початок із «Де», рівні з речення про рівні, а не зі слова «тихо»', () => {
    assert.equal(spec.sfx.length, 10);
    assert.equal(spec.sfx.some((s) => s.n === 1), false, 'шуму 1 немає');
    assert.deepEqual(spec.sfx.filter((s) => !s.levelFromDoc), []);
    assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => sfx(n).levelDb), [-20, -22, -22, -22, -22, -24, -20, -20, -22, -22]);
    assert.equal(sfx(2).start, 0.3);
    assert.equal(sfx(2).fadeIn, 0.2);
    assert.equal(sfx(2).fadeOutLen, 1);
    assert.equal(sfx(2).fadeOutEnd, 3.3);
    assert.equal(sfx(3).fadeIn, 1);
    assert.equal(sfx(3).fadeOutEnd, 10.4);
    assert.equal(sfx(8).fadeOutEnd, undefined, '«гасне за останню секунду»: наприкінці файлу');
    assert.equal(sfx(8).muffled, true);
    assert.equal(sfx(7).muffled, false);
    assert.equal(sfx(9).fadeToFilmEnd, true);
    assert.equal(sfx(9).fadeOutLen, 0.75);
    assert.equal(sfx(9).fadeOutEnd, 117.473);
  });

  it('шуми: підйом у паузі (шум 3) і після останнього слова (шум 9)', () => {
    const e3 = withPatches(() => sfx(3).levelDb, sfx(3).patches);
    assert.equal(e3(5), -22);
    assert.equal(e3(6), -14);
    const e9 = withPatches(() => sfx(9).levelDb, sfx(9).patches);
    assert.equal(e9(110), -20);
    assert.equal(e9(117.473), -12);
  });

  it('без загального правила — помилка з роллю', () => {
    assert.throws(() => parseFilmMix('Голос головний.', [], CTX), /composer/);
  });

  it('шум без секунди в «Де» і без пункту — попередження, шум не підмішується; словесна гучність — стандартний рівень', () => {
    const s = parseFilmMix(MIX_TEXT, [{ ...sfxSpec(12, 1, 1), where: 'кадр 3' }, { ...sfxSpec(13, 50, 12) }], CTX);
    assert.equal(s.sfx.some((x) => x.n === 12), false);
    assert.match(s.warnings.join(' '), /Шум 12/);
    const x13 = s.sfx.find((x) => x.n === 13)!;
    assert.equal(x13.levelFromDoc, false);
    assert.equal(x13.levelDb, -22);
  });

  it('списки номерів і поле «Де»', () => {
    assert.deepEqual(parseNumberList('3–6, 10 і 11'), [3, 4, 5, 6, 10, 11]);
    assert.deepEqual(parseWhere('кадр 1, секунда 0.3'), { frame: 1, second: 0.3 });
    assert.deepEqual(parseWhere('кадр 4'), { frame: 4, second: undefined });
  });
});

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

describe('повне зведення на синусоїдах', () => {
  const seconds = 12;
  const speech: Array<[number, number]> = [[1, 5], [8, 11]];
  const voice = sine(seconds, 220, 0.3, speech);
  const music = sine(14, 880, 0.05);
  const noise = sine(3, 3000, 0.4);
  const words = [{ start: 1, end: 5 }, { start: 8, end: 11 }];
  const underDb = -20;
  const musicDb = withPatches(baseMusicEnvelope(speechIntervals(words, 0.8), underDb, -8, 0.8), []);
  const params = { words, pauseMin: 0.8, musicDb, endFade: 0.75, sfx: [{ label: 'шум', pcm: noise, start: 2, levelDb: () => -14, fadeIn: 0.5, fadeOutLen: 0.5, fadeOutEnd: 5 }] };
  const r = mixFilm(voice, music, params);
  const res = new Float32Array(voice.length);
  for (let i = 0; i < res.length; i++) res[i] = r.pcm[i]! - voice[i]!;
  const voiceRms = rmsOver(voice, [{ a: 1, b: 5 }, { a: 8, b: 11 }]);
  const rel = (a: number, b: number) => toDb(rmsOver(res, [{ a, b }])) - toDb(voiceRms);

  it('довжина дорівнює довжині голосу', () => {
    assert.equal(r.pcm.length, voice.length);
  });

  it('музика під голосом на -20 дБ, у паузі на -8 дБ (без шуму)', () => {
    assert.equal(r.peakScale, 1);
    const under = toDb(rmsOver(res, [{ a: 8.5, b: 10.5 }])) - toDb(voiceRms);
    assert.ok(Math.abs(under - -20) < 0.3, `під голосом ${under}`);
    const pause = toDb(rmsOver(res, [{ a: 6.4, b: 6.6 }])) - toDb(voiceRms);
    assert.ok(Math.abs(pause - -8) < 0.3, `у паузі ${pause}`);
  });

  it('музика гасне до нуля наприкінці фільму', () => {
    const tail = rmsOver(res, [{ a: seconds - 0.02, b: seconds }]);
    const mid = rmsOver(res, [{ a: seconds - 0.8 - 0.1, b: seconds - 0.8 }]);
    assert.ok(tail < mid * 0.1, 'останні кадри майже беззвучні');
  });

  it('шум: рівень відносно голосу, вхід і згасання', () => {
    // у вікні 3–4.5 є й музика (-20 дБ); шум -14 дБ перебиває її на ~6 дБ, тому міряємо різницю з/без шуму
    const without = mixFilm(voice, music, { ...params, sfx: [] });
    const only = new Float32Array(voice.length);
    for (let i = 0; i < only.length; i++) only[i] = r.pcm[i]! - without.pcm[i]!;
    const level = toDb(rmsOver(only, [{ a: 2.8, b: 4.4 }])) - toDb(voiceRms);
    assert.ok(Math.abs(level - -14) < 0.3, `шум ${level}`);
    assert.ok(rmsOver(only, [{ a: 0, b: 1.9 }]) === 0, 'до початку шуму тиша');
    assert.ok(rmsOver(only, [{ a: 2, b: 2.1 }]) < rmsOver(only, [{ a: 3, b: 3.1 }]) * 0.3, 'вхід наростає');
    assert.ok(rmsOver(only, [{ a: 5.01, b: 5.2 }]) === 0, 'після кінця згасання шуму немає');
    assert.ok(rmsOver(only, [{ a: 4.85, b: 4.95 }]) < rmsOver(only, [{ a: 3, b: 3.1 }]) * 0.5, 'згасання');
  });

  it('шум довший за фільм обрізається, довжина не росте', () => {
    const long = mixFilm(voice, music, { ...params, sfx: [{ ...params.sfx[0]!, start: 11, fadeOutEnd: 12 }] });
    assert.equal(long.pcm.length, voice.length);
  });
});
