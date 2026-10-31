import { createHash } from 'node:crypto';
import {
  EMBEDDING_DIMENSIONS,
  LEVELS,
  SCOPES,
  createLogger,
  limitsFor,
  withQuestions,
  type Account,
  type ApiKeyRecord,
  type Assessment,
  type BankQuestion,
  type PromptInput,
  type QuestionMatch,
  type QuestionReport,
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
  type VerificationResult,
  type VerifyInput,
  type NearestMatch,
  type NewJob,
  type PoolCapRule,
  type QuestionPool,
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
    context: null,
    style: null,
    locale: 'en',
    scope: 'scope',
    questions: questions(1),
    llmProvider: 'anthropic',
    model: 'claude-haiku-5-5',
    promptVersion: 'v',
    embeddingModel: 'fake-embedding',
    usage: { inputTokens: 1, outputTokens: 1 },
    reusedQuestions: 0,
    questionIds: [],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

/** A unit vector along `axis`, or a mix of axes: cosine between two such vectors is their dot product. */
export function axisVector(weights: Record<number, number>): number[] {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => weights[i] ?? 0);
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
}

/**
 * Unrelated texts get near-orthogonal vectors (seeded by the text), as real embeddings of unrelated
 * text do. Tests pin specific texts to chosen vectors with `vectors`.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedding';
  calls = 0;
  texts: string[] = [];
  vectors = new Map<string, number[]>();

  embed(text: string): Promise<number[]> {
    this.calls++;
    this.texts.push(text);
    const pinned = this.vectors.get(text);
    if (pinned) return Promise.resolve(pinned);
    let seed = createHash('sha256').update(text).digest().readUInt32BE(0);
    const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 2 ** 32 - 0.5;
    });
    const norm = Math.hypot(...values);
    return Promise.resolve(values.map((v) => v / norm));
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

/** By default the checker agrees with every answer key it is shown. */
export class FakeLlm implements LlmProvider {
  readonly name = 'anthropic';
  calls = 0;
  verifyCalls = 0;
  requests: PromptInput[] = [];
  private generated: Question[] = [];

  constructor(
    private readonly behaviour: () => Promise<GenerationResult>,
    private readonly dispute: (question: Question) => boolean = () => false,
  ) {}

  async generate(input: PromptInput): Promise<GenerationResult> {
    this.calls++;
    this.requests.push(input);
    const result = await this.behaviour();
    this.generated = result.questions;
    return result;
  }

  verify(input: VerifyInput): Promise<VerificationResult> {
    this.verifyCalls++;
    const verdicts = input.questions.map(({ q }, i) => {
      const question = this.generated.find((candidate) => candidate.q === q) as Question;
      return { i, a: question.a, ok: !this.dispute(question) };
    });
    return Promise.resolve({
      verdicts,
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 100, outputTokens: 100 },
    });
  }
}

export class InMemoryRepository implements AssessmentRepository {
  assessments = new Map<string, Assessment>();
  embeddings = new Map<string, number[]>();
  aliases = new Map<string, string>();
  jobs = new Map<string, Job>();
  nearest: NearestMatch[] = [];
  bank = new Map<string, BankQuestion>();

