import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { mkdirSync } from 'node:fs';
import { parseDirectorQuestions, parseProducerDecisions, parseRoleDecisions } from '../lib/docs';
import { paths } from '../lib/paths';
import { decisionSections, renderRoleDecisions } from '../lib/review-html';
import { getRoot } from '../lib/paths';
import { join } from 'node:path';
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

const DEC_ART = `# Рішення: art-director, ${STORY}

## 5 листопада 2026 року: стиль і зразки

### Гуаш замість кіно
Що вирішено: Малюємо гуашшю на кремовому папері.
Чому: Тиха історія потребує книжкової картинки.
Що було б інакше: Кінематографічне світло і контрасти.

### Обличчя спрощені
Що вирішено: Без портретної схожості.
Чому: Герої реальні.
Що було б інакше: Детальні портрети.
`;
const DEC_SC = `# Рішення: scenarist, _project

## 4 листопада 2026 року: сценарій

### Числа словами
Що вирішено: Усі числа пишемо словами.
Чому: Синтезатор читає текст.
Що було б інакше: Цифри читались би по-різному.
`;

describe('рішення ролей', () => {
  it('немає тек decisions: порожньо, блок «Рішення ролей» не показується', () => {
    assert.deepEqual(parseRoleDecisions(STORY), []);
    const s = decisionSections({ roleDecisions: [], director: { updated: '', items: [] }, producerDecisions: [], questions: [] });
    assert.ok(!s.bottom.some(([id]) => id === 'role-decisions'));
  });

  it('читає stories/<id>/decisions/*.md і stories/_project/decisions/*.md, групує за ролями', () => {
    const root = getRoot();
    mkdirSync(join(root, 'stories', STORY, 'decisions'), { recursive: true });
    mkdirSync(join(root, 'stories', '_project', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'stories', STORY, 'decisions', 'art-director.md'), DEC_ART);
    writeFileSync(join(root, 'stories', '_project', 'decisions', 'scenarist.md'), DEC_SC);
    const list = parseRoleDecisions(STORY);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((x) => x.name), ['Гуаш замість кіно', 'Обличчя спрощені', 'Числа словами']);
    assert.equal(list[0]!.topic, 'стиль і зразки');
    assert.equal(list[0]!.date, '5 листопада 2026 року');
    assert.equal(list[2]!.scope, '_project');
    const html = renderRoleDecisions(list);
    assert.ok(html.indexOf('Сценарист') < html.indexOf('Художник-постановник'), 'ролі в порядку виробництва');
    assert.equal((html.match(/class="card rdec"/g) ?? []).length, 3);
    assert.match(html, /Малюємо гуашшю на кремовому папері/, 'що вирішено видно одразу');
    assert.equal((html.match(/<details>/g) ?? []).length, 3, 'чому і що було б інакше розгортаються');
    assert.doesNotMatch(html, /<details open/);
    assert.match(html, /\(на весь проєкт\)/);
    const s = decisionSections({ roleDecisions: list, director: { updated: '', items: [] }, producerDecisions: ['x'], questions: [] });
    assert.deepEqual(s.bottom.map(([id]) => id), ['role-decisions', 'decided', 'role-questions']);
  });

  it('помилки формату: файл, рядок, роль', () => {
    const f = join(getRoot(), 'stories', STORY, 'decisions', 'art-director.md');
    writeFileSync(f, DEC_ART.replace('Чому: Герої реальні.\n', ''));
    assert.throws(() => parseRoleDecisions(STORY), /art-director\.md[^]*роль: art-director[^]*Чому/);
    writeFileSync(f, DEC_ART.replace('# Рішення: art-director,', '# Про рішення'));
    assert.throws(() => parseRoleDecisions(STORY), /# Рішення: <роль>, <історія>/);
    writeFileSync(f, DEC_ART.replace('## 5 листопада 2026 року: стиль і зразки', '## без дати'));
    assert.throws(() => parseRoleDecisions(STORY), /## <дата>: <за що>/);
    writeFileSync(f, DEC_ART);
  });
});
