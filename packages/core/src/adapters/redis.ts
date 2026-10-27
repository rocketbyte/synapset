import { Redis } from 'ioredis';
import { TransientError } from '../errors.js';
import type { AdmitDecision, AdmitRequest, LimitStore } from '../ports.js';

const REASONS = { 1: 'rate', 2: 'concurrency', 3: 'quota' } as const;

/*
 * All scripts read Redis server time so every instance shares one clock.
 * ADMIT: GCRA token bucket, then a sorted-set concurrency semaphore, then a period quota;
 * mutations happen only after every check passes.
 * Returns {allowed, reason, retryAfterMs, remaining, resetMs, used}.
 */
const ADMIT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local emission = tonumber(ARGV[1])
local tolerance = emission * tonumber(ARGV[2])
local tat = tonumber(redis.call('GET', KEYS[1])) or now
if tat < now then tat = now end
local newTat = tat + emission
local diff = newTat - now
if diff > tolerance then
  return {0, 1, math.ceil(diff - tolerance), 0, math.ceil(tat - now), 0}
end
local remaining = math.floor((tolerance - diff) / emission)
local concTtl = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - concTtl)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then
  return {0, 2, 1000, remaining, math.ceil(diff), 0}
end
local used = tonumber(redis.call('GET', KEYS[3])) or 0
if used + 1 > tonumber(ARGV[6]) then
  return {0, 3, tonumber(ARGV[7]) - now, remaining, math.ceil(diff), used}
end
redis.call('SET', KEYS[1], newTat, 'PX', math.ceil(diff))
redis.call('ZADD', KEYS[2], now, ARGV[4])
redis.call('PEXPIRE', KEYS[2], concTtl)
used = redis.call('INCR', KEYS[3])
redis.call('PEXPIREAT', KEYS[3], ARGV[7])
return {1, 0, 0, remaining, math.ceil(diff), used}
`;

const CONSUME = `
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local amount = tonumber(ARGV[1])
if used + amount > tonumber(ARGV[2]) then return {0, used} end
used = redis.call('INCRBY', KEYS[1], amount)
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
return {1, used}
`;

const ADD = `
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return value
`;

const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export function createRedis(url: string, caCert?: string): Redis {
  return new Redis(url, {
    ...(caCert ? { tls: { ca: caCert } } : {}),
    // Connects (and reconnects) eagerly. Commands fail fast while disconnected instead of queueing:
    // callers decide whether to fail open or closed.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 500,
  });
}

export class RedisLimitStore implements LimitStore {
  constructor(private readonly redis: Redis) {}

  /** Redis failures surface as TransientError so callers can choose to fail open or closed. */
  private async run<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error) {
      throw new TransientError('Limit store unavailable', { cause: error });
    }
  }

  private eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.run(() => this.redis.eval(script, numKeys, ...args));
  }

  async admit(request: AdmitRequest): Promise<AdmitDecision> {
    const [allowed, reason, retryAfterMs, remaining, resetMs, used] = (await this.eval(
      ADMIT,
      3,
      request.rateKey,
      request.concurrencyKey,
      request.quotaKey,
      60_000 / request.requestsPerMinute,
      request.burst,
      request.maxConcurrent,
      request.token,
      request.concurrencyTtlMs,
      request.quotaLimit,
      request.quotaExpiresAt.getTime(),
    )) as number[];
    if (allowed === 1) {
      return { allowed: true, remaining: remaining ?? 0, resetMs: resetMs ?? 0, quotaUsed: used ?? 0 };
    }
    return {
      allowed: false,
      reason: REASONS[reason as 1 | 2 | 3],
      retryAfterMs: retryAfterMs ?? 1000,
      remaining: remaining ?? 0,
      resetMs: resetMs ?? 0,
    };
  }

  async release(concurrencyKey: string, token: string): Promise<void> {
    await this.run(() => this.redis.zrem(concurrencyKey, token));
  }

  async consume(key: string, amount: number, limit: number, expiresAt: Date) {
    const [allowed, used] = (await this.eval(
      CONSUME,
      1,
      key,
      amount,
      limit,
      expiresAt.getTime(),
    )) as number[];
    return { allowed: allowed === 1, used: used ?? 0 };
  }

  async add(key: string, amount: number, expiresAt: Date): Promise<number> {
    return (await this.eval(ADD, 1, key, amount, expiresAt.getTime())) as number;
  }

  async get(key: string): Promise<number> {
    return Number((await this.run(() => this.redis.get(key))) ?? 0);
  }

  async hit(key: string, windowMs: number): Promise<number> {
    return (await this.eval(HIT, 1, key, windowMs)) as number;
  }
}
