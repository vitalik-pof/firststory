// Робота з текстом озвучення: теги інтонацій у квадратних дужках.

import { createHash } from 'node:crypto';

export const TAG_RE = /\[[^\[\]]*\]/g;

export function stripTags(text: string): string {
  return text.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Перевіряє, що квадратні дужки збалансовані й не вкладені. Повертає опис проблеми або null. */
export function bracketProblem(text: string): string | null {
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[') {
      if (open >= 0) return `вкладена або незакрита «[» на позиції ${open + 1}`;
      open = i;
    } else if (c === ']') {
      if (open < 0) return `зайва «]» на позиції ${i + 1}`;
      open = -1;
    }
  }
  return open >= 0 ? `незакрита «[» на позиції ${open + 1}` : null;
}

const UK: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ъ: '', ы: 'y', э: 'e', ё: 'io',
};

/** Slug для імен файлів: транслітерація кирилиці, решта не-алфанумеричного стає «-». */
export function slugify(text: string): string {
  const t = [...text.toLowerCase()].map((c) => UK[c] ?? c).join('');
  return t.replace(/['’ʼ`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Дуже грубий хеш для порівняння «чи змінився текст»: SHA-1 з node:crypto. */
export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
