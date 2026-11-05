import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { parseDirectorQuestions, parseProducerDecisions } from '../lib/docs';
import { paths } from '../lib/paths';
import { decisionSections } from '../lib/review-html';
import { DIRECTOR_QUESTIONS_MD, STORY, mkProject } from './fixtures';

before(() => void mkProject());
const dq = () => paths.storyFile(STORY, 'director-questions.md');

describe('питання режисера і рішення продюсера', () => {
  it('файлу немає: питань немає, на сторінці «Рішень від вас зараз не потрібно»', () => {
    const q = parseDirectorQuestions(STORY);
    assert.deepEqual(q.items, []);
    const s = decisionSections({ director: q, producerDecisions: [], questions: [] });
    assert.match(s.top[0]![2], /Рішень від вас зараз не потрібно/);
    assert.ok(!s.bottom.some(([id]) => id === 'decided'), 'без розділу продюсера блок «Що вирішено без вас» не показується');
  });

  it('картки: питання, рекомендація й значення за замовчуванням видно одразу', () => {
    writeFileSync(dq(), DIRECTOR_QUESTIONS_MD);
    const q = parseDirectorQuestions(STORY);
    assert.equal(q.items.length, 2);
    assert.equal(q.updated, '5 листопада 2026 року');
    assert.equal(q.items[1]!.defaultValue, 'Двоє.');
    const html = decisionSections({ director: q, producerDecisions: [], questions: [] }).top[0]![2];
    assert.equal((html.match(/class="card decision"/g) ?? []).length, 2);
    assert.match(html, /Рекомендація продюсера:<\/strong> Озвучити голосом/);
    assert.match(html, /За замовчуванням:<\/strong> Двоє/);
    assert.doesNotMatch(html, /<details/, 'картки не згортаються');
  });

  it('порожній файл = немає питань; помилкова картка дає помилку з роллю', () => {
    writeFileSync(dq(), '');
    assert.deepEqual(parseDirectorQuestions(STORY).items, []);
    writeFileSync(dq(), DIRECTOR_QUESTIONS_MD.replace('За замовчуванням: Двоє.', ''));
    assert.throws(() => parseDirectorQuestions(STORY), /director-questions\.md[^]*роль: producer[^]*За замовчуванням/);
    writeFileSync(dq(), DIRECTOR_QUESTIONS_MD.replace('## 2. Скільки доньок', '## Скільки доньок'));
    assert.throws(() => parseDirectorQuestions(STORY), /## N\. Коротка назва/);
    rmSync(dq());
  });

  it('«Рішення продюсера» зі status.md і згорнута довідка з усіма питаннями ролей', () => {
    const dec = parseProducerDecisions(STORY);
    assert.deepEqual(dec, ['Нумерацію кадрів не змінюємо.', 'Фрагмент 1 озвучуємо окремим викликом.']);
    const s = decisionSections({ director: { updated: '', items: [] }, producerDecisions: dec, questions: [{ role: 'scenarist', file: 'stories/x/script.md', text: '1. Режисерові. Скільки доньок?' }] });
    const decided = s.bottom.find(([id]) => id === 'decided')!;
    assert.match(decided[1], /Що вирішено без вас/);
    assert.match(decided[2], /<li>Нумерацію кадрів не змінюємо\.<\/li>/);
    const ref = s.bottom.find(([id]) => id === 'role-questions')!;
    assert.match(ref[1], /довідка/);
    assert.match(ref[2], /<details><summary>/);
    assert.doesNotMatch(ref[2], /<details open/);
    assert.match(ref[2], /Відповідати на ці питання не потрібно/);
    assert.match(ref[2], /Скільки доньок/);
    // немає розділу «Рішення продюсера»
    writeFileSync(paths.storyFile(STORY, 'status.md'), '# Статус\n\n## Журнал\n');
    assert.deepEqual(parseProducerDecisions(STORY), []);
    void readFileSync;
  });
});
