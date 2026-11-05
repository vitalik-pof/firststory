// Суворий розбір markdown-документів ролей. Якщо документ не за форматом, кидаємо
// DocFormatError із файлом, рядком і роллю, якої це стосується. Нічого не вгадуємо.

import { existsSync, readFileSync } from 'node:fs';
import { paths } from './paths';

export type Role = 'scenarist' | 'art-director' | 'voice-director' | 'composer' | 'editor' | 'producer';

export interface Line {
  /** Номер рядка у файлі, з 1. */
  n: number;
  text: string;
}

export class DocFormatError extends Error {
  constructor(
    public file: string,
    public line: number | undefined,
    public role: Role,
    message: string,
  ) {
    super(`Документ не за форматом: ${paths.rel(file)}${line ? `, рядок ${line}` : ''} (роль: ${role}). ${message}`);
    this.name = 'DocFormatError';
  }
}

export class MissingDocError extends Error {
  constructor(file: string, role: Role, hint = '') {
    super(`Не знайдено файл ${paths.rel(file)} (його має створити роль ${role}).${hint ? ' ' + hint : ''}`);
    this.name = 'MissingDocError';
  }
}

export interface Doc {
  file: string;
  role: Role;
  lines: Line[];
}

export function readDoc(file: string, role: Role, hint?: string): Doc {
  if (!existsSync(file)) throw new MissingDocError(file, role, hint);
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
  return { file, role, lines };
}

export function fail(doc: Doc, line: number | undefined, message: string): never {
  throw new DocFormatError(doc.file, line, doc.role, message);
}

export interface Section {
  level: number;
  title: string;
  /** Рядок заголовка. */
  line: number;
  body: Line[];
}

const headingRe = (level: number) => new RegExp(`^#{${level}}\\s+(.*?)\\s*#*\\s*$`);

/** Ділить рядки за заголовками точного рівня. Усе до першого заголовка — preamble. */
export function splitByHeading(lines: Line[], level: number): { preamble: Line[]; sections: Section[] } {
  const re = headingRe(level);
  const preamble: Line[] = [];
  const sections: Section[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l.text)) inFence = !inFence;
    const m = !inFence ? re.exec(l.text) : null;
    if (m) sections.push({ level, title: m[1]!.trim(), line: l.n, body: [] });
    else if (sections.length) sections[sections.length - 1]!.body.push(l);
    else preamble.push(l);
  }
  return { preamble, sections };
}

export function trimLines(lines: Line[]): Line[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.text.trim()) a++;
  while (b > a && !lines[b - 1]!.text.trim()) b--;
  return lines.slice(a, b);
}

/** Текст блоку з абзацами: рядки через \n, порожні рядки зберігаються як розділювачі. */
export function blockText(lines: Line[]): string {
  return trimLines(lines)
    .map((l) => l.text.trimEnd())
    .join('\n');
}

