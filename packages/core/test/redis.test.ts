import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisLimitStore, createRedis, type AdmitRequest } from '@synapset/core';

const url = process.env.REDIS_URL;

// Exercises the Lua scripts against a real Redis. CI runs it with a Redis service container.
describe.skipIf(!url)('RedisLimitStore', () => {
  const redis = createRedis(url ?? 'redis://localhost:6379');
  const store = new RedisLimitStore(redis);
  const prefix = `test:${process.pid}:${Date.now()}`;
  let n = 0;
  let keys: { rateKey: string; concurrencyKey: string; quotaKey: string };

  const request = (overrides: Partial<AdmitRequest> = {}): AdmitRequest => ({
    ...keys,
    requestsPerMinute: 60,
    burst: 3,
    maxConcurrent: 10,
    token: `t${++n}`,
    concurrencyTtlMs: 60_000,
    quotaLimit: 100,
    quotaExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  beforeEach(async () => {
    if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
    const id = `${prefix}:${++n}`;
    keys = { rateKey: `${id}:rl`, concurrencyKey: `${id}:cc`, quotaKey: `${id}:rq` };
  });

  afterAll(async () => {
    const leftovers = await redis.keys(`${prefix}:*`);
    if (leftovers.length) await redis.del(...leftovers);
    await redis.quit();
  });

  it('allows the burst, then throttles', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.admit(request()));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ reason: 'rate' });
    expect(results[0]).toMatchObject({ quotaUsed: 1 });
  });

  it('enforces and releases concurrency slots', async () => {
    const limits = { maxConcurrent: 1, burst: 100, requestsPerMinute: 6000 };
    expect((await store.admit(request({ ...limits, token: 'a' }))).allowed).toBe(true);
    expect(await store.admit(request({ ...limits, token: 'b' }))).toMatchObject({ reason: 'concurrency' });
    await store.release(keys.concurrencyKey, 'a');
    expect((await store.admit(request({ ...limits, token: 'c' }))).allowed).toBe(true);
  });

  it('enforces the quota without consuming it on denial', async () => {
    expect((await store.admit(request({ quotaLimit: 1 }))).allowed).toBe(true);
    expect(await store.admit(request({ quotaLimit: 1 }))).toMatchObject({ reason: 'quota' });
    expect(await store.get(keys.quotaKey)).toBe(1);
  });

  it('consumes within a limit, refunds and counts hits', async () => {
    const expires = new Date(Date.now() + 60_000);
    const key = `${keys.quotaKey}:gen`;
    expect(await store.consume(key, 1, 2, expires)).toEqual({ allowed: true, used: 1 });
    expect(await store.consume(key, 1, 2, expires)).toEqual({ allowed: true, used: 2 });
    expect(await store.consume(key, 1, 2, expires)).toEqual({ allowed: false, used: 2 });
    expect(await store.add(key, -1, expires)).toBe(1);
    expect(await store.hit(`${key}:af`, 60_000)).toBe(1);
    expect(await store.hit(`${key}:af`, 60_000)).toBe(2);
  });
});
