import type { AdmitDecision, AdmitRequest, Clock, LimitStore } from '../ports.js';

interface Counter {
  value: number;
  expiresAt: number;
}

/** Single-process LimitStore with the same semantics as RedisLimitStore. For tests and local development only. */
export class MemoryLimitStore implements LimitStore {
  private readonly counters = new Map<string, Counter>();
  private readonly buckets = new Map<string, number>();
  private readonly slots = new Map<string, Map<string, number>>();

  constructor(private readonly clock: Clock = () => new Date()) {}

  private now() {
    return this.clock().getTime();
  }

  private read(key: string): number {
    const counter = this.counters.get(key);
    if (!counter || counter.expiresAt <= this.now()) return 0;
    return counter.value;
  }

  admit(request: AdmitRequest): Promise<AdmitDecision> {
    const now = this.now();
    const emission = 60_000 / request.requestsPerMinute;
    const tolerance = emission * request.burst;
    const tat = Math.max(this.buckets.get(request.rateKey) ?? now, now);
    const diff = tat + emission - now;
    if (diff > tolerance) {
      return Promise.resolve({
        allowed: false,
        reason: 'rate',
        retryAfterMs: Math.ceil(diff - tolerance),
        remaining: 0,
        resetMs: Math.ceil(tat - now),
      });
    }
    const remaining = Math.floor((tolerance - diff) / emission);

    const slots = this.slots.get(request.concurrencyKey) ?? new Map<string, number>();
    for (const [token, at] of slots) if (at <= now - request.concurrencyTtlMs) slots.delete(token);
    if (slots.size >= request.maxConcurrent) {
      return Promise.resolve({
        allowed: false,
        reason: 'concurrency',
        retryAfterMs: 1000,
        remaining,
        resetMs: diff,
      });
    }

    const used = this.read(request.quotaKey);
    if (used + 1 > request.quotaLimit) {
      return Promise.resolve({
        allowed: false,
        reason: 'quota',
        retryAfterMs: request.quotaExpiresAt.getTime() - now,
        remaining,
        resetMs: diff,
      });
    }

    this.buckets.set(request.rateKey, tat + emission);
    slots.set(request.token, now);
    this.slots.set(request.concurrencyKey, slots);
    this.counters.set(request.quotaKey, { value: used + 1, expiresAt: request.quotaExpiresAt.getTime() });
    return Promise.resolve({ allowed: true, remaining, resetMs: Math.ceil(diff), quotaUsed: used + 1 });
  }

  release(concurrencyKey: string, token: string): Promise<void> {
    this.slots.get(concurrencyKey)?.delete(token);
    return Promise.resolve();
  }

  consume(key: string, amount: number, limit: number, expiresAt: Date) {
    const used = this.read(key);
    if (used + amount > limit) return Promise.resolve({ allowed: false, used });
    this.counters.set(key, { value: used + amount, expiresAt: expiresAt.getTime() });
    return Promise.resolve({ allowed: true, used: used + amount });
  }

  add(key: string, amount: number, expiresAt: Date): Promise<number> {
    const value = this.read(key) + amount;
    this.counters.set(key, { value, expiresAt: expiresAt.getTime() });
    return Promise.resolve(value);
  }

  get(key: string): Promise<number> {
    return Promise.resolve(this.read(key));
  }

  hit(key: string, windowMs: number): Promise<number> {
    const current = this.counters.get(key);
    const live =
      current && current.expiresAt > this.now() ? current : { value: 0, expiresAt: this.now() + windowMs };
    live.value++;
    this.counters.set(key, live);
    return Promise.resolve(live.value);
  }
}