/** Текст як один рядок: переноси рядків стають пробілами. */
export function flatText(lines: Line[]): string {
  return trimLines(lines)
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

export interface Field {
  value: string;
  /** Рядок, де поле починається, і останній рядок його значення. */
  line: number;
  lineEnd: number;
}

export type FieldDefs = Record<string, RegExp>;

function parseFieldLine(text: string): { label: string; rest: string } | null {
  const cleaned = text.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '');
  const m = /^\s*([^:：]{1,90}?)\s*[:：]\s*(.*)$/.exec(cleaned);
  return m ? { label: m[1]!.replace(/[*`]/g, '').trim(), rest: m[2]! } : null;
}

/**
 * Читає поля «Ключ: значення». Поле починається тільки з відомого ключа,
 * решта рядків (навіть із двокрапкою) — продовження значення попереднього поля.
 */
export function readFields(lines: Line[], defs: FieldDefs): { fields: Record<string, Field>; before: Line[] } {
  const fields: Record<string, Field> = {};
  const before: Line[] = [];
  let current: { name: string; parts: string[]; line: number; lineEnd: number } | null = null;
  const flush = (): void => {
    if (!current) return;
    fields[current.name] = { value: current.parts.join('\n').trim(), line: current.line, lineEnd: current.lineEnd };
    current = null;
  };
  for (const l of lines) {
    const pf = parseFieldLine(l.text);
    const name = pf ? Object.keys(defs).find((k) => defs[k]!.test(pf.label)) : undefined;
    if (name && pf) {
      flush();
      if (name in fields) throw new Error(`__dup__${name}__${l.n}`);
      current = { name, parts: [pf.rest], line: l.n, lineEnd: l.n };
    } else if (current) {
      current.parts.push(l.text);
      if (l.text.trim()) current.lineEnd = l.n;
    } else {
      before.push(l);
    }
  }
  flush();
  return { fields, before };
}

/** Те саме, але повторний ключ стає помилкою формату з номером рядка. */
export function readFieldsStrict(doc: Doc, lines: Line[], defs: FieldDefs): { fields: Record<string, Field>; before: Line[] } {
  try {
    return readFields(lines, defs);
  } catch (e) {
    const m = /^__dup__(.+)__(\d+)$/.exec((e as Error).message);
    if (m) fail(doc, Number(m[2]), `Поле «${m[1]}» зустрічається двічі в одному розділі.`);
    throw e;
  }
}

const PLACEHOLDER = /^<[^>]*>$/;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

export function requireField(doc: Doc, fields: Record<string, Field>, name: string, label: string, where: string, atLine?: number): Field {
  const f = fields[name];
  if (!f) fail(doc, atLine, `У розділі «${where}» немає поля «${label}:».`);
  if (!f.value) fail(doc, f.line, `Поле «${label}:» порожнє (розділ «${where}»).`);
  if (isPlaceholder(f.value)) fail(doc, f.line, `Поле «${label}:» лишилось шаблоном ${f.value}.`);
  return f;
}

export function requireSection(doc: Doc, sections: Section[], re: RegExp, label: string): Section {
  const s = sections.find((x) => re.test(x.title));
  if (!s) fail(doc, undefined, `Немає розділу «${label}».`);
  return s;
}

export function parseInteger(doc: Doc, value: string, line: number, what: string): number {
  if (!/^\d+$/.test(value.trim())) fail(doc, line, `${what}: очікувалось ціле число, а є «${value}».`);
  return Number(value.trim());
}

/** Секунди з рядка на кшталт «45», «45 секунд», «45,5 с». Хвилини не приймаємо. */
export function parseSeconds(doc: Doc, value: string, line: number, what: string): number {
  const m = /^[~≈]?\s*(\d+(?:[.,]\d+)?)\s*(с|сек|секунд[аиі]?|s|sec|seconds?)?\.?$/i.exec(value.trim());
  if (!m) fail(doc, line, `${what}: очікувались секунди (наприклад «45» чи «45 секунд»), а є «${value}».`);
  return Number(m[1]!.replace(',', '.'));
}

/** Розділ «Питання»: непорожній текст без заглушок «немає». */
export function extractQuestions(doc: Doc): string {
  const { sections } = splitByHeading(doc.lines, 2);
  const s = sections.find((x) => /^Питання(\s|$)/i.test(x.title));
  if (!s) return '';
  const text = blockText(s.body);
  if (!text || /^(—|-|–|немає\.?|нема\.?|питань немає\.?|none\.?)$/i.test(text.trim())) return '';
  return text;
}

export function sectionText(doc: Doc, re: RegExp): string {
  const { sections } = splitByHeading(doc.lines, 2);
  const s = sections.find((x) => re.test(x.title));
  return s ? blockText(s.body) : '';
}

/** Перший рядок значення поля (усе після першого переносу відкидається). */
export function firstLineOf(value: string): string {
  return (value.split('\n')[0] ?? '').trim();
}
