import { describe, expect, it } from 'vitest';
import { MemoryLimitStore, costUsd, priceFor, type AdmitRequest } from '@synapset/core';

const request = (overrides: Partial<AdmitRequest> = {}): AdmitRequest => ({
  rateKey: 'rl:a',
  requestsPerMinute: 60,
  burst: 3,
  concurrencyKey: 'cc:a',
  maxConcurrent: 10,
  token: Math.random().toString(),
  concurrencyTtlMs: 60_000,
  quotaKey: 'rq:a',
  quotaLimit: 100,
  quotaExpiresAt: new Date('2026-11-01T00:00:00Z'),
  ...overrides,
});

function clockAt(iso: string) {
  let now = new Date(iso).getTime();
  return { clock: () => new Date(now), advance: (ms: number) => (now += ms) };
}

describe('MemoryLimitStore.admit', () => {
  it('allows the burst, then throttles to the sustained rate', async () => {
    const { clock, advance } = clockAt('2026-10-26T12:00:00Z');
    const store = new MemoryLimitStore(clock);

    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await store.admit(request()));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    const denied = decisions[3];
    expect(denied).toMatchObject({ allowed: false, reason: 'rate' });
    expect(denied && !denied.allowed && denied.retryAfterMs).toBeGreaterThan(0);

    advance(1_000); // 60/min refills one request per second
    expect((await store.admit(request())).allowed).toBe(true);
    expect((await store.admit(request())).allowed).toBe(false);
  });

  it('caps concurrent requests until a slot is released', async () => {
    const store = new MemoryLimitStore();
    const limits = { maxConcurrent: 1, burst: 100, requestsPerMinute: 6000 };
    expect((await store.admit(request({ ...limits, token: 't1' }))).allowed).toBe(true);
    expect(await store.admit(request({ ...limits, token: 't2' }))).toMatchObject({ reason: 'concurrency' });

    await store.release('cc:a', 't1');
    expect((await store.admit(request({ ...limits, token: 't3' }))).allowed).toBe(true);
  });

  it('enforces the period quota without consuming rate or quota on denial', async () => {
    const store = new MemoryLimitStore(clockAt('2026-10-26T12:00:00Z').clock);
    expect(await store.admit(request({ quotaLimit: 1 }))).toMatchObject({ allowed: true, quotaUsed: 1 });
    const denied = await store.admit(request({ quotaLimit: 1 }));
    expect(denied).toMatchObject({ allowed: false, reason: 'quota' });
    expect(await store.get('rq:a')).toBe(1);
  });
});

describe('pricing', () => {
  it('prices known models by longest prefix and unknown models pessimistically', () => {
    expect(priceFor('claude-haiku-5-5-20261001')).toMatchObject({ known: true, input: 0.1 });
    expect(priceFor('some-new-model').known).toBe(false);
    expect(costUsd('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(costUsd('some-new-model', { inputTokens: 1000, outputTokens: 0 })).toBeGreaterThan(
      costUsd('claude-opus-5-5', { inputTokens: 1000, outputTokens: 0 }),
    );
  });
});