  getAssessment(id: string) {
    return Promise.resolve(this.assessments.get(id) ?? null);
  }
  findNearest(_embedding: number[], scope: string, maxDistance: number) {
    return Promise.resolve(
      this.nearest.filter((m) => m.assessment.scope === scope && m.distance <= maxDistance),
    );
  }
  findNearestQuestions(
    embedding: number[],
    scope: string,
    level: number,
    maxDistance: number,
    limit: number,
  ) {
    const matches: QuestionMatch[] = [...this.bank.values()]
      .filter((q) => q.scope === scope && q.d === level)
      .map((question) => ({
        question,
        distance: 1 - question.embedding.reduce((sum, v, i) => sum + v * (embedding[i] ?? 0), 0),
      }))
      .filter((m) => m.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
    return Promise.resolve(matches.slice(0, limit));
  }
  getQuestions(ids: readonly string[]) {
    return Promise.resolve(ids.flatMap((id) => this.bank.get(id) ?? []));
  }
  saveQuestions(questions: readonly BankQuestion[]) {
    for (const question of questions) {
      const existing = this.bank.get(question.id);
      this.bank.set(question.id, {
        ...question,
        status: existing?.status ?? 'active',
        reports: existing?.reports ?? 0,
      });
    }
    return Promise.resolve();
  }
  reports = new Map<string, QuestionReport>();
  recordReport(report: QuestionReport) {
    if (this.reports.has(report.id)) return Promise.resolve(false);
    this.reports.set(report.id, report);
    return Promise.resolve(true);
  }
  countReports(questionId: string) {
    return Promise.resolve(
      [...this.reports.values()].filter((r) => r.questionId === questionId && !r.dismissed).length,
    );
  }
  dismissReports(questionId: string) {
    const open = [...this.reports.values()].filter((r) => r.questionId === questionId && !r.dismissed);
    for (const report of open) this.reports.set(report.id, { ...report, dismissed: true });
    return Promise.resolve(open.length);
  }
  markQuestion(
    question: Pick<BankQuestion, 'id' | 'scope' | 'q' | 'o' | 'a' | 'e' | 'd'>,
    update: { status: BankQuestion['status']; reports: number; expiresAt: Date },
  ) {
    const existing = this.bank.get(question.id);
    this.bank.set(question.id, {
      embedding: [],
      sourceAssessmentId: '',
      createdAt: update.expiresAt,
      ...existing,
      ...question,
      ...update,
    });
    return Promise.resolve();
  }
  expireAssessmentsWith(questionId: string, now: Date) {
    let count = 0;
    for (const [id, a] of this.assessments) {
      if (a.questionIds.includes(questionId)) {
        this.assessments.set(id, { ...a, expiresAt: now });
        count++;
      }
    }
    return Promise.resolve(count);
  }
  expireAssessment(id: string, now: Date) {
    const a = this.assessments.get(id);
    if (a) this.assessments.set(id, { ...a, expiresAt: now });
    return Promise.resolve();
  }
  listReports(limit: number) {
    return Promise.resolve([...this.reports.values()].slice(-limit).reverse());
  }
  getAlias(key: string) {
    return Promise.resolve(this.aliases.get(key) ?? null);
  }
  saveAlias(key: string, assessmentId: string) {
    this.aliases.set(key, assessmentId);
    return Promise.resolve();
  }
  saveAssessment(value: Assessment, embedding: number[] | null) {
    this.assessments.set(value.id, value);
    if (embedding) this.embeddings.set(value.id, embedding);
    return Promise.resolve();
  }
  pools = new Map<string, QuestionPool>();
  capRules: PoolCapRule[] = [];
  getPool(id: string) {
    return Promise.resolve(this.pools.get(id) ?? null);
  }
  createPool(pool: QuestionPool) {
    const stored = this.pools.get(pool.id) ?? pool;
    this.pools.set(pool.id, stored);
    return Promise.resolve(stored);
  }
  appendToPool(
    id: string,
    added: Parameters<AssessmentRepository['appendToPool']>[1],
    saturatedUntil: QuestionPool['saturatedUntil'],
    now: Date,
  ) {
    const updated = withQuestions(this.pools.get(id) as QuestionPool, added, saturatedUntil, now);
    this.pools.set(id, updated);
    return Promise.resolve(updated);
  }
  getPoolCapRules() {
    return Promise.resolve(this.capRules);
  }
  savePoolCapRules(rules: readonly PoolCapRule[]) {
    this.capRules = [...rules];
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

/** A bank question whose embedding is `embedding`; its text is unique per (level, label). */
export function bankQuestion(
  scope: string,
  d: number,
  label: string,
  embedding: number[],
  expiresAt = new Date('2027-01-01T00:00:00Z'),
): BankQuestion {
  return {
    id: `${scope}-${d}-${label}`,
    q: `Bank ${label} at level ${d}?`,
    o: ['alpha', 'beta', 'gamma', 'delta'],
    a: 1,
    e: 'Because.',
    d,
    scope,
    embedding,
    sourceAssessmentId: 'src',
    status: 'active',
    reports: 0,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt,
  };
}
