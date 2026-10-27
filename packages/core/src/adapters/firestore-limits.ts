import { Timestamp, type CollectionReference, type Firestore } from '@google-cloud/firestore';
import { TransientError } from '../errors.js';
import type { AdmitDecision, AdmitRequest, Clock, LimitStore } from '../ports.js';
import { MemoryLimitStore } from './memory-limits.js';

/**
 * Zero-fixed-cost LimitStore for low traffic (no Redis):
 * - quotas, generation counts and LLM spend are exact and shared, in Firestore transactions;
 * - per-minute rate, concurrency and auth-failure throttling are per instance, in memory, so with N instances
 *   a burst can reach N times the limit. Keeping them local also means unauthenticated traffic never
 *   causes Firestore writes.
 * Each counter is one document, which sustains roughly one write per second. Above that per account,
 * switch to Redis (REDIS_URL).
 */
export class FirestoreLimitStore implements LimitStore {
  private readonly counters: CollectionReference;
  private readonly local: MemoryLimitStore;

  constructor(
    private readonly db: Firestore,
    private readonly clock: Clock = () => new Date(),
  ) {
    this.counters = db.collection('limits');
    this.local = new MemoryLimitStore(clock);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new TransientError('Limit store unavailable', { cause: error });
    }
  }

  async admit(request: AdmitRequest): Promise<AdmitDecision> {
    const local = await this.local.admit({
      ...request,
      quotaKey: `local:${request.quotaKey}`,
      quotaLimit: Number.MAX_SAFE_INTEGER,
    });
    if (!local.allowed) return local;

    let quota;
    try {
      quota = await this.consume(request.quotaKey, 1, request.quotaLimit, request.quotaExpiresAt);
    } catch (error) {
      await this.local.release(request.concurrencyKey, request.token);
      throw error;
    }
    if (!quota.allowed) {
      await this.local.release(request.concurrencyKey, request.token);
      return {
        allowed: false,
        reason: 'quota',
        retryAfterMs: request.quotaExpiresAt.getTime() - this.clock().getTime(),
        remaining: local.remaining,
        resetMs: local.resetMs,
      };
    }
    return { ...local, quotaUsed: quota.used };
  }

  release(concurrencyKey: string, token: string): Promise<void> {
    return this.local.release(concurrencyKey, token);
  }

  consume(key: string, amount: number, limit: number, expiresAt: Date) {
    return this.update(key, expiresAt, (used) =>
      used + amount > limit ? { allowed: false, used } : { allowed: true, used: used + amount, write: true },
    );
  }

  async add(key: string, amount: number, expiresAt: Date): Promise<number> {
    const { used } = await this.update(key, expiresAt, (value) => ({ used: value + amount, write: true }));
    return used;
  }

  get(key: string): Promise<number> {
    return this.run(async () => {
      const snapshot = await this.counters.doc(key).get();
      return snapshot.exists ? this.live(snapshot.get('value'), snapshot.get('expiresAt')) : 0;
    });
  }

  hit(key: string, windowMs: number): Promise<number> {
    return this.local.hit(key, windowMs);
  }

  /** Expired counters read as zero; Firestore TTL deletes them later. */
  private live(value: unknown, expiresAt: unknown): number {
    return (expiresAt as Timestamp).toMillis() > this.clock().getTime() ? (value as number) : 0;
  }

  private update<T extends { used: number; write?: boolean }>(
    key: string,
    expiresAt: Date,
    decide: (used: number) => T,
  ): Promise<T> {
    const ref = this.counters.doc(key);
    return this.run(() =>
      this.db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const used = snapshot.exists ? this.live(snapshot.get('value'), snapshot.get('expiresAt')) : 0;
        const result = decide(used);
        if (result.write) tx.set(ref, { value: result.used, expiresAt: Timestamp.fromDate(expiresAt) });
        return result;
      }),
    );
  }
}
