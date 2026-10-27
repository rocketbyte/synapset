import type { TokenUsage } from './schemas.js';

export const PLAN_NAMES = ['free', 'pro', 'enterprise'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

export interface PlanLimits {
  /** Sustained request rate (token bucket refill). */
  requestsPerMinute: number;
  /** Requests allowed back-to-back before the sustained rate applies. */
  burst: number;
  maxConcurrentRequests: number;
  requestsPerMonth: number;
  /** New LLM generations (cache misses) the account may trigger per UTC day. */
  generationsPerDay: number;
}

export const PLANS: Record<PlanName, PlanLimits> = {
  free: {
    requestsPerMinute: 30,
    burst: 10,
    maxConcurrentRequests: 2,
    requestsPerMonth: 10_000,
    generationsPerDay: 20,
  },
  pro: {
    requestsPerMinute: 300,
    burst: 60,
    maxConcurrentRequests: 10,
    requestsPerMonth: 1_000_000,
    generationsPerDay: 1_000,
  },
  enterprise: {
    requestsPerMinute: 1_200,
    burst: 200,
    maxConcurrentRequests: 50,
    requestsPerMonth: 20_000_000,
    generationsPerDay: 10_000,
  },
};

export function limitsFor(plan: PlanName, overrides: Partial<PlanLimits> = {}): PlanLimits {
  return { ...PLANS[plan], ...overrides };
}

const iso = (date: Date) => date.toISOString();
export const utcDay = (now: Date) => iso(now).slice(0, 10);
export const utcMonth = (now: Date) => iso(now).slice(0, 7);
export const endOfUtcDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
export const endOfUtcMonth = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export const counterKeys = {
  rate: (accountId: string) => `rl:${accountId}`,
  concurrency: (accountId: string) => `cc:${accountId}`,
  monthlyRequests: (accountId: string, now: Date) => `rq:${accountId}:${utcMonth(now)}`,
  dailyGenerations: (accountId: string, now: Date) => `gen:${accountId}:${utcDay(now)}`,
  dailySpend: (now: Date) => `spend:${utcDay(now)}`,
  authFailures: (ip: string) => `af:${ip}`,
};

/** USD per million tokens. Matched by longest prefix so dated or versioned model ids resolve. */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
};
/** Deliberately high so an unpriced model can never slip under the spend budget. */
const UNKNOWN_MODEL_PRICE = { input: 10, output: 50 };

export function priceFor(model: string): { input: number; output: number; known: boolean } {
  const match = Object.keys(MODEL_PRICES)
    .filter((prefix) => model.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return match
    ? { ...(MODEL_PRICES[match] as { input: number; output: number }), known: true }
    : { ...UNKNOWN_MODEL_PRICE, known: false };
}

export function costUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** Spend is stored as integer micro-dollars so counters stay exact. */
export const toMicroUsd = (usd: number) => Math.ceil(usd * 1_000_000);
