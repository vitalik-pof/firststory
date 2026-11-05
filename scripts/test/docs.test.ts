import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import {
  aspectFromFormat, checkStoryboardAgainstScript, checkVoiceAgainstScript, findSheet, parseCharacter, parseHeroRefs, parseScript, parseSound,
  parseStoryboard, parseStyle, parseVoiceMd, parseVoices, writeCharacterResource, writeVoiceId,
} from '../lib/docs';
import { DocFormatError, readDoc } from '../lib/md';
import { paths } from '../lib/paths';
import { STORY, mkProject } from './fixtures';

let root = '';
before(() => {
  root = mkProject();
});

const dummyDoc = () => readDoc(paths.storyFile(STORY, 'script.md'), 'scenarist');

describe('парсери на зразках за форматами ролей', () => {
  it('сценарій', () => {
    const s = parseScript(STORY);
    assert.equal(s.fragments.length, 3);
    assert.equal(s.language, 'українська');
    assert.match(s.questions, /доньок/);
  });
  it('voice.md і звірка зі сценарієм', () => {
    const v = parseVoiceMd(STORY);
    assert.equal(v.voiceId, 'tester');
    assert.equal(v.fragments.length, 3);
    checkVoiceAgainstScript(STORY, v, parseScript(STORY));
  });
  it('voices.md і запис voice_id', () => {
    const v = parseVoices();
    assert.equal(v.voices[0]!.voiceId, '');
    writeVoiceId(v.voices[0]!, 'abc123XYZ');
    assert.equal(parseVoices().voices[0]!.voiceId, 'abc123XYZ');
    assert.match(readFileSync(paths.voicesDoc(), 'utf8'), /voice_id: abc123XYZ\n\n## Питання/);
  });
  it('стиль', () => assert.match(parseStyle().generatorText, /gouache/));
  it('герої: версії й одна версія', () => {
    const n = parseCharacter('natalia');
    assert.deepEqual(n.sheets.map((s) => s.label), ['2014', 'тепер']);
    assert.equal(n.appears.startsWith('`'), true);
    assert.equal(findSheet(n, '2014', 'x').slug, '2014');
    assert.throws(() => findSheet(n, undefined, 'Кадр 9'), /потрібно вказати версію/);
    assert.throws(() => findSheet(n, 'невідома', 'Кадр 9'), /невідома версія/);
    assert.equal(parseCharacter('natalia-son').sheets[0]!.label, 'main');
  });
  it('запис id в «Ресурси» (заглушка зникає, версії окремо, повторний запис замінює)', () => {
    writeCharacterResource('natalia', '2014', 'asset2014abcd', 'тест');
    writeCharacterResource('natalia', 'тепер', 'assetTeperXYZ', 'тест');
    let n = parseCharacter('natalia');
    assert.deepEqual(n.resources.map((r) => [r.label, r.assetId]), [['2014', 'asset2014abcd'], ['тепер', 'assetTeperXYZ']]);
    assert.doesNotMatch(readFileSync(paths.characterDoc('natalia'), 'utf8'), /Поки порожньо/);
    writeCharacterResource('natalia', '2014', 'assetNEW2014xx', 'тест');
    n = parseCharacter('natalia');
    assert.equal(n.resources.length, 2);
    assert.equal(n.resources[0]!.assetId, 'assetNEW2014xx');
    writeCharacterResource('natalia-son', 'main', 'sonasset1234', 'тест');
    assert.equal(parseCharacter('natalia-son').resources[0]!.assetId, 'sonasset1234');
  });
  it('розкадровка: вільний рядок «Герої»', () => {
    const sb = parseStoryboard(STORY);
    assert.equal(sb.frames.length, 4);
    assert.equal(sb.format, '9:16, вертикальний, для Reels.');
    assert.deepEqual(sb.frames[1]!.heroes, [{ id: 'natalia', version: '2014' }, { id: 'natalia-son', version: undefined }]);
    assert.deepEqual(sb.frames[0]!.heroes, []);
    assert.deepEqual(sb.frames[2]!.heroes, []);
    checkStoryboardAgainstScript(STORY, sb, parseScript(STORY));
    assert.equal(aspectFromFormat(sb.format), '9:16');
  });
  it('звук', () => {
    const s = parseSound(STORY);
    assert.equal(s.music.seconds, 12);
    assert.equal(s.music.instrumental, true);
    assert.deepEqual(s.sfx.map((x) => x.seconds), [4, 3.5]);
    assert.equal(s.totalSeconds, 12);
  });
});

describe('герої в рядку «Герої:»', () => {
  const d = () => dummyDoc();
  const p = (v: string) => parseHeroRefs(d(), v, 1, 7);
  it('приклади з реальної розкадровки', () => {
    assert.deepEqual(p('natalia (версія «2014», у кардигані), natalia-husband'), [{ id: 'natalia', version: '2014' }, { id: 'natalia-husband', version: undefined }]);
    assert.deepEqual(p('natalia-daughters — тільки силуети, аркуші як референси не обов\'язкові'), [{ id: 'natalia-daughters', version: undefined }]);
    assert.deepEqual(p('немає'), []);
    assert.deepEqual(p('немає (рука з теракотовим браслетом — Наталя, аркуш не потрібен)'), []);
    assert.deepEqual(p('natalia-son (у візочку)'), [{ id: 'natalia-son', version: undefined }]);
  });
  it('без жодного id помилка з номером кадру', () => {
    assert.throws(() => p('якась жінка'), /Кадр 7/);
  });
});

describe('суворість: документ не за форматом дає зрозумілу помилку', () => {
  it('порожнє поле Для генератора: файл, рядок, роль', () => {
    const f = paths.storyFile(STORY, 'storyboard.md');
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig.replace('Для генератора (англійською): A hot summer city street, no people.', 'Для генератора (англійською):'));
    try {
      parseStoryboard(STORY);
      assert.fail('мала бути помилка');
    } catch (e) {
      assert.ok(e instanceof DocFormatError);
      assert.equal(e.role, 'art-director');
      assert.match(e.message, /storyboard\.md, рядок \d+ \(роль: art-director\)/);
      assert.match(e.message, /Кадр 1/);
    } finally {
      writeFileSync(f, orig);
    }
  });
  it('номер фрагмента нечисловий', () => {
    const f = paths.storyFile(STORY, 'storyboard.md');
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig.replace('Фрагмент сценарію: 2', 'Фрагмент сценарію: 2-3'));
    assert.throws(() => parseStoryboard(STORY), /очікувалось ціле число/);
    writeFileSync(f, orig);
  });
  it('voice.md змінює слова сценарію', () => {
    const f = paths.storyFile(STORY, 'voice.md');
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig.replace('Було спекотно', 'Було дуже спекотно'));
    assert.throws(() => checkVoiceAgainstScript(STORY, parseVoiceMd(STORY), parseScript(STORY)), /слова змінювати не можна[^]*voice\.md|voice-director/);
    writeFileSync(f, orig);
  });
  it('voice.md: незакритий тег', () => {
    const f = paths.storyFile(STORY, 'voice.md');
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig.replace('[pause] [quietly]', '[pause [quietly]'));
    assert.throws(() => parseVoiceMd(STORY), /Фрагмент 1: вкладена або незакрита/);
    writeFileSync(f, orig);
  });
  it('sound.md: шум довший за 30 с', () => {
    const f = paths.storyFile(STORY, 'sound.md');
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig.replace('Тривалість: 4', 'Тривалість: 45'));
    assert.throws(() => parseSound(STORY), /поза межами API/);
    writeFileSync(f, orig.replace('Тривалість: 12\n', 'Тривалість: 2 хв\n'));
    assert.throws(() => parseSound(STORY), /очікувались секунди/);
    writeFileSync(f, orig);
  });
  it('script.md: немає розділу Фрагменти', () => {
    const f = paths.storyFile(STORY, 'script.md');
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig.replace('## Фрагменти', '## Текст'));
    assert.throws(() => parseScript(STORY), /Немає розділу «## Фрагменти»[^]*|scenarist/);
    writeFileSync(f, orig);
  });
  it('відсутній файл: названо роль', () => {
    assert.throws(() => parseCharacter('nobody'), /його має створити роль art-director/);
  });
  it('невпізнаний герой чи версія в розкадровці — помилка з номером кадру (на етапі референсів)', async () => {
    const { CharacterCache, resolveFrameRefs } = await import('../lib/frame-refs');
    const fr = { n: 5, fragment: 1, inFrame: '', heroes: [{ id: 'ghost' }], camera: '', mood: '', prompt: 'x', line: 1 };
    assert.throws(() => resolveFrameRefs(STORY, fr, {}, new CharacterCache()), /Кадр 5.*невпізнаний герой «ghost»/);
    const fr2 = { ...fr, heroes: [{ id: 'natalia', version: '1999' }] };
    assert.throws(() => resolveFrameRefs(STORY, fr2, {}, new CharacterCache()), /Кадр 5.*невідома версія «1999»/);
  });
});
