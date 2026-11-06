import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { checkVoiceAgainstScript, languageCodeFromName, normalizeForCompare, parseScript, parseVoiceMd } from '../lib/docs';
import { narrationKey, narrationKeys } from '../lib/manifest';
import { isDefaultLang, normalizeLang, paths, setRoot } from '../lib/paths';
import { buildFragmentTimings, buildSpeechText } from '../lib/timings';
import type { Alignment } from '../lib/elevenlabs';

const FR_SCRIPT = `# Сценарій: Як ми стали переселенцями? (французька версія)

Мова озвучення: французька
Обсяг: 100 знаків

## Фрагменти

### 1
En juillet, nous avons quitté Donetsk. Elle l’a dit : « à bientôt » !

### 2
Je le sais pour l'avoir vécu, grâce à Contact tou you.

## Назви

| Що | У тексті для озвучення | У субтитрах і титрах |
|---|---|---|
| Проєкт «Контакт2u» | Contact tou you (три слова, фрагмент 2) | Contact2u |
| Спільнота «ФарбаФабра» | Farba Fabra (два слова, фрагмент 2) | FarbaFabra |
| Міста | Donetsk, Dnipro | так само |
| Героїня | у голосі не звучить | Natalia |

## Титри

### Початковий титр
1. Назва в два рядки: «Comment sommes-nous / devenus des déplacés ?»
2. Автор: «Natalia, Donetsk»
3. Рядок про проєкт: «Histoires de déplacés · Contact2u»

### Фінальний титр
1. Автор: «Natalia, Donetsk»
2. Рядок про проєкт: «Histoires de déplacés · Contact2u»
3. Адреса сайту: «power-of-the-future.com»

## Що змінено порівняно з оригіналом і чому

Нічого.

## Питання

1. Нічого.
`;

const FR_VOICE = `# Озвучення

Голос: natalia

## Фрагмент 1
[calmly] En juillet, nous avons quitté Donetsk. [pause] Elle l'a dit : « à bientôt » !

## Фрагмент 2
[softly] Je le sais pour l’avoir vécu , grâce à Contact tou you.
`;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'firststory-lang-'));
  setRoot(root);
  for (const [rel, text] of Object.entries(files)) {
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  return root;
}

describe('мовні версії: шляхи й коди', () => {
  it('українська лежить у корені, інші мови в теках', () => {
    setRoot('/r');
    assert.equal(paths.timings('s'), '/r/stories/s/timings.json');
    assert.equal(paths.timings('s', 'uk'), '/r/stories/s/timings.json');
    assert.equal(paths.timings('s', 'en'), '/r/stories/s/en/timings.json');
    assert.equal(paths.langFile('s', 'fr', 'script.md'), '/r/stories/s/fr/script.md');
    assert.equal(paths.workLangFile('s', undefined, 'narration.mp3'), '/r/work/s/narration.mp3');
    assert.equal(paths.workLangFile('s', 'de', 'narration.mp3'), '/r/work/s/de/narration.mp3');
    assert.equal(isDefaultLang(), true);
    assert.equal(isDefaultLang('en'), false);
  });
  it('некоректний код мови відхиляється', () => {
    assert.throws(() => normalizeLang('../x'), /Некоректний код мови/);
    assert.throws(() => normalizeLang('EN'), /Некоректний код мови/);
    assert.equal(normalizeLang('de'), 'de');
  });
  it('мапа назв мов у коди', () => {
    assert.equal(languageCodeFromName('англійська'), 'en');
    assert.equal(languageCodeFromName('Французька.'), 'fr');
    assert.equal(languageCodeFromName('німецька'), 'de');
    assert.equal(languageCodeFromName('українська'), 'uk');
    assert.equal(languageCodeFromName('клінгонська'), undefined);
  });
  it('облік у маніфесті: окремий ключ на мову', () => {
    assert.equal(narrationKey(), 'narration');
    assert.equal(narrationKey('uk'), 'narration');
    assert.equal(narrationKey('en'), 'narration_en');
    assert.deepEqual(narrationKeys({ narration: {}, narration_fr: {}, images: {}, narration_x: {} }).sort(), ['narration', 'narration_fr']);
  });
});

