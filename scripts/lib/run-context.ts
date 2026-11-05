// Контекст запуску платного скрипта: режим (сухий прогін чи справжній), ліміт кредитів,
// облік витрат у маніфесті. Ліміт — загальний на історію: враховує все, що вже записано
// в маніфесті (credits.total_spent), плюс витрати цього запуску.

import { log } from './log';
import type { ElevenLabsClient } from './elevenlabs';
import { addCredits, readManifest, updateManifest } from './manifest';

export class BudgetStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetStop';
  }
}

export class RunContext {
  private startedAt = new Date().toISOString();
  private creditsBefore = 0;
  private itemSpent = 0;
  private started = false;

  constructor(
    readonly client: ElevenLabsClient,
    readonly story: string,
    readonly script: string,
    readonly run: boolean,
    readonly limit?: number,
  ) {}

  get dryRun(): boolean {
    return !this.run;
  }

  /** Запис про запуск і друк балансу. У сухому прогоні нічого не пише. */
  async start(): Promise<void> {
    if (this.dryRun) return;
    const sub = await this.client.getSubscription();
    // База: стабілізований лічильник (він відстає, тож без цього різниця приписала б чужі витрати цьому запуску).
    this.creditsBefore = await this.client.baselineCredits();
    this.started = true;
    const recorded = readManifest(this.story).credits.total_spent;
    log(`Баланс: витрачено ${sub.character_count} із ${sub.character_limit}. У маніфесті записано витрат: ${recorded}. Ліміт: ${this.limit ?? 'не задано'}.`);
    if (sub.character_limit - sub.character_count < 1) throw new BudgetStop('На акаунті не лишилось кредитів.');
  }

  /** Скільки вже витрачено за цією історією (маніфест) з урахуванням поточного запуску. */
  spentSoFar(): number {
    return readManifest(this.story).credits.total_spent;
  }

  /** Зупиняє скрипт перед викликом, якщо до ліміту лишилось менше, ніж коштуватиме виклик. */
  assertBudget(expected: number, what: string): void {
    if (this.limit === undefined) return;
    const left = this.limit - this.spentSoFar();
    if (left < expected) {
      throw new BudgetStop(
        `Зупинено перед «${what}»: очікувана вартість ~${Math.ceil(expected)} кредитів, а до ліміту ${this.limit} лишилось ${Math.max(0, Math.floor(left))} ` +
          `(у маніфесті вже витрачено ${this.spentSoFar()}). Нічого не списано. Запитайте режисера про новий ліміт.`,
      );
    }
  }

  /** Записує фактичну витрату виклику в маніфест одразу (щоб збій сесії її не втратив). */
  recordSpent(spent: number): number {
    const s = Math.max(0, spent);
    this.itemSpent += s;
    addCredits(this.story, s);
    return s;
  }

  /** Підсумок запуску: різниця лічильника до/після кроку, звірка з сумою за виклики. */
  async finish(): Promise<{ spentRun: number }> {
    if (!this.started) return { spentRun: 0 };
    const stable = await this.client.waitForStableCredits();
    const sub = { character_count: stable.value };
    const spentRun = sub.character_count - this.creditsBefore;
    const unattributed = Math.max(0, spentRun - this.itemSpent);
    updateManifest(this.story, (m) => {
      if (unattributed > 0) m.credits.total_spent += unattributed;
      m.credits.runs.push({
        script: this.script,
        started_at: this.startedAt,
        finished_at: new Date().toISOString(),
        credits_before: this.creditsBefore,
        credits_after: sub.character_count,
        spent_run: spentRun,
      });
    });
    log(`\nПідсумок запуску: лічильник кредитів ${this.creditsBefore} → ${sub.character_count}, витрачено ${spentRun}. Усього за історією в маніфесті: ${this.spentSoFar()}.`);
    return { spentRun };
  }
}
