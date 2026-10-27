import { Firestore } from '@google-cloud/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { FirestoreLimitStore, type AdmitRequest } from '@synapset/core';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

// Runs against the Firestore emulator (FIRESTORE_EMULATOR_HOST), as CI does.
describe.skipIf(!emulator)('FirestoreLimitStore', () => {
  const db = new Firestore({ projectId: 'limits-test' });
  const store = new FirestoreLimitStore(db);
  const run = `${process.pid}-${Date.now()}`;
  const expires = () => new Date(Date.now() + 60_000);
  let n = 0;

  const request = (id: string, overrides: Partial<AdmitRequest> = {}): AdmitRequest => ({
    rateKey: `rl:${id}`,
    requestsPerMinute: 6000,
    burst: 100,
    concurrencyKey: `cc:${id}`,
    maxConcurrent: 10,
    token: `t${++n}`,
    concurrencyTtlMs: 60_000,
    quotaKey: `rq:${id}`,
    quotaLimit: 100,
    quotaExpiresAt: expires(),
    ...overrides,
  });

  afterAll(() => db.terminate());

  it('enforces the shared quota across store instances', async () => {
    const id = `${run}-quota`;
    const other = new FirestoreLimitStore(db);
    expect(await store.admit(request(id, { quotaLimit: 2 }))).toMatchObject({ allowed: true, quotaUsed: 1 });
    expect(await other.admit(request(id, { quotaLimit: 2 }))).toMatchObject({ allowed: true, quotaUsed: 2 });
    expect(await store.admit(request(id, { quotaLimit: 2 }))).toMatchObject({
      allowed: false,
      reason: 'quota',
    });
    expect(await store.get(`rq:${id}`)).toBe(2);
  });

  it('frees the concurrency slot when the quota denies', async () => {
    const id = `${run}-slot`;
    await store.admit(request(id, { quotaLimit: 0, maxConcurrent: 1 }));
    expect(await store.admit(request(id, { maxConcurrent: 1 }))).toMatchObject({ allowed: true });
  });

  it('consumes atomically under concurrency', async () => {
    const key = `gen:${run}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => store.consume(key, 1, 5, expires())));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(await store.get(key)).toBe(5);
    expect(await store.add(key, -1, expires())).toBe(4);
    // Contended transactions retry with backoff: this is the single-document write limit at work.
  }, 60_000);

  it('treats expired counters as zero', async () => {
    const key = `spend:${run}`;
    await store.add(key, 7, new Date(Date.now() - 1000));
    expect(await store.get(key)).toBe(0);
    expect(await store.add(key, 3, expires())).toBe(3);
  });
});
