// Спільний розбір прапорців. Платні скрипти за замовчуванням нічого не витрачають.

import { parseArgs } from 'node:util';

export interface CommonFlags {
  story: string;
  run: boolean;
  limit?: number;
}

type OptionDef = { type: 'string' | 'boolean'; short?: string; multiple?: boolean };

export const COMMON_OPTIONS = {
  story: { type: 'string' },
  run: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'limit-credits': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies Record<string, OptionDef>;

export function parseCli<T extends Record<string, OptionDef>>(options: T, argv = process.argv.slice(2)) {
  try {
    return parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...options }, allowPositionals: false, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function commonFlags(
  values: { story?: string; run?: boolean; 'dry-run'?: boolean; 'limit-credits'?: string },
  opts: { paid: boolean },
): CommonFlags {
  if (!values.story) throw new UsageError('Потрібен прапорець --story <id> (наприклад, --story 01-natalia).');
  if (values.run && values['dry-run']) throw new UsageError('--run і --dry-run разом не можна.');
  let limit: number | undefined;
  if (values['limit-credits'] !== undefined) {
    limit = Number(values['limit-credits']);
    if (!Number.isFinite(limit) || limit < 0) throw new UsageError('--limit-credits має бути невід’ємним числом.');
  }
  if (values.run && opts.paid && limit === undefined) {
    throw new UsageError('З --run потрібен --limit-credits N: ліміт кредитів на Етап 1 для цієї історії (разом із вже записаними в маніфесті витратами).');
  }
  return { story: values.story, run: Boolean(values.run), limit };
}

/** Обгортка main(): людські повідомлення замість стеків, код виходу 1. */
export function runMain(main: () => Promise<void>): void {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nПОМИЛКА: ${msg}`);
    if (e instanceof UsageError) console.error('Підказка: додайте --help.');
    process.exitCode = 1;
  });
}
