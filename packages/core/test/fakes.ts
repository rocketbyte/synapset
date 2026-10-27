import {
  EMBEDDING_DIMENSIONS,
  LEVELS,
  SCOPES,
  createLogger,
  limitsFor,
  type Account,
  type ApiKeyRecord,
  type Assessment,
  type IdentityRepository,
  type PlanLimits,
  type Principal,
  type AssessmentRepository,
  type Embedder,
  type GenerateMessage,
  type GenerationResult,
  type Job,
  type JobQueue,
  type LeaseResult,
  type LlmProvider,
  type NearestMatch,
  type NewJob,
  type Question,
} from '@synapset/core';

export const silentLogger = createLogger('test', 'silent');

export function questions(perLevel: number): Question[] {
  return LEVELS.flatMap((d) =>
    Array.from({ length: perLevel }, (_, i) => ({
      q: `Level ${d} question ${i}?`,
      o: ['alpha', 'beta', 'gamma', 'delta'],
      a: i % 4,
      e: 'Because.',
      d,
    })),
  );
}

export function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    id: 'a'.repeat(64),
    topic: 'TypeScript generics',
    topicNormalized: 'typescript generics',
    locale: 'en',
    scope: 'scope',
    questions: questions(1),
    llmProvider: 'anthropic',
    model: 'claude-haiku-5-5',
    promptVersion: 'v',
    embeddingModel: 'fake-embedding',
    usage: { inputTokens: 1, outputTokens: 1 },
    createdAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedding';
  calls = 0;
  embed(): Promise<number[]> {
    this.calls++;
    return Promise.resolve(Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)));
  }
}

export class FakeQueue implements JobQueue {
  published: GenerateMessage[] = [];
  failNext = false;
  publish(message: GenerateMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('publish failed'));
    }
    this.published.push(message);
    return Promise.resolve();
  }
}

export class FakeLlm implements LlmProvider {
  readonly name = 'anthropic';
  calls = 0;
  constructor(private readonly behaviour: () => Promise<GenerationResult>) {}
  generate(): Promise<GenerationResult> {
    this.calls++;
    return this.behaviour();
  }
}

export class InMemoryRepository implements AssessmentRepository {
  assessments = new Map<string, Assessment>();
  embeddings = new Map<string, number[]>();
  aliases = new Map<string, string>();
  jobs = new Map<string, Job>();
  nearest: NearestMatch[] = [];

  getAssessment(id: string) {
    return Promise.resolve(this.assessments.get(id) ?? null);
  }
  findNearest(_embedding: number[], scope: string, maxDistance: number) {
    return Promise.resolve(
      this.nearest.filter((m) => m.assessment.scope === scope && m.distance <= maxDistance),
    );
  }
  getAlias(key: string) {
    return Promise.resolve(this.aliases.get(key) ?? null);
  }
  saveAlias(key: string, assessmentId: string) {
    this.aliases.set(key, assessmentId);
    return Promise.resolve();
  }
  saveAssessment(value: Assessment, embedding: number[]) {
    this.assessments.set(value.id, value);
    this.embeddings.set(value.id, embedding);
    return Promise.resolve();
  }
  getJob(id: string) {
    return Promise.resolve(this.jobs.get(id) ?? null);
  }
  claimJob(job: NewJob, now: Date, staleAfterMs: number) {
    const existing = this.jobs.get(job.id);
    const inFlight =
      existing &&
      (existing.status === 'pending' || existing.status === 'running') &&
      now.getTime() - existing.updatedAt.getTime() < staleAfterMs;
    if (existing && inFlight) return Promise.resolve({ job: existing, claimed: false });
    const fresh: Job = {
      ...job,
      status: 'pending',
      attempts: 0,
      leaseUntil: null,
      assessmentId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
    this.jobs.set(job.id, fresh);
    return Promise.resolve({ job: fresh, claimed: true });
  }
  acquireLease(id: string, now: Date, leaseMs: number): Promise<LeaseResult> {
    const job = this.jobs.get(id);
    if (!job || job.status === 'failed') return Promise.resolve({ kind: 'missing' });
    if (job.status === 'done') return Promise.resolve({ kind: 'done' });
    if (job.status === 'running' && job.leaseUntil && job.leaseUntil > now)
      return Promise.resolve({ kind: 'busy' });
    const leased: Job = {
      ...job,
      status: 'running',
      attempts: job.attempts + 1,
      leaseUntil: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    };
    this.jobs.set(id, leased);
    return Promise.resolve({ kind: 'acquired', job: leased });
  }
  private patch(id: string, fields: Partial<Job>) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    this.jobs.set(id, { ...job, ...fields });
    return Promise.resolve();
  }
  completeJob(id: string, assessmentId: string, now: Date) {
    return this.patch(id, { status: 'done', assessmentId, leaseUntil: null, error: null, updatedAt: now });
  }
  releaseJob(id: string, error: string, now: Date) {
    return this.patch(id, { status: 'pending', leaseUntil: null, error, updatedAt: now });
  }
  failJob(id: string, error: string, now: Date) {
    return this.patch(id, { status: 'failed', leaseUntil: null, error, updatedAt: now });
  }
}

export function principal(limits: Partial<PlanLimits> = {}, accountId = 'acct_1'): Principal {
  return {
    accountId,
    keyId: 'key_1',
    plan: 'free',
    limits: limitsFor('free', limits),
    scopes: new Set(SCOPES),
  };
}

export class InMemoryIdentityRepository implements IdentityRepository {
  keys = new Map<string, ApiKeyRecord>();
  accounts = new Map<string, Account>();
  reads = 0;

  findKeyByHash(hash: string) {
    this.reads++;
    return Promise.resolve(this.keys.get(hash) ?? null);
  }
  findKeyById(keyId: string) {
    return Promise.resolve([...this.keys.values()].find((k) => k.keyId === keyId) ?? null);
  }
  listKeys(accountId: string) {
    return Promise.resolve([...this.keys.values()].filter((k) => k.accountId === accountId));
  }
  saveKey(record: ApiKeyRecord) {
    this.keys.set(record.hash, record);
    return Promise.resolve();
  }
  revokeKey(keyId: string, now: Date) {
    const key = [...this.keys.values()].find((k) => k.keyId === keyId);
    if (!key) return Promise.resolve(false);
    this.keys.set(key.hash, { ...key, status: 'revoked', revokedAt: now });
    return Promise.resolve(true);
  }
  getAccount(id: string) {
    return Promise.resolve(this.accounts.get(id) ?? null);
  }
  saveAccount(account: Account) {
    this.accounts.set(account.id, account);
    return Promise.resolve();
  }
}
