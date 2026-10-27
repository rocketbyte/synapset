#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  FirestoreIdentityRepository,
  PLAN_NAMES,
  SCOPES,
  createFirestore,
  generateApiKey,
  loadConfig,
  type PlanName,
  type Scope,
} from '@synapset/core';

const USAGE = `Usage: pnpm admin <command> [options]

  account create  --name <name> [--plan free|pro|enterprise]
  account plan    --account <id> --plan <plan>
  account suspend --account <id>
  account resume  --account <id>
  key create      --account <id> --name <name> [--scopes a,b] [--expires-days <n>]
  key list        --account <id>
  key revoke      --key <keyId>

Scopes: ${SCOPES.join(', ')} (default: all)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    plan: { type: 'string' },
    account: { type: 'string' },
    key: { type: 'string' },
    scopes: { type: 'string' },
    'expires-days': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== 'string' || !value) fail(`Missing --${name}`);
  return value;
}

function plan(): PlanName {
  const value = values.plan ?? 'free';
  if (!(PLAN_NAMES as readonly string[]).includes(value)) fail(`Unknown plan "${value}"`);
  return value as PlanName;
}

function scopes(): Scope[] {
  if (!values.scopes) return [...SCOPES];
  const list = values.scopes.split(',').map((s) => s.trim());
  const unknown = list.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) fail(`Unknown scopes: ${unknown.join(', ')}`);
  return list as Scope[];
}

const firestore = createFirestore(loadConfig());
const identities = new FirestoreIdentityRepository(firestore);
const now = new Date();

async function account(id: string) {
  const found = await identities.getAccount(id);
  if (!found) fail(`Account ${id} not found`);
  return found;
}

async function run(command: string) {
  switch (command) {
    case 'account create': {
      const id = `acct_${randomBytes(8).toString('hex')}`;
      await identities.saveAccount({
        id,
        name: required('name'),
        plan: plan(),
        status: 'active',
        limitOverrides: {},
        createdAt: now,
      });
      console.log(id);
      return;
    }
    case 'account plan':
      await identities.saveAccount({ ...(await account(required('account'))), plan: plan() });
      return;
    case 'account suspend':
    case 'account resume':
      await identities.saveAccount({
        ...(await account(required('account'))),
        status: command === 'account suspend' ? 'suspended' : 'active',
      });
      return;
    case 'key create': {
      const owner = await account(required('account'));
      const days = values['expires-days'] ? Number(values['expires-days']) : null;
      if (days !== null && !(Number.isInteger(days) && days > 0))
        fail('--expires-days must be a positive integer');
      const { key, keyId, hash } = generateApiKey();
      await identities.saveKey({
        keyId,
        hash,
        accountId: owner.id,
        name: required('name'),
        scopes: scopes(),
        status: 'active',
        createdAt: now,
        expiresAt: days ? new Date(now.getTime() + days * 86_400_000) : null,
        revokedAt: null,
      });
      console.error(`Created key ${keyId}. It is shown once and cannot be recovered:`);
      console.log(key);
      return;
    }
    case 'key list':
      console.table(
        (await identities.listKeys(required('account'))).map(({ hash: _hash, ...key }) => ({
          ...key,
          scopes: key.scopes.join(','),
        })),
      );
      return;
    case 'key revoke':
      if (!(await identities.revokeKey(required('key'), now))) fail('Key not found');
      console.error('Revoked. Running instances stop accepting it within 30 seconds.');
      return;
    default:
      fail(command ? `Unknown command "${command}"` : 'Missing command');
  }
}

try {
  await run(positionals.slice(0, 2).join(' '));
} finally {
  await firestore.terminate();
}
