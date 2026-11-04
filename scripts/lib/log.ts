// Вивід у консоль. Ключ API ніколи не друкується: усі рядки проходять через redact().

let secrets: string[] = [];

/** Реєструє значення, які не можна виводити (наприклад, ключ API). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

export function log(message = ''): void {
  console.log(redact(message));
}

export function warn(message: string): void {
  console.error(redact(`УВАГА: ${message}`));
}

export function resetSecretsForTests(): void {
  secrets = [];
}

/**
 * Друкує прогрес, поки довга операція триває: перше повідомлення через
 * `firstAfterMs`, далі кожні `everyMs`. Потрібно, щоб процес довший за
 * 30 секунд не мовчав.
 */
export async function withHeartbeat<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { firstAfterMs?: number; everyMs?: number; print?: (m: string) => void } = {},
): Promise<T> {
  const print = opts.print ?? log;
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const tick = (): void => {
    print(`  … ${label}: триває вже ${Math.round((Date.now() - started) / 1000)} с`);
    timer = setTimeout(tick, opts.everyMs ?? 15_000);
    timer.unref?.();
  };
  timer = setTimeout(tick, opts.firstAfterMs ?? 15_000);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
