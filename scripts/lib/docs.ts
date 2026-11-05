// Парсери документів творчих ролей. Формати описано у файлах .claude/agents/*.md.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Doc, type Field, type Line, type Section,
  blockText, extractQuestions, fail, flatText, isPlaceholder, parseInteger, parseSeconds,
  readDoc, readFieldsStrict, requireField, requireSection, sectionText, splitByHeading, trimLines,
} from './md';
import { getRoot, paths } from './paths';
import { collapseWs, slugify, stripTags, bracketProblem } from './text';

/** Поле з одним рядком: усе після першого переносу (абзаци під шапкою) відкидаємо. */
export function firstLine(value: string): string {
  return (value.split('\n')[0] ?? '').trim();
}

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
  const language = firstLine(requireField(doc, fields, 'language', 'Мова озвучення', 'шапка файлу').value);
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
    if (/^Питання(\s|$)/i.test(s.title)) continue;
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
  const voiceId = firstLine(requireField(doc, fields, 'voice', 'Голос', 'шапка файлу').value).replace(/[`*]/g, '').trim();
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
export function checkVoiceAgainstScript(story: string, voice: VoiceDoc, script: ScriptDoc, allowMissing: number[] = []): void {
  const file = paths.storyFile(story, 'voice.md');
  const doc = readDoc(file, 'voice-director');
  const sNums = script.fragments.filter((f) => voice.fragments.some((v) => v.n === f.n) || !allowMissing.includes(f.n)).map((f) => f.n).join(',');
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
//
// Формати аркушів (art-director):
//  - один аркуш: розділ другого рівня «## Текст для генератора аркуша героя (англійською)»;
//  - кілька версій в одному файлі: розділи «## Версія «2014»: опис», у кожному підрозділ
//    «### Текст для генератора аркуша героя (англійською)». Назва версії — текст у лапках «…».

export interface SheetSpec {
  /** Назва версії як у документі («2014», «вагітна») або «main» для героя з одним аркушем. */
  label: string;
  /** Латиницею, для імен файлів. */
  slug: string;
  prompt: string;
  line: number;
}
export interface CharacterResource {
  label: string;
  assetId: string;
  line: number;
}
export interface CharacterDoc {
  id: string;
  name: string;
  appears: string;
  description: string;
  sheets: SheetSpec[];
  /** Решта розділів (версії тощо) для сторінки огляду. */
  extraSections: Array<{ title: string; text: string }>;
  resources: CharacterResource[];
  resourcesSection?: { headingLine: number; bodyFrom: number; bodyTo: number };
  acceptance: string;
  questions: string;
}

const GEN_TITLE = /^Текст для генератора аркуша/i;

export function listCharacterIds(): string[] {
  const dir = join(getRoot(), 'characters');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
}

export function parseCharacter(id: string): CharacterDoc {
  const doc = readDoc(paths.characterDoc(id), 'art-director', `(герой «${id}» зазначено в розкадровці)`);
  const h1 = doc.lines.find((l) => /^#\s+/.test(l.text));
  if (!h1) fail(doc, 1, 'Немає заголовка «# <Ім’я героя>».');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields } = readFieldsStrict(doc, preamble, { appears: /^З['’ʼ]?явля(є|ю)ться в$/i });
  const sheets: SheetSpec[] = [];
  const extraSections: Array<{ title: string; text: string }> = [];
  const versionSections = sections.filter((s) => /^Версія\s+[«"]/.test(s.title));
  if (versionSections.length) {
    const used = new Set<string>();
    versionSections.forEach((vs, i) => {
      const m = /^Версія\s+[«"]([^»"]+)[»"]/.exec(vs.title);
      if (!m) fail(doc, vs.line, `Назва версії має бути в лапках: «## Версія «2014»: …», а є «${vs.title}».`);
      const label = m[1]!.trim();
      const subs = splitByHeading(vs.body, 3).sections;
      const gen = subs.find((x) => GEN_TITLE.test(x.title));
      if (!gen) fail(doc, vs.line, `У версії «${label}» немає підрозділу «### Текст для генератора аркуша героя (англійською)».`);
      const prompt = flatText(gen.body);
      if (!prompt || isPlaceholder(prompt)) fail(doc, gen.line, `Версія «${label}»: текст для генератора порожній або лишився шаблоном.`);
      let slug = slugify(label) || `v${i + 1}`;
      if (used.has(slug)) slug = `${slug}-${i + 1}`;
      if (sheets.some((x) => x.label.toLowerCase() === label.toLowerCase())) fail(doc, vs.line, `Версія «${label}» описана двічі.`);
      used.add(slug);
      sheets.push({ label, slug, prompt, line: gen.line });
      const textLines = vs.body.filter((l) => l.n < gen.line);
      extraSections.push({ title: vs.title, text: blockText(textLines) });
    });
  } else {
    const gen = requireSection(doc, sections, GEN_TITLE, '## Текст для генератора аркуша героя (англійською)');
    const prompt = flatText(gen.body);
    if (!prompt || isPlaceholder(prompt)) fail(doc, gen.line, 'Текст для генератора аркуша порожній або лишився шаблоном.');
    sheets.push({ label: 'main', slug: 'main', prompt, line: gen.line });
  }
  const res = sections.find((s) => /^Ресурси$/i.test(s.title));
  const resources: CharacterResource[] = [];
  let resourcesSection: CharacterDoc['resourcesSection'];
  if (res) {
    const body = res.body;
    resourcesSection = { headingLine: res.line, bodyFrom: body[0]?.n ?? res.line + 1, bodyTo: body[body.length - 1]?.n ?? res.line };
    for (const l of body) {
      const m = /^\s*[-*]\s*[«"]?([^:»"]+?)[»"]?\s*:\s*`?([A-Za-z0-9_-]{8,})`?/.exec(l.text);
      if (m) resources.push({ label: m[1]!.trim(), assetId: m[2]!, line: l.n });
    }
  }
  const appearsAll = fields.appears?.value ?? '';
  return {
    id,
    name: h1.text.replace(/^#\s+/, '').trim(),
    appears: firstLine(appearsAll),
    description: blockText(preamble.filter((l) => !/^#\s/.test(l.text) && l.n !== fields.appears?.line)),
    sheets,
    extraSections,
    resources,
    resourcesSection,
    acceptance: sectionText(doc, /^Приймання$/i),
    questions: extractQuestions(doc),
  };
}

export function findSheet(doc: CharacterDoc, version: string | undefined, where: string): SheetSpec {
  if (version === undefined) {
    if (doc.sheets.length === 1) return doc.sheets[0]!;
    throw new Error(`${where}: у героя «${doc.id}» ${doc.sheets.length} версії (${doc.sheets.map((s) => `«${s.label}»`).join(', ')}), потрібно вказати версію: ${doc.id} (версія «…»).`);
  }
  const s = doc.sheets.find((x) => x.label.toLowerCase() === version.toLowerCase());
  if (!s) throw new Error(`${where}: невідома версія «${version}» героя «${doc.id}» (є: ${doc.sheets.map((x) => `«${x.label}»`).join(', ')}).`);
  return s;
}

/** Додає (або замінює) рядок «- <версія>: asset_id (…)» у розділі «Ресурси» файлу героя. */
export function writeCharacterResource(id: string, label: string, assetId: string, note: string): void {
  const file = paths.characterDoc(id);
  const lines = readFileSync(file, 'utf8').split('\n');
  const doc = parseCharacter(id);
  const entry = `- ${label}: ${assetId} (${note})`;
  const existing = doc.resources.find((r) => r.label.toLowerCase() === label.toLowerCase());
  if (existing) {
    lines[existing.line - 1] = entry;
  } else if (doc.resourcesSection) {
    const { headingLine, bodyTo } = doc.resourcesSection;
    // Заглушки («Поки порожньо…», «<…>») прибираємо, справжні записи лишаємо.
    for (let i = headingLine; i < bodyTo; i++) if (/^\s*(<[^>]*>|Поки порожньо.*)\s*$/.test(lines[i] ?? '')) lines[i] = '';
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

/**
 * Рядок «Герої:» — вільний текст. Правило: «немає…» означає без референсів; інакше беремо латинські
 * id героїв (natalia, natalia-husband…), а для героя з версіями — «версія «…»» у дужках після id.
 * Решту слів ігноруємо. Чи існує такий герой і така версія, перевіряється пізніше (findSheet).
 */
export function parseHeroRefs(doc: Doc, value: string, line: number, frameN?: number): HeroRef[] {
  const v = value.replace(/[`*]/g, '').trim();
  const where = frameN !== undefined ? `Кадр ${frameN}, «Герої:»` : '«Герої:»';
  if (!v) fail(doc, line, `${where}: порожньо (якщо героїв немає, напишіть «немає»).`);
  if (/^(немає|нема|—|–|-|none)/i.test(v)) return [];
  const refs: HeroRef[] = [];
  const re = /(^|[^\w-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(\s*\(([^)]*)\))?/g;
  for (const m of v.matchAll(re)) {
    const ver = m[4] ? /версі[яї]\s*[«"]([^»"]+)[»"]/i.exec(m[4]) : null;
    refs.push({ id: m[2]!, version: ver?.[1]?.trim() });
  }
  if (!refs.length) fail(doc, line, `${where}: не знайдено жодного id героя (очікується щось на кшталт «natalia (версія «2014»), natalia-husband» або «немає»). Рядок: «${v}».`);
  return refs;
}

export function parseStoryboard(story: string): StoryboardDoc {
  const doc = readDoc(paths.storyFile(story, 'storyboard.md'), 'art-director');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields: head } = readFieldsStrict(doc, preamble, { format: /^Формат кадру$/i });
  const format = firstLine(requireField(doc, head, 'format', 'Формат кадру', 'шапка файлу').value);
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
      heroes: parseHeroRefs(doc, heroesField.value, heroesField.line, n),
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

// ------------------------------------------------------------------ зразки стилю (Етап 1а)

export interface StyleSample {
  n: number;
  shows: string;
  format: string;
  /** Номер фрагмента сценарію або undefined, якщо «немає». */
  fragment?: number;
  heroes: HeroRef[];
  prompt: string;
  line: number;
}
export interface SamplesDoc {
  idea: string;
  samples: StyleSample[];
  questions: string;
}

const SAMPLE_DEFS = {
  shows: /^Що показує$/i,
  format: /^Формат$/i,
  fragment: /^Для фрагмента$/i,
  heroes: /^Герої$/i,
  prompt: /^Для генератора/i,
};

export function parseSamples(): SamplesDoc {
  const doc = readDoc(paths.samplesDoc(), 'art-director');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields: head } = readFieldsStrict(doc, preamble, { idea: /^Задум$/i });
  const samples: StyleSample[] = [];
  let prev = 0;
  for (const s of sections) {
    const m = /^Зразок\s+(\d+)$/i.exec(s.title);
    if (!m) continue;
    const n = Number(m[1]);
    if (n <= prev) fail(doc, s.line, `Номери зразків мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const { fields } = readFieldsStrict(doc, s.body, SAMPLE_DEFS);
    const where = `## ${s.title}`;
    const fmt = firstLine(requireField(doc, fields, 'format', 'Формат', where, s.line).value);
    try {
      aspectFromFormat(fmt);
    } catch (e) {
      fail(doc, fields.format!.line, `${where}: ${(e as Error).message}`);
    }
    const fr = requireField(doc, fields, 'fragment', 'Для фрагмента', where, s.line);
    const frv = firstLine(fr.value);
    const fragment = /^(немає|нема|—|–|-|none)/i.test(frv) ? undefined : parseInteger(doc, frv, fr.line, `${where}, Для фрагмента`);
    const hf = fields.heroes;
    if (!hf) fail(doc, s.line, `У розділі «${where}» немає поля «Герої:» (якщо героїв немає, напишіть «немає»).`);
    samples.push({
      n,
      shows: requireField(doc, fields, 'shows', 'Що показує', where, s.line).value,
      format: fmt,
      fragment,
      heroes: parseHeroRefs(doc, hf.value, hf.line, n),
      prompt: collapseWs(requireField(doc, fields, 'prompt', 'Для генератора (англійською)', where, s.line).value),
      line: s.line,
    });
  }
  if (!samples.length) fail(doc, undefined, 'Немає жодного розділу «## Зразок N».');
  return { idea: head.idea?.value ?? '', samples, questions: extractQuestions(doc) };
}

export function checkSamplesAgainstScript(sd: SamplesDoc, script: ScriptDoc): void {
  const doc = readDoc(paths.samplesDoc(), 'art-director');
  const known = new Set(script.fragments.map((f) => f.n));
  for (const s of sd.samples) {
    if (s.fragment !== undefined && !known.has(s.fragment)) fail(doc, s.line, `Зразок ${s.n}: фрагмента ${s.fragment} немає у script.md (є: ${[...known].join(', ')}).`);
  }
}

// ------------------------------------------------------------------ зразки звуку (Етап 1а)

export interface MusicSample {
  n: number;
  prompt: string;
  seconds: number;
  instrumental: boolean;
  shows: string;
  line: number;
}
export interface SfxSample {
  n: number;
  prompt: string;
  seconds: number;
  shows: string;
  line: number;
}
export interface MixSpec {
  musicSample: number;
  fragments: number[];
  underDb: number;
  pauseDb: number;
  fadeSeconds: number;
  idea: string;
  line: number;
}
export interface SoundSamplesDoc {
  idea: string;
  music: MusicSample[];
  sfx: SfxSample[];
  mix: MixSpec;
  questions: string;
}

/** Число з необов'язковим знаком (допускається «−» і «–»), комою чи крапкою, одиницею. */
export function parseNumber(doc: Doc, value: string, line: number, what: string, unit = ''): number {
  const m = new RegExp(`^([+\\-−–]?)\\s*(\\d+(?:[.,]\\d+)?)\\s*${unit}\\.?$`, 'i').exec(firstLine(value));
  if (!m) fail(doc, line, `${what}: очікувалось число${unit ? ` (можна з «${unit.replace(/[()|?]/g, '')}»)` : ''}, а є «${firstLine(value)}».`);
  const v = Number(m[2]!.replace(',', '.'));
  return m[1] && m[1] !== '+' ? -v : v;
}

/** «1–6», «1-6», «3», «2, 4, 5», «1–3, 5» → відсортований список номерів. */
export function parseFragmentRange(doc: Doc, value: string, line: number): number[] {
  const out = new Set<number>();
  for (const part of firstLine(value).split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–—−]\s*(\d+))?$/.exec(part);
    if (!m) fail(doc, line, `Фрагменти для зразка: очікувалось «1–6», «3» чи «2, 4, 5», а є «${part}».`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a) fail(doc, line, `Фрагменти для зразка: діапазон «${part}» зворотний.`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  if (!out.size) fail(doc, line, 'Фрагменти для зразка: порожньо.');
  return [...out].sort((x, y) => x - y);
}

export function parseSoundSamples(story: string): SoundSamplesDoc {
  const doc = readDoc(paths.soundSamplesDoc(story), 'composer');
  const { preamble, sections } = splitByHeading(doc.lines, 2);
  const { fields: head } = readFieldsStrict(doc, preamble, { idea: /^Задум$/i });
  const music: MusicSample[] = [];
  const ms = requireSection(doc, sections, /^Музика$/i, '## Музика');
  let prev = 0;
  for (const s of splitByHeading(ms.body, 3).sections) {
    const m = /^Зразок\s+(\d+)$/i.exec(s.title);
    if (!m) fail(doc, s.line, `Заголовок зразка музики має бути «### Зразок N», а є «${s.title}».`);
    const n = Number(m[1]);
    if (n <= prev) fail(doc, s.line, `Номери зразків музики мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const { fields } = readFieldsStrict(doc, s.body, { prompt: /^Для генератора музики/i, seconds: /^Тривалість$/i, instrumental: /^Інструментальна$/i, shows: /^Що показує$/i });
    const where = `Музика, ### ${s.title}`;
    const sf = requireField(doc, fields, 'seconds', 'Тривалість', where, s.line);
    const seconds = parseSeconds(doc, sf.value, sf.line, `${where}, Тривалість`);
    if (seconds < MUSIC_MIN_SECONDS || seconds > MUSIC_MAX_SECONDS) fail(doc, sf.line, `Тривалість музики ${seconds} с поза межами API (${MUSIC_MIN_SECONDS}–${MUSIC_MAX_SECONDS} с).`);
    const inf = requireField(doc, fields, 'instrumental', 'Інструментальна', where, s.line);
    if (!/^(так|ні|yes|no)\.?$/i.test(firstLine(inf.value))) fail(doc, inf.line, `«Інструментальна:» має бути «так» або «ні», а є «${inf.value}».`);
    music.push({
      n, seconds, line: s.line, instrumental: /^(так|yes)/i.test(firstLine(inf.value)),
      prompt: collapseWs(requireField(doc, fields, 'prompt', 'Для генератора музики (англійською)', where, s.line).value),
      shows: requireField(doc, fields, 'shows', 'Що показує', where, s.line).value,
    });
  }
  if (!music.length) fail(doc, ms.line, 'У розділі «Музика» немає жодного «### Зразок N».');

  const sfx: SfxSample[] = [];
  const ns = requireSection(doc, sections, /^Шуми$/i, '## Шуми');
  prev = 0;
  for (const s of splitByHeading(ns.body, 3).sections) {
    const m = /^Шум\s+(\d+)$/i.exec(s.title);
    if (!m) fail(doc, s.line, `Заголовок шуму має бути «### Шум N», а є «${s.title}».`);
    const n = Number(m[1]);
    if (n <= prev) fail(doc, s.line, `Номери шумів мають зростати: після ${prev} іде ${n}.`);
    prev = n;
    const { fields } = readFieldsStrict(doc, s.body, { prompt: /^Для генератора/i, seconds: /^Тривалість$/i, shows: /^Що показує$/i });
    const where = `Шуми, ### ${s.title}`;
    const sf = requireField(doc, fields, 'seconds', 'Тривалість', where, s.line);
    const seconds = parseSeconds(doc, sf.value, sf.line, `${where}, Тривалість`);
    if (seconds < SFX_MIN_SECONDS || seconds > SFX_MAX_SECONDS) fail(doc, sf.line, `Тривалість шуму ${seconds} с поза межами API (${SFX_MIN_SECONDS}–${SFX_MAX_SECONDS} с).`);
    sfx.push({
      n, seconds, line: s.line,
      prompt: collapseWs(requireField(doc, fields, 'prompt', 'Для генератора (англійською)', where, s.line).value),
      shows: requireField(doc, fields, 'shows', 'Що показує', where, s.line).value,
    });
  }

  const zs = requireSection(doc, sections, /^Зведення$/i, '## Зведення');
  const { fields: zf } = readFieldsStrict(doc, zs.body, {
    musicSample: /^Зразок музики$/i,
    fragments: /^Фрагменти для зразка$/i,
    under: /^Музика під голосом/i,
    pause: /^Музика в паузах/i,
    fade: /^Час зміни гучності/i,
    idea: /^Задум зведення$/i,
  });
  const W = '## Зведення';
  const msF = requireField(doc, zf, 'musicSample', 'Зразок музики', W, zs.line);
  const musicSample = parseInteger(doc, firstLine(msF.value), msF.line, 'Зведення, Зразок музики');
  if (!music.some((x) => x.n === musicSample)) fail(doc, msF.line, `Зразка музики ${musicSample} немає серед «### Зразок N» (є: ${music.map((x) => x.n).join(', ')}).`);
  const frF = requireField(doc, zf, 'fragments', 'Фрагменти для зразка', W, zs.line);
  const uF = requireField(doc, zf, 'under', 'Музика під голосом, дБ відносно голосу', W, zs.line);
  const pF = requireField(doc, zf, 'pause', 'Музика в паузах, дБ відносно голосу', W, zs.line);
  const fdF = requireField(doc, zf, 'fade', 'Час зміни гучності, с', W, zs.line);
  const underDb = parseNumber(doc, uF.value, uF.line, 'Музика під голосом', '(дБ|dB)?');
  const pauseDb = parseNumber(doc, pF.value, pF.line, 'Музика в паузах', '(дБ|dB)?');
  const fadeSeconds = parseNumber(doc, fdF.value, fdF.line, 'Час зміни гучності', '(с|сек|s)?');
  for (const [v, f, what] of [[underDb, uF, 'Музика під голосом'], [pauseDb, pF, 'Музика в паузах']] as const) {
    if (v < -60 || v > 12) fail(doc, f.line, `${what}: ${v} дБ поза розумними межами (−60…+12).`);
  }
  if (pauseDb < underDb) fail(doc, pF.line, `У паузах музика (${pauseDb} дБ) тихіша, ніж під голосом (${underDb} дБ): очікується навпаки.`);
  if (fadeSeconds < 0.05 || fadeSeconds > 10) fail(doc, fdF.line, `Час зміни гучності ${fadeSeconds} с поза межами 0.05–10 с.`);
  return {
    idea: head.idea?.value ?? '',
    music,
    sfx,
    mix: { musicSample, fragments: parseFragmentRange(doc, frF.value, frF.line), underDb, pauseDb, fadeSeconds, idea: zf.idea?.value ?? '', line: zs.line },
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
