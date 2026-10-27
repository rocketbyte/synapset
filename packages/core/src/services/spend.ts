import type { Principal } from '../auth.js';
import { costUsd, counterKeys, endOfUtcDay, toMicroUsd } from '../billing.js';
import { BudgetExhaustedError, QuotaExceededError } from '../errors.js';
import type { TokenUsage } from '../schemas.js';
import type { Clock, GenerationGate, GenerationReservation, LimitStore } from '../ports.js';

/**
 * Two independent spend controls on LLM generation:
 * - per account: a daily generation quota from the plan;
 * - service-wide: a daily USD budget across all accounts and providers.
 * Overshoot is bounded by in-flight jobs (worker instances x concurrency x one generation's max cost).
 */
export class SpendGuard implements GenerationGate {
  constructor(
    private readonly store: LimitStore,
    private readonly dailyBudgetUsd: number,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async assertBudgetAvailable(): Promise<void> {
    const now = this.clock();
    const spent = await this.store.get(counterKeys.dailySpend(now));
    if (spent >= toMicroUsd(this.dailyBudgetUsd)) throw new BudgetExhaustedError(endOfUtcDay(now));
  }

  async reserve(principal: Principal): Promise<GenerationReservation> {
    await this.assertBudgetAvailable();
    const now = this.clock();
    const key = counterKeys.dailyGenerations(principal.accountId, now);
    const resetAt = endOfUtcDay(now);
    const { allowed } = await this.store.consume(key, 1, principal.limits.generationsPerDay, resetAt);
    if (!allowed)
      throw new QuotaExceededError('generations_per_day', principal.limits.generationsPerDay, resetAt);
    return {
      release: async () => {
        await this.store.add(key, -1, resetAt);
      },
    };
  }

  /** Records actual spend after a generation; returns its cost in USD. */
  async recordSpend(model: string, usage: TokenUsage): Promise<number> {
    const now = this.clock();
    const cost = costUsd(model, usage);
    await this.store.add(
      counterKeys.dailySpend(now),
      toMicroUsd(cost),
      new Date(endOfUtcDay(now).getTime() + 86_400_000),
    );
    return cost;
  }
}
