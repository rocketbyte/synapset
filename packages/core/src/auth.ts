import { createHash, randomBytes } from 'node:crypto';
import type { PlanLimits, PlanName } from './billing.js';

export const SCOPES = ['assessments:read', 'assessments:write', 'assessments:grade'] as const;
export type Scope = (typeof SCOPES)[number];

/** A fixed prefix lets secret scanners (GitHub, GitLab) detect leaked keys. */
export const API_KEY_PREFIX = 'synapset_sk_';
const KEY_PATTERN = /^synapset_sk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

export interface Account {
  id: string;
  name: string;
  plan: PlanName;
  status: 'active' | 'suspended';
  limitOverrides: Partial<PlanLimits>;
  createdAt: Date;
}

export interface ApiKeyRecord {
  /** Public identifier, safe to log and show in dashboards. */
  keyId: string;
  /** SHA-256 of the full key; the key itself is never stored. */
  hash: string;
  accountId: string;
  name: string;
  scopes: Scope[];
  status: 'active' | 'revoked';
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface Principal {
  accountId: string;
  keyId: string;
  plan: PlanName;
  limits: PlanLimits;
  scopes: ReadonlySet<Scope>;
}

/**
 * 256 bits of randomness make offline guessing infeasible, so a fast hash (not a password KDF) is the
 * correct storage primitive here.
 */
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function generateApiKey(): { key: string; keyId: string; hash: string } {
  const keyId = randomBytes(6).toString('hex');
  const key = `${API_KEY_PREFIX}${keyId}_${randomBytes(32).toString('base64url')}`;
  return { key, keyId, hash: hashApiKey(key) };
}

/** Returns the key from `Authorization: Bearer <key>` when it is well-formed, otherwise null. */
export function parseBearerKey(header: string | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  const key = match?.[1];
  return key && KEY_PATTERN.test(key) ? key : null;
}
