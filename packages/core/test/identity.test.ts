import { describe, expect, it } from 'vitest';
import { Authenticator, generateApiKey, parseBearerKey, type ApiKeyRecord } from '@synapset/core';
import { InMemoryIdentityRepository } from './fakes.js';

const NOW = new Date('2026-10-26T12:00:00Z');

function seed(overrides: Partial<ApiKeyRecord> = {}, accountStatus: 'active' | 'suspended' = 'active') {
  const repo = new InMemoryIdentityRepository();
  const { key, keyId, hash } = generateApiKey();
  repo.accounts.set('acct_1', {
    id: 'acct_1',
    name: 'Acme',
    plan: 'pro',
    status: accountStatus,
    limitOverrides: { generationsPerDay: 5 },
    createdAt: NOW,
  });
  repo.keys.set(hash, {
    keyId,
    hash,
    accountId: 'acct_1',
    name: 'ci',
    scopes: ['assessments:read'],
    status: 'active',
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });
  return { repo, key, keyId };
}

describe('API keys', () => {
  it('generates prefixed keys that parse only from a Bearer header', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^synapset_sk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseBearerKey(`Bearer ${key}`)).toBe(key);
    expect(parseBearerKey(key)).toBeNull();
    expect(parseBearerKey(`Basic ${key}`)).toBeNull();
    expect(parseBearerKey('Bearer synapset_sk_short')).toBeNull();
    expect(parseBearerKey(undefined)).toBeNull();
  });
});

describe('Authenticator', () => {
  it('resolves an active key to its principal with plan limits and overrides', async () => {
    const { repo, key, keyId } = seed();
    const principal = await new Authenticator(repo, () => NOW).authenticate(key);

    expect(principal).toMatchObject({ accountId: 'acct_1', keyId, plan: 'pro' });
    expect(principal?.limits.generationsPerDay).toBe(5);
    expect(principal?.limits.requestsPerMinute).toBe(300);
    expect(principal?.scopes.has('assessments:read')).toBe(true);
    expect(principal?.scopes.has('assessments:write')).toBe(false);
  });

  it('rejects unknown, revoked and expired keys and suspended accounts', async () => {
    const auth = (s: ReturnType<typeof seed>) => new Authenticator(s.repo, () => NOW).authenticate(s.key);
    expect(await new Authenticator(seed().repo).authenticate(generateApiKey().key)).toBeNull();
    expect(await auth(seed({ status: 'revoked' }))).toBeNull();
    expect(await auth(seed({ expiresAt: new Date('2026-10-26T11:59:59Z') }))).toBeNull();
    expect(await auth(seed({}, 'suspended'))).toBeNull();
  });

  it('caches lookups, including misses', async () => {
    const { repo, key } = seed();
    const authenticator = new Authenticator(repo, () => NOW);
    const unknown = generateApiKey().key;
    for (let i = 0; i < 3; i++) {
      await authenticator.authenticate(key);
      await authenticator.authenticate(unknown);
    }
    expect(repo.reads).toBe(2);
  });
});
