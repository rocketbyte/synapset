import { beforeEach, describe, expect, it } from 'vitest';
import {
  AssessmentService,
  BudgetExhaustedError,
  MemoryLimitStore,
  PROMPT_VERSION,
  QuestionBank,
  QuotaExceededError,
  bankScopeKey,
  requestText,
  SpendGuard,
  counterKeys,
  toMicroUsd,
  cacheKey,
  normalizeTopic,
  scopeKey,
  type Assessment,
  type GenerationScope,
} from '@synapset/core';
import {
  FakeEmbedder,
  FakeQueue,
  InMemoryRepository,
  assessment,
  axisVector,
  bankQuestion,
  principal,
  questions,
  silentLogger,
} from './fakes.js';

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
      { cache, clock: () => NOW },
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

describe('AssessmentService.resolve with the question bank', () => {
  const BANK = bankScopeKey({
    locale: 'en',
    promptVersion: PROMPT_VERSION,
    embeddingModel: 'fake-embedding',
  });
  const caller = principal({ generationsPerDay: 2 });

  function setup() {
    const repo = new InMemoryRepository();
    const embedder = new FakeEmbedder();
    const queue = new FakeQueue();
    const store = new MemoryLimitStore(() => NOW);
    const service = new AssessmentService(
      repo,
      embedder,
      queue,
      new SpendGuard(store, 5, () => NOW),
      {
        questionsPerLevel: 2,
        similarityThreshold: 0.88,
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 7200,
        jobStaleSeconds: 900,
      },
      {
        bank: new QuestionBank(repo, embedder, { margin: 0.08 }, silentLogger, () => NOW),
        clock: () => NOW,
      },
    );
    const request = { topic: 'Finance', context: '  Focus on   taxes ', locale: 'en' };
    const text = requestText('finance', 'Focus on taxes');
    embedder.vectors.set(text, axisVector({ 0: 1 }));
    const relevant = (d: number, label: string, axis: number) =>
      bankQuestion(BANK, d, label, axisVector({ 0: 0.9, [axis]: 0.44 }));
    return { repo, embedder, queue, store, service, request, text, relevant };
  }

  it('composes an assessment from the bank when it covers every level, without generating', async () => {
    const { repo, embedder, queue, store, service, request, text, relevant } = setup();
    await repo.saveQuestions([1, 2, 3].flatMap((d) => [relevant(d, 'x', 10 + d), relevant(d, 'y', 20 + d)]));

    const result = await service.resolve(request, caller);

    expect(result).toMatchObject({ status: 'ready', match: 'composed' });
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.assessment).toMatchObject({ context: 'Focus on taxes', reusedQuestions: 6, model: 'bank' });
    expect(result.assessment.questions.map((q) => q.d)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(embedder.texts[0]).toBe(text);
    expect(queue.published).toHaveLength(0);
    expect(await store.get(counterKeys.dailyGenerations(caller.accountId, NOW))).toBe(0);

    // The composed assessment is cached under the request: the next identical request is an exact hit.
    await expect(service.resolve(request, caller)).resolves.toMatchObject({ match: 'exact' });
  });

  it('queues generation of only what the bank lacks, passing the reused ids and the context', async () => {
    const { repo, queue, store, service, request, relevant } = setup();
    await repo.saveQuestions([relevant(1, 'x', 11), relevant(1, 'y', 12), relevant(3, 'x', 13)]);

    const result = await service.resolve(request, caller);

    expect(result).toMatchObject({ status: 'pending' });
    expect(queue.published[0]).toMatchObject({
      context: 'Focus on taxes',
      reuse: [`${BANK}-1-x`, `${BANK}-1-y`, `${BANK}-3-x`],
    });
    expect(await store.get(counterKeys.dailyGenerations(caller.accountId, NOW))).toBe(1);
  });

  it('treats different context as a different assessment', async () => {
    const { repo, service, request } = setup();
    const scope = { ...SCOPE, questionsPerLevel: 2 };
    const key = cacheKey(requestText('finance', 'Focus on taxes'), scope);
    repo.assessments.set(key, assessment({ id: key, expiresAt: new Date('2027-01-01T00:00:00Z') }));

    await expect(service.resolve(request, caller)).resolves.toMatchObject({ match: 'exact' });
    await expect(
      service.resolve({ ...request, context: 'Focus on investing' }, caller),
    ).resolves.toMatchObject({ status: 'pending' });
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