describe('розбір мовного script.md і voice.md', () => {
  const root = project({ 'stories/T/fr/script.md': FR_SCRIPT, 'stories/T/fr/voice.md': FR_VOICE });
  void root;
  const script = parseScript('T', 'fr');

  it('шапка, фрагменти, діакритика й апострофи', () => {
    assert.equal(script.language, 'французька');
    assert.equal(languageCodeFromName(script.language), 'fr');
    assert.deepEqual(script.fragments.map((f) => f.n), [1, 2]);
    assert.match(script.fragments[0]!.text, /quitté/);
  });
  it('«Назви»: звучання без дужкового пояснення, перепис лише де він потрібен', () => {
    const rn = script.names.filter((n) => n.rename);
    assert.deepEqual(rn.map((n) => [n.spoken, n.shown]), [['Contact tou you', 'Contact2u'], ['Farba Fabra', 'FarbaFabra']]);
    const cities = script.names.find((n) => n.what === 'Міста')!;
    assert.equal(cities.rename, false);
    assert.equal(cities.shown, cities.spoken);
    const hero = script.names.find((n) => n.what === 'Героїня')!;
    assert.equal(hero.rename, false, 'героїня в голосі не звучить: переписувати нічого');
  });
  it('«Титри»: назва розбита на рядки, автор, проєкт, адреса сайту лише у фінальному', () => {
    assert.deepEqual(script.titles!.opening, { title: ['Comment sommes-nous', 'devenus des déplacés ?'], author: 'Natalia, Donetsk', project: 'Histoires de déplacés · Contact2u' });
    assert.deepEqual(script.titles!.closing, { author: 'Natalia, Donetsk', project: 'Histoires de déplacés · Contact2u', site: 'power-of-the-future.com' });
  });
  it('український сценарій без розділів «Назви» й «Титри» читається', () => {
    project({ 'stories/T/script.md': '# Сценарій: Т\n\nМова озвучення: українська\n\n## Фрагменти\n\n### 1\nТекст.\n' });
    const uk = parseScript('T');
    assert.deepEqual(uk.names, []);
    assert.equal(uk.titles, undefined);
  });
  it('звіряння слів: типографський апостроф, пробіл перед розділовим знаком і теги не заважають', () => {
    project({ 'stories/T/fr/script.md': FR_SCRIPT, 'stories/T/fr/voice.md': FR_VOICE });
    const s = parseScript('T', 'fr');
    checkVoiceAgainstScript('T', parseVoiceMd('T', 'fr'), s, [], 'fr');
  });
  it('звіряння слів: змінене слово ловиться', () => {
    project({ 'stories/T/fr/script.md': FR_SCRIPT, 'stories/T/fr/voice.md': FR_VOICE.replace('quitté', 'quitte') });
    assert.throws(() => checkVoiceAgainstScript('T', parseVoiceMd('T', 'fr'), parseScript('T', 'fr'), [], 'fr'), /відрізняється від script.md/);
  });
  it('NFC і NFD діакритики однакові для звіряння', () => {
    assert.equal(normalizeForCompare('quitté Müller'.replace('quitté', 'quitté')), normalizeForCompare('quitté Müller'));
    assert.equal(normalizeForCompare("l’avoir [pause] , “x”"), normalizeForCompare('l\'avoir, "x"'));
  });
});

/** Синтетична відповідь API: рівномірно 0.05 с на елемент. */
function align(chars: string[]): Alignment {
  let t = 0;
  const s: number[] = [];
  const e: number[] = [];
  for (const _c of chars) {
    void _c;
    s.push(Math.round(t * 1000) / 1000);
    t += 0.05;
    e.push(Math.round(t * 1000) / 1000);
  }
  return { characters: chars, character_start_times_seconds: s, character_end_times_seconds: e };
}

describe('таймінги для латиниці, діакритики й апострофів', () => {
  const frag = [{ n: 1, tagged: "[calmly] J'ai vécu à Zürich, l’été. [pause] Straße." }];
  const { text, spans } = buildSpeechText(frag, '\n\n');

  it('слова зберігають діакритику, апостроф, розділові знаки', () => {
    const t = buildFragmentTimings(text, spans, align([...text]), frag);
    assert.deepEqual(t[0]!.words.map((w) => w.text), ["J'ai", 'vécu', 'à', 'Zürich,', 'l’été.', 'Straße.']);
  });
  it('API повернув апостроф в іншій формі', () => {
    const chars = [...text].map((c) => (c === "'" ? '’' : c === '’' ? "'" : c));
    const t = buildFragmentTimings(text, spans, align(chars), frag);
    assert.equal(t[0]!.words[0]!.text, "J'ai");
    assert.equal(t[0]!.words[4]!.text, 'l’été.');
  });
  it('API розклав діакритику на літеру й комбінований знак', () => {
    const chars = [...text].flatMap((c) => [...c.normalize('NFD')]);
    const t = buildFragmentTimings(text, spans, align(chars), frag);
    assert.deepEqual(t[0]!.words.map((w) => w.text), ["J'ai", 'vécu', 'à', 'Zürich,', 'l’été.', 'Straße.']);
    // час слова «vécu» охоплює й комбінований знак: кінець слова пізніший за кінець його літери «c»
    assert.ok(t[0]!.words[1]!.end > t[0]!.words[1]!.start);
  });
});
