// Парсери документів творчих ролей. Формати описано у файлах .claude/agents/*.md.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  type Doc, type Field, type Line, type Section,
  blockText, extractQuestions, fail, flatText, isPlaceholder, parseInteger, parseSeconds,
  readDoc, readFieldsStrict, requireField, requireSection, sectionText, splitByHeading, trimLines,
} from './md';
import { paths } from './paths';
import { collapseWs, slugify, stripTags, bracketProblem } from './text';

// ------------------------------------------------------------------ сценарій

export interface ScriptFragment {
  n: number;
  text: string;
  line: number;
}
export interface ScriptDoc {
  title: string;
  language: string;
  fragments: ScriptFragment[];
  changes: string;
  questions: string;
  raw: string;
}

export function parseScript(story: string): ScriptDoc {
  const doc = readDoc(paths.storyFile(story, 'script.md'), 'scenarist');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const h1 = doc.lines.find((l) => /^#\s+/.test(l.text));
  const title = h1 ? h1.text.replace(/^#\s+/, '').replace(/^Сценарій:\s*/i, '').trim() : story;
  const { fields } = readFieldsStrict(doc, preamble, { language: /^Мова озвучення$/i, volume: /^Обсяг$/i });
  const language = requireField(doc, fields, 'language', 'Мова озвучення', 'шапка файлу').value;
  const frag = requireSection(doc, sections, /^Фрагменти$/i, '## Фрагменти');
  const subs = splitByHeading(frag.body, 3).sections;
  if (!subs.length) fail(doc, frag.line, 'У розділі «Фрагменти» немає жодного фрагмента (очікуються заголовки «### 1», «### 2»…).');
  const fragments: ScriptFragment[] = [];
  let prev = 0;
  for (const s of subs) {
    if (!/^\d+$/.test(s.title)) fail(doc, s.line, `Заголовок фрагмента має бути числом («### 1»), а є «${s.title}».`);
    const n = Number(s.title);
    if (n <= prev) fail(doc, s.line, `Номери фрагментів мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const text = flatText(s.body);
    if (!text) fail(doc, s.line, `Фрагмент ${n} порожній.`);
    fragments.push({ n, text, line: s.line });
  }
  return {
    title,
    language,
    fragments,
    changes: sectionText(doc, /^Що змінено/i),
    questions: extractQuestions(doc),
    raw: doc.lines.map((l) => l.text).join('\n'),
  };
}

// ------------------------------------------------------------------ голоси

export interface VoiceEntry {
  id: string;
  story: string;
  image: string;
  designPrompt: string;
  probeText: string;
  voiceId: string;
  /** Діапазон рядків поля voice_id (для перезапису) або undefined, якщо поля немає. */
  voiceIdLines?: { from: number; to: number };
  line: number;
}
export interface VoicesDoc {
  doc: Doc;
  voices: VoiceEntry[];
  questions: string;
}

const VOICE_DEFS = {
  story: /^Для історії$/i,
  image: /^Образ голосу$/i,
  prompt: /^Опис для Voice Design/i,
  probe: /^Текст проби$/i,
  voiceId: /^voice_id$/i,
};

export function parseVoices(): VoicesDoc {
  const doc = readDoc(paths.voicesDoc(), 'voice-director');
  const { sections } = splitByHeading(doc.lines, 2);
  const voices: VoiceEntry[] = [];
  for (const s of sections) {
    if (/^Питання\b/i.test(s.title)) continue;
    const { fields } = readFieldsStrict(doc, s.body, VOICE_DEFS);
    const where = `## ${s.title}`;
    const vid = fields.voiceId;
    const voiceId = vid && !isPlaceholder(vid.value) ? vid.value.trim() : '';
    voices.push({
      id: s.title.trim(),
      story: requireField(doc, fields, 'story', 'Для історії', where, s.line).value,
      image: fields.image?.value ?? '',
      designPrompt: requireField(doc, fields, 'prompt', 'Опис для Voice Design (англійською)', where, s.line).value,
      probeText: requireField(doc, fields, 'probe', 'Текст проби', where, s.line).value,
      voiceId,
      voiceIdLines: vid ? { from: vid.line, to: vid.lineEnd } : undefined,
      line: s.line,
    });
  }
  if (!voices.length) fail(doc, undefined, 'У файлі немає жодного голосу (очікується «## <id голосу>»).');
  return { doc, voices, questions: extractQuestions(doc) };
}

export function findVoice(voices: VoicesDoc, id: string): VoiceEntry {
  const v = voices.voices.find((x) => x.id === id);
  if (!v) fail(voices.doc, undefined, `Голос «${id}» не описано у voices.md (є: ${voices.voices.map((x) => x.id).join(', ')}).`);
  return v;
}

/** Записує voice_id у voices.md (замінює рядок поля, не чіпаючи решти файлу). */
export function writeVoiceId(entry: VoiceEntry, voiceId: string): void {
  const file = paths.voicesDoc();
  const lines = readFileSync(file, 'utf8').split('\n');
  const newLine = `voice_id: ${voiceId}`;
  if (entry.voiceIdLines) {
    lines.splice(entry.voiceIdLines.from - 1, entry.voiceIdLines.to - entry.voiceIdLines.from + 1, newLine);
  } else {
    // Поля немає: додаємо в кінець розділу голосу (перед наступним заголовком).
    let end = lines.length;
    for (let i = entry.line; i < lines.length; i++) {
      if (/^#{1,2}\s/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    while (end > entry.line && !lines[end - 1]!.trim()) end--;
    lines.splice(end, 0, newLine);
  }
  writeFileSync(file, lines.join('\n'));
}

// ------------------------------------------------------------------ розмітка озвучення

export interface VoiceFragment {
  n: number;
  /** Текст із тегами, в один рядок. */
  tagged: string;
  line: number;
}
export interface VoiceDoc {
  voiceId: string;
  fragments: VoiceFragment[];
  pronunciation: string;
  questions: string;
  raw: string;
}

export function parseVoiceMd(story: string): VoiceDoc {
  const doc = readDoc(paths.storyFile(story, 'voice.md'), 'voice-director');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields } = readFieldsStrict(doc, preamble, { voice: /^Голос$/i });
  const voiceId = requireField(doc, fields, 'voice', 'Голос', 'шапка файлу').value.replace(/[`*]/g, '').trim();
  const fragments: VoiceFragment[] = [];
  let prev = 0;
  for (const s of sections) {
    const m = /^Фрагмент\s+(\d+)$/i.exec(s.title);
    if (!m) continue;
    const n = Number(m[1]);
    if (n <= prev) fail(doc, s.line, `Номери фрагментів мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const tagged = flatText(s.body);
    if (!tagged) fail(doc, s.line, `Фрагмент ${n} порожній.`);
    const bp = bracketProblem(tagged);
    if (bp) fail(doc, s.line, `Фрагмент ${n}: ${bp}. Теги мають бути у вигляді [tag].`);
    fragments.push({ n, tagged, line: s.line });
  }
  if (!fragments.length) fail(doc, undefined, 'Немає жодного розділу «## Фрагмент N».');
  return {
    voiceId,
    fragments,
    pronunciation: sectionText(doc, /^Вимова$/i),
    questions: extractQuestions(doc),
    raw: doc.lines.map((l) => l.text).join('\n'),
  };
}

/** Звіряє розмітку озвучення зі сценарієм: ті самі номери й ті самі слова (без тегів). */
export function checkVoiceAgainstScript(story: string, voice: VoiceDoc, script: ScriptDoc): void {
  const file = paths.storyFile(story, 'voice.md');
  const doc = readDoc(file, 'voice-director');
  const sNums = script.fragments.map((f) => f.n).join(',');
  const vNums = voice.fragments.map((f) => f.n).join(',');
  if (sNums !== vNums) {
    fail(doc, undefined, `Номери фрагментів не збігаються зі сценарієм. У script.md: ${sNums}; у voice.md: ${vNums}.`);
  }
  for (const vf of voice.fragments) {
    const sf = script.fragments.find((f) => f.n === vf.n)!;
    const a = collapseWs(sf.text);
    const b = stripTags(vf.tagged);
    if (a !== b) {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      fail(
        doc,
        vf.line,
        `Текст фрагмента ${vf.n} відрізняється від script.md (слова змінювати не можна). Перша розбіжність на знаку ${i + 1}: ` +
          `у сценарії «…${a.slice(Math.max(0, i - 15), i + 25)}…», у розмітці «…${b.slice(Math.max(0, i - 15), i + 25)}…».`,
      );
    }
  }
}

// ------------------------------------------------------------------ стиль

export interface StyleDoc {
  generatorText: string;
  overview: string;
  questions: string;
}

export function parseStyle(): StyleDoc {
  const doc = readDoc(paths.styleDoc(), 'art-director');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const s = requireSection(doc, sections, /^Текст стилю для генератора/i, '## Текст стилю для генератора (англійською)');
  const generatorText = flatText(s.body);
  if (!generatorText || isPlaceholder(generatorText)) fail(doc, s.line, 'Текст стилю порожній або лишився шаблоном.');
  const overview = blockText([...preamble, ...sections.filter((x) => !/^Текст стилю|^Питання/i.test(x.title)).flatMap((x) => [{ n: x.line, text: `### ${x.title}` }, ...x.body])]);
  return { generatorText, overview, questions: extractQuestions(doc) };
}

// ------------------------------------------------------------------ герої

export interface SheetSpec {
  slug: string;
  title: string;
  prompt: string;
  line: number;
}
export interface CharacterResource {
  slug: string;
  assetId: string;
  line: number;
}
export interface CharacterDoc {
  id: string;
  name: string;
  appears: string;
  description: string;
  sheets: SheetSpec[];
  resources: CharacterResource[];
  /** Діапазон тіла розділу «Ресурси» і заголовок (для запису id). */
  resourcesSection?: { headingLine: number; bodyFrom: number; bodyTo: number };
  acceptance: string;
  questions: string;
}

export function parseCharacter(id: string): CharacterDoc {
  const doc = readDoc(paths.characterDoc(id), 'art-director', `(герой «${id}» зазначено в розкадровці)`);
  const h1 = doc.lines.find((l) => /^#\s+/.test(l.text));
  if (!h1) fail(doc, 1, 'Немає заголовка «# <Ім’я героя>».');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields } = readFieldsStrict(doc, preamble, { appears: /^З['’ʼ]?являється в$/i });
  const gen = requireSection(doc, sections, /^Текст для генератора аркуша/i, '## Текст для генератора аркуша героя (англійською)');
  const subs = splitByHeading(gen.body, 3).sections;
  const sheets: SheetSpec[] = [];
  if (subs.length) {
    const used = new Set<string>();
    subs.forEach((s, i) => {
      const prompt = flatText(s.body);
      if (!prompt) fail(doc, s.line, `Версія «${s.title}»: порожній текст для генератора.`);
      let slug = slugify(s.title) || `v${i + 1}`;
      if (used.has(slug)) slug = `${slug}-${i + 1}`;
      used.add(slug);
      sheets.push({ slug, title: s.title, prompt, line: s.line });
    });
  } else {
    const prompt = flatText(gen.body);
    if (!prompt || isPlaceholder(prompt)) fail(doc, gen.line, 'Текст для генератора аркуша порожній або лишився шаблоном.');
    sheets.push({ slug: 'main', title: 'main', prompt, line: gen.line });
  }
  const res = sections.find((s) => /^Ресурси$/i.test(s.title));
  const resources: CharacterResource[] = [];
  let resourcesSection: CharacterDoc['resourcesSection'];
  if (res) {
    const body = res.body;
    resourcesSection = { headingLine: res.line, bodyFrom: body[0]?.n ?? res.line + 1, bodyTo: body[body.length - 1]?.n ?? res.line };
    for (const l of body) {
      const m = /^\s*[-*]\s*([\w.-]+)\s*:\s*`?([A-Za-z0-9_-]{8,})`?/.exec(l.text);
      if (m) resources.push({ slug: m[1]!, assetId: m[2]!, line: l.n });
    }
  }
  return {
    id,
    name: h1.text.replace(/^#\s+/, '').trim(),
    appears: fields.appears?.value ?? '',
    description: blockText(preamble.filter((l) => !/^#\s/.test(l.text) && !/^\s*[-*]?\s*\**З['’ʼ]?являється в/i.test(l.text))),
    sheets,
    resources,
    resourcesSection,
    acceptance: sectionText(doc, /^Приймання$/i),
    questions: extractQuestions(doc),
  };
}

/** Додає (або замінює) рядок «- slug: asset_id …» у розділі «Ресурси» файлу героя. */
export function writeCharacterResource(id: string, slug: string, assetId: string, note: string): void {
  const file = paths.characterDoc(id);
  const lines = readFileSync(file, 'utf8').split('\n');
  const doc = parseCharacter(id);
  const entry = `- ${slug}: ${assetId} (${note})`;
  const existing = doc.resources.find((r) => r.slug === slug);
  if (existing) {
    lines[existing.line - 1] = entry;
  } else if (doc.resourcesSection) {
    // Заглушку-шаблон на кшталт «<сюди технік впише…>» прибираємо, інше лишаємо.
    const { headingLine, bodyTo } = doc.resourcesSection;
    for (let i = headingLine; i < bodyTo; i++) if (/^\s*<[^>]*>\s*$/.test(lines[i] ?? '')) lines[i] = '';
    let at = bodyTo;
    while (at > headingLine && !(lines[at - 1] ?? '').trim()) at--;
    lines.splice(at, 0, entry);
  } else {
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    lines.push('', '## Ресурси', entry, '');
  }
  writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

// ------------------------------------------------------------------ розкадровка

export interface HeroRef {
  id: string;
  version?: string;
}
export interface StoryboardFrame {
  n: number;
  fragment: number;
  inFrame: string;
  heroes: HeroRef[];
  camera: string;
  mood: string;
  prompt: string;
  line: number;
}
export interface StoryboardDoc {
  format: string;
  frames: StoryboardFrame[];
  acceptance: string;
  questions: string;
}

const FRAME_DEFS = {
  fragment: /^Фрагмент сценарію$/i,
  inFrame: /^У кадрі$/i,
  heroes: /^Герої$/i,
  camera: /^Камера$/i,
  mood: /^Світло і настрій$/i,
  prompt: /^Для генератора/i,
};

const NO_HEROES = /^(—|–|-|немає|нема|жодного|none|no one)\.?$/i;

export function parseHeroRefs(doc: Doc, value: string, line: number): HeroRef[] {
  const v = value.replace(/[`*]/g, '').trim();
  if (!v || NO_HEROES.test(v)) return [];
  const refs: HeroRef[] = [];
  for (const part of v.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([\w.-]+)(?:\s*[:/]\s*([\w.-]+))?$/.exec(part);
    if (!m) fail(doc, line, `Герої: «${part}» не схоже на id з characters/ (очікується «natalia» або «natalia:young»).`);
    refs.push({ id: m[1]!, version: m[2] });
  }
  return refs;
}

export function parseStoryboard(story: string): StoryboardDoc {
  const doc = readDoc(paths.storyFile(story, 'storyboard.md'), 'art-director');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields: head } = readFieldsStrict(doc, preamble, { format: /^Формат кадру$/i });
  const format = requireField(doc, head, 'format', 'Формат кадру', 'шапка файлу').value;
  const frames: StoryboardFrame[] = [];
  let prev = 0;
  for (const s of sections) {
    const m = /^Кадр\s+(\d+)$/i.exec(s.title);
    if (!m) continue;
    const n = Number(m[1]);
    if (n <= prev) fail(doc, s.line, `Номери кадрів мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const { fields } = readFieldsStrict(doc, s.body, FRAME_DEFS);
    const where = `## ${s.title}`;
    const fr = requireField(doc, fields, 'fragment', 'Фрагмент сценарію', where, s.line);
    const prompt = requireField(doc, fields, 'prompt', 'Для генератора (англійською)', where, s.line);
    const heroesField = fields.heroes;
    if (!heroesField) fail(doc, s.line, `У розділі «${where}» немає поля «Герої:» (якщо героїв немає, напишіть «—»).`);
    frames.push({
      n,
      fragment: parseInteger(doc, fr.value, fr.line, `${where}, Фрагмент сценарію`),
      inFrame: fields.inFrame?.value ?? '',
      heroes: parseHeroRefs(doc, heroesField.value, heroesField.line),
      camera: fields.camera?.value ?? '',
      mood: fields.mood?.value ?? '',
      prompt: collapseWs(prompt.value),
      line: s.line,
    });
  }
  if (!frames.length) fail(doc, undefined, 'Немає жодного розділу «## Кадр N».');
  return { format, frames, acceptance: sectionText(doc, /^Приймання$/i), questions: extractQuestions(doc) };
}

/** Перевіряє, що кадри посилаються тільки на наявні фрагменти сценарію. */
export function checkStoryboardAgainstScript(story: string, sb: StoryboardDoc, script: ScriptDoc): void {
  const doc = readDoc(paths.storyFile(story, 'storyboard.md'), 'art-director');
  const known = new Set(script.fragments.map((f) => f.n));
  for (const f of sb.frames) {
    if (!known.has(f.fragment)) fail(doc, f.line, `Кадр ${f.n} посилається на фрагмент ${f.fragment}, якого немає у script.md (є: ${[...known].join(', ')}).`);
  }
}

const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];

/** «9:16, вертикальний» → «9:16». Помилка, якщо формат не з переліку API. */
export function aspectFromFormat(format: string): string {
  const m = /(\d+)\s*[:х×x/]\s*(\d+)/i.exec(format);
  if (!m) throw new Error(`Не вдалося визначити співвідношення сторін із «Формат кадру: ${format}» (очікується «9:16»). Задайте --aspect.`);
  const a = `${m[1]}:${m[2]}`;
  if (!ASPECTS.includes(a)) throw new Error(`Співвідношення ${a} не підтримує модель (є: ${ASPECTS.join(', ')}). Задайте --aspect.`);
  return a;
}

// ------------------------------------------------------------------ звук

export interface MusicSpec {
  prompt: string;
  seconds: number;
  instrumental: boolean;
  development: string;
  line: number;
}
export interface SfxSpec {
  n: number;
  prompt: string;
  seconds: number;
  where: string;
  loudness: string;
  line: number;
}
export interface SoundDoc {
  totalSeconds: number | undefined;
  idea: string;
  music: MusicSpec;
  sfx: SfxSpec[];
  mix: string;
  questions: string;
}

const SOUND_HEAD = { total: /^Загальна тривалість$/i, idea: /^Задум$/i };
const MUSIC_DEFS = {
  prompt: /^Для генератора музики/i,
  seconds: /^Тривалість$/i,
  instrumental: /^Інструментальна$/i,
  development: /^Розвиток по фільму$/i,
};
const SFX_DEFS = {
  prompt: /^Для генератора/i,
  seconds: /^Тривалість$/i,
  where: /^Де$/i,
  loudness: /^Гучність під голосом$/i,
};

export const MUSIC_MIN_SECONDS = 3;
export const MUSIC_MAX_SECONDS = 600;
export const SFX_MIN_SECONDS = 0.5;
export const SFX_MAX_SECONDS = 30;

export function parseSound(story: string): SoundDoc {
  const doc = readDoc(paths.storyFile(story, 'sound.md'), 'composer');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields: head } = readFieldsStrict(doc, preamble, SOUND_HEAD);
  const totalSeconds = head.total && !isPlaceholder(head.total.value) ? parseSeconds(doc, head.total.value, head.total.line, 'Загальна тривалість') : undefined;
  const ms = requireSection(doc, sections, /^Музика$/i, '## Музика');
  const { fields: mf } = readFieldsStrict(doc, ms.body, MUSIC_DEFS);
  const prompt = requireField(doc, mf, 'prompt', 'Для генератора музики (англійською)', '## Музика', ms.line);
  const secF = requireField(doc, mf, 'seconds', 'Тривалість', '## Музика', ms.line);
  const seconds = parseSeconds(doc, secF.value, secF.line, 'Музика, Тривалість');
  if (seconds < MUSIC_MIN_SECONDS || seconds > MUSIC_MAX_SECONDS) {
    fail(doc, secF.line, `Тривалість музики ${seconds} с поза межами API (${MUSIC_MIN_SECONDS}–${MUSIC_MAX_SECONDS} с).`);
  }
  const instF = requireField(doc, mf, 'instrumental', 'Інструментальна', '## Музика', ms.line);
  if (!/^(так|ні|yes|no)\.?$/i.test(instF.value.trim())) fail(doc, instF.line, `«Інструментальна:» має бути «так» або «ні», а є «${instF.value}».`);

  const sfxSection = requireSection(doc, sections, /^Шуми$/i, '## Шуми');
  const sfx: SfxSpec[] = [];
  let prev = 0;
  for (const s of splitByHeading(sfxSection.body, 3).sections) {
    const m = /^Шум\s+(\d+)$/i.exec(s.title);
    if (!m) fail(doc, s.line, `Заголовок шуму має бути «### Шум N», а є «${s.title}».`);
    const n = Number(m[1]);
    if (n <= prev) fail(doc, s.line, `Номери шумів мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const { fields } = readFieldsStrict(doc, s.body, SFX_DEFS);
    const where = `### ${s.title}`;
    const p = requireField(doc, fields, 'prompt', 'Для генератора (англійською)', where, s.line);
    const dF = requireField(doc, fields, 'seconds', 'Тривалість', where, s.line);
    const sec = parseSeconds(doc, dF.value, dF.line, `${s.title}, Тривалість`);
    if (sec < SFX_MIN_SECONDS || sec > SFX_MAX_SECONDS) {
      fail(doc, dF.line, `Тривалість шуму ${sec} с поза межами API (${SFX_MIN_SECONDS}–${SFX_MAX_SECONDS} с).`);
    }
    sfx.push({
      n,
      prompt: collapseWs(p.value),
      seconds: sec,
      where: fields.where?.value ?? '',
      loudness: fields.loudness?.value ?? '',
      line: s.line,
    });
  }
  return {
    totalSeconds,
    idea: head.idea?.value ?? '',
    music: {
      prompt: collapseWs(prompt.value),
      seconds,
      instrumental: /^(так|yes)/i.test(instF.value.trim()),
      development: mf.development?.value ?? '',
      line: ms.line,
    },
    sfx,
    mix: sectionText(doc, /^Зведення$/i),
    questions: extractQuestions(doc),
  };
}

// ------------------------------------------------------------------ допоміжне

/** Автор і назва історії для заголовка огляду: «Автор: Наталя, м. Донецьк» → «Наталя». */
export function storyAuthorName(story: string): string | undefined {
  try {
    const text = readFileSync(paths.storyFile(story, 'source.md'), 'utf8');
    const m = /^Автор:\s*([^,\n]+)/m.exec(text);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export type { Line, Section, Field };
export { trimLines };
