import { Timestamp, type DocumentData, type DocumentSnapshot, type Firestore } from '@google-cloud/firestore';
import type { Account, ApiKeyRecord } from '../auth.js';
import type { IdentityRepository } from '../ports.js';

const toDate = (value: unknown) => (value as Timestamp).toDate();
const toDateOrNull = (value: unknown) => (value ? toDate(value) : null);

function toKey(snapshot: DocumentSnapshot): ApiKeyRecord {
  const d = snapshot.data() as DocumentData;
  return {
    keyId: d.keyId as string,
    hash: snapshot.id,
    accountId: d.accountId as string,
    name: d.name as string,
    scopes: d.scopes as ApiKeyRecord['scopes'],
    status: d.status as ApiKeyRecord['status'],
    createdAt: toDate(d.createdAt),
    expiresAt: toDateOrNull(d.expiresAt),
    revokedAt: toDateOrNull(d.revokedAt),
  };
}

function toAccount(snapshot: DocumentSnapshot): Account {
  const d = snapshot.data() as DocumentData;
  return {
    id: snapshot.id,
    name: d.name as string,
    plan: d.plan as Account['plan'],
    status: d.status as Account['status'],
    limitOverrides: (d.limitOverrides as Account['limitOverrides'] | undefined) ?? {},
    createdAt: toDate(d.createdAt),
  };
}

/** API keys are stored under their SHA-256 hash, so authentication is a single document read. */
export class FirestoreIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Firestore) {}

  private get keys() {
    return this.db.collection('api_keys');
  }

  private get accounts() {
    return this.db.collection('accounts');
  }

  async findKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const snapshot = await this.keys.doc(hash).get();
    return snapshot.exists ? toKey(snapshot) : null;
  }

  async findKeyById(keyId: string): Promise<ApiKeyRecord | null> {
    const result = await this.keys.where('keyId', '==', keyId).limit(1).get();
    const doc = result.docs[0];
    return doc ? toKey(doc) : null;
  }

  async listKeys(accountId: string): Promise<ApiKeyRecord[]> {
    const result = await this.keys.where('accountId', '==', accountId).get();
    return result.docs.map(toKey);
  }

  async saveKey(record: ApiKeyRecord): Promise<void> {
    const { hash, createdAt, expiresAt, revokedAt, ...fields } = record;
    await this.keys.doc(hash).create({
      ...fields,
      createdAt: Timestamp.fromDate(createdAt),
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      revokedAt: revokedAt ? Timestamp.fromDate(revokedAt) : null,
    });
  }

  async revokeKey(keyId: string, now: Date): Promise<boolean> {
    const key = await this.findKeyById(keyId);
    if (!key) return false;
    await this.keys.doc(key.hash).update({ status: 'revoked', revokedAt: Timestamp.fromDate(now) });
    return true;
  }

  async getAccount(id: string): Promise<Account | null> {
    const snapshot = await this.accounts.doc(id).get();
    return snapshot.exists ? toAccount(snapshot) : null;
  }

  async saveAccount(account: Account): Promise<void> {
    const { id, createdAt, ...fields } = account;
    await this.accounts.doc(id).set({ ...fields, createdAt: Timestamp.fromDate(createdAt) });
  }
}
