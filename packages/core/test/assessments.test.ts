import { beforeEach, describe, expect, it } from 'vitest';
import {
  AssessmentService,
  BudgetExhaustedError,
  MemoryLimitStore,
  PROMPT_VERSION,
  QuotaExceededError,
  SpendGuard,
  counterKeys,
  toMicroUsd,
  cacheKey,
  normalizeTopic,
  scopeKey,
  type Assessment,
  type GenerationScope,
} from '@synapset/core';
import { FakeEmbedder, FakeQueue, InMemoryRepository, assessment, principal, questions } from './fakes.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const SCOPE: GenerationScope = {
  locale: 'en',
  questionsPerLevel: 1,
  promptVersion: PROMPT_VERSION,
  embeddingModel: 'fake-embedding',
};
const keyFor = (topic: string) => cacheKey(normalizeTopic(topic), SCOPE);

describe('AssessmentService.resolve', () => {
  let repo: InMemoryRepository;
  let embedder: FakeEmbedder;
  let queue: FakeQueue;
  let cache: Map<string, Assessment>;
  let store: MemoryLimitStore;
  let service: AssessmentService;
  const caller = principal({ generationsPerDay: 2 });

  beforeEach(() => {
    repo = new InMemoryRepository();
    embedder = new FakeEmbedder();
    queue = new FakeQueue();
    cache = new Map();
    store = new MemoryLimitStore(() => NOW);
    service = new AssessmentService(
      repo,
      embedder,
      queue,
      new SpendGuard(store, 5, () => NOW),
      {
        questionsPerLevel: 1,
        similarityThreshold: 0.88,
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 7200,
        jobStaleSeconds: 900,
      },
      cache,
      () => NOW,
    );
  });

  it('serves an exact hit without embedding or enqueueing', async () => {
    const key = keyFor('Rust ownership');
    repo.assessments.set(key, assessment({ id: key }));

    const result = await service.resolve({ topic: '  RUST ownership', locale: 'en' }, caller);

    expect(result).toMatchObject({ status: 'ready', match: 'exact' });
    expect(embedder.calls).toBe(0);
    expect(queue.published).toHaveLength(0);
    expect(cache.get(key)?.id).toBe(key);
  });

  it('serves a semantic hit and records an alias so the next request is exact', async () => {
    const match = assessment({ id: 'b'.repeat(64), scope: scopeKey(SCOPE) });
    repo.nearest = [{ assessment: match, distance: 0.05 }];

    const result = await service.resolve({ topic: 'Ownership in Rust', locale: 'en' }, caller);

    expect(result).toMatchObject({ status: 'ready', match: 'semantic' });
    expect(repo.aliases.get(keyFor('Ownership in Rust'))).toBe(match.id);
  });

  it('ignores matches beyond the similarity threshold or past expiry', async () => {
    repo.nearest = [
      { assessment: assessment({ scope: scopeKey(SCOPE) }), distance: 0.2 },
      {
        assessment: assessment({ scope: scopeKey(SCOPE), expiresAt: new Date('2026-10-01') }),
        distance: 0.01,
      },
    ];

    const result = await service.resolve({ topic: 'Rust ownership', locale: 'en' }, caller);

    expect(result.status).toBe('pending');
  });

  it('enqueues a miss once, reusing the embedding, and caps the requested TTL', async () => {
    const first = await service.resolve(
      { topic: 'Rust ownership', locale: 'en', ttlSeconds: 999_999 },
      caller,
    );
    const second = await service.resolve({ topic: 'rust ownership', locale: 'en' }, caller);

    expect(first.status).toBe('pending');
    expect(second.status).toBe('pending');
    expect(queue.published).toHaveLength(1);
    expect(queue.published[0]).toMatchObject({
      jobId: keyFor('Rust ownership'),
      accountId: caller.accountId,
      ttlSeconds: 7200,
    });
    // Only the caller that triggered generation is charged.
    expect(await store.get(counterKeys.dailyGenerations(caller.accountId, NOW))).toBe(1);
    expect(queue.published[0]?.embedding).toHaveLength(768);
  });

  it('regenerates once the cached assessment has expired', async () => {
    const key = keyFor('Rust ownership');
    repo.assessments.set(key, assessment({ id: key, expiresAt: new Date('2026-10-20') }));
    repo.jobs.set(key, {
      id: key,
      status: 'done',
      topic: 'Rust ownership',
      locale: 'en',
      attempts: 1,
      leaseUntil: null,
      assessmentId: key,
      error: null,
      createdAt: new Date('2026-09-20'),
      updatedAt: new Date('2026-09-20'),
      expiresAt: new Date('2026-11-20'),
    });

    const result = await service.resolve({ topic: 'Rust ownership', locale: 'en' }, caller);

    expect(result.status).toBe('pending');
    expect(queue.published).toHaveLength(1);
  });

  it('marks the job failed when publishing fails so the next request retries', async () => {
    queue.failNext = true;
    await expect(service.resolve({ topic: 'Rust ownership', locale: 'en' }, caller)).rejects.toThrow(
      'publish failed',
    );
    expect(repo.jobs.get(keyFor('Rust ownership'))?.status).toBe('failed');

    await service.resolve({ topic: 'Rust ownership', locale: 'en' }, caller);
    expect(queue.published).toHaveLength(1);
    // The failed attempt was refunded.
    expect(await store.get(counterKeys.dailyGenerations(caller.accountId, NOW))).toBe(1);
  });

  it('enforces the daily generation quota but keeps serving cached topics', async () => {
    const key = keyFor('Cached topic');
    repo.assessments.set(key, assessment({ id: key }));
    await service.resolve({ topic: 'Topic one', locale: 'en' }, caller);
    await service.resolve({ topic: 'Topic two', locale: 'en' }, caller);

    await expect(service.resolve({ topic: 'Topic three', locale: 'en' }, caller)).rejects.toThrow(
      QuotaExceededError,
    );
    expect(repo.jobs.get(keyFor('Topic three'))?.status).toBe('failed');
    await expect(service.resolve({ topic: 'Cached topic', locale: 'en' }, caller)).resolves.toMatchObject({
      status: 'ready',
    });
    // Another account is unaffected, and can claim the freed job.
    await expect(
      service.resolve({ topic: 'Topic three', locale: 'en' }, principal({}, 'acct_2')),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('stops new generations once the daily LLM budget is spent', async () => {
    await store.add(counterKeys.dailySpend(NOW), toMicroUsd(5), new Date('2026-10-28'));

    const error = await service
      .resolve({ topic: 'Rust ownership', locale: 'en' }, caller)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).retryAt.toISOString()).toBe('2026-10-27T00:00:00.000Z');
    expect(queue.published).toHaveLength(0);
  });
});

describe('AssessmentService.grade', () => {
  it('scores answers and reveals the key', () => {
    const service = new AssessmentService(
      new InMemoryRepository(),
      new FakeEmbedder(),
      new FakeQueue(),
      new SpendGuard(new MemoryLimitStore(), 1),
      {
        questionsPerLevel: 1,
        similarityThreshold: 0.88,
        defaultTtlSeconds: 1,
        maxTtlSeconds: 1,
        jobStaleSeconds: 1,
      },
    );
    const target = assessment();
    const answers = target.questions.map((q, i) => (i === 0 ? q.a : null));

    const result = service.grade(target, 1, answers);

    expect(result.score).toBe(1);
    expect(result.total).toBe(3);
    expect(result.results[1]).toMatchObject({ correct: false, a: target.questions[1]?.a });
  });

  it('serves and grades a smaller selection of the same assessment', () => {
    const service = new AssessmentService(
      new InMemoryRepository(),
      new FakeEmbedder(),
      new FakeQueue(),
      new SpendGuard(new MemoryLimitStore(), 1),
      {
        questionsPerLevel: 3,
        similarityThreshold: 0.88,
        defaultTtlSeconds: 1,
        maxTtlSeconds: 1,
        jobStaleSeconds: 1,
      },
    );
    const target = assessment({ questions: questions(3) });

    const selected = service.questionsFor(target, 2);
    expect(selected.map((q) => q.d)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(selected[2]).toBe(target.questions[3]);

    const result = service.grade(
      target,
      2,
      selected.map((q) => q.a),
    );
    expect(result).toMatchObject({ score: 6, total: 6 });
  });
});
