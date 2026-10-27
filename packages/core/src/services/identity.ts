import { LRUCache } from 'lru-cache';
import { hashApiKey, type Principal } from '../auth.js';
import { limitsFor } from '../billing.js';
import type { Clock, IdentityRepository } from '../ports.js';

/** Revocations, suspensions and plan changes take effect within this window. */
const CACHE_TTL_MS = 30_000;

type CacheEntry = { principal: Principal; keyExpiresAt: Date | null } | { principal: null };

export class Authenticator {
  private readonly cache = new LRUCache<string, CacheEntry>({ max: 10_000, ttl: CACHE_TTL_MS });

  constructor(
    private readonly identities: IdentityRepository,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolves a presented API key to its principal, or null when the key is unknown, revoked or expired. */
  async authenticate(key: string): Promise<Principal | null> {
    const hash = hashApiKey(key);
    let entry = this.cache.get(hash);
    if (!entry) {
      entry = await this.load(hash);
      this.cache.set(hash, entry);
    }
    if (!entry.principal) return null;
    if (entry.keyExpiresAt && entry.keyExpiresAt <= this.clock()) return null;
    return entry.principal;
  }

  private async load(hash: string): Promise<CacheEntry> {
    const key = await this.identities.findKeyByHash(hash);
    if (key?.status !== 'active') return { principal: null };
    const account = await this.identities.getAccount(key.accountId);
    if (account?.status !== 'active') return { principal: null };
    return {
      keyExpiresAt: key.expiresAt,
      principal: {
        accountId: account.id,
        keyId: key.keyId,
        plan: account.plan,
        limits: limitsFor(account.plan, account.limitOverrides),
        scopes: new Set(key.scopes),
      },
    };
  }
}
