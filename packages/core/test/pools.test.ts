import { beforeEach, describe, expect, it } from 'vitest';
import {
  GenerationService,
  LogUsageRecorder,
  MemoryLimitStore,
  PROMPT_VERSION,
  PoolCaps,
  PoolService,
  QuestionBank,
  QuotaExceededError,
  SpendGuard,
  capFor,
  encodeCursor,
  planSlice,
  poolKey,
  shareOf,
  type GenerateMessage,
  type GenerationGate,
  type GenerationResult,
  type LevelCounts,
  type NextSliceInput,
  type Question,
  type QuestionType,
} from '@synapset/core';
import { FakeEmbedder, FakeLlm, FakeQueue, InMemoryRepository, principal, silentLogger } from './fakes.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const TWO_YEARS = 2 * 365 * 86_400;

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const plan = (overrides: Partial<Parameters<typeof planSlice>[0]> = {}) =>
  planSlice({
    levels: [1, 2, 3],
    ids: { 1: ids('a', 20), 2: ids('b', 20), 3: ids('c', 20) },
    growable: { 1: false, 2: false, 3: false },
    cursor: { 1: 0, 2: 0, 3: 0 },
    perLevel: 4,
    revisit: 0,
    seed: 's',
    ...overrides,
  });

describe('planSlice', () => {
  it('moves the cursor over new questions and mixes in the asked number of earlier ones', () => {
    const first = plan();
    expect(first.mode).toBe('fresh');
    expect(first.next).toEqual({ 1: 4, 2: 4, 3: 4 });

    const second = plan({ cursor: first.next, revisit: 3 });
    const all = Object.values(second.picks).flat();
    const seen = new Set(Object.values(first.picks).flat());
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
    expect(all.filter((id) => seen.has(id))).toHaveLength(3);
    expect(second.next[1] + second.next[2] + second.next[3]).toBe(12 + 9);
  });

  it('gives the same slice for the same seed, and another for another seed', () => {
    const cursor = { 1: 20, 2: 20, 3: 20 };
    expect(plan({ cursor })).toEqual(plan({ cursor }));
    expect(plan({ cursor }).picks).not.toEqual(plan({ cursor, seed: 'other' }).picks);
  });

  it('draws at random once a pool at its limit has nothing new', () => {
    const result = plan({ cursor: { 1: 20, 2: 20, 3: 20 } });
    expect(result.mode).toBe('random');
    expect(result.short).toEqual({});
    expect(result.next).toEqual({ 1: 20, 2: 20, 3: 20 });
    expect(Object.values(result.picks).flat()).toHaveLength(12);
  });

  it('asks for more only where a level can still grow', () => {
    const result = plan({ cursor: { 1: 18, 2: 20, 3: 0 }, growable: { 1: true, 2: false, 3: true } });
    expect(result.short).toEqual({ 1: 2 });
  });
});

describe('caps', () => {
  const pool = { topicNormalized: 'sql', audience: 'adults', tone: 'neutral', locale: 'en' } as const;

  it('takes the most specific matching rule and keeps dimensions apart', () => {
    const rules = [
      { cap: 500 },
      { audience: 'children' as const, cap: 50 },
      { topic: 'sql', level: 3 as const, cap: 80 },
    ];
    expect(capFor([], 300, { ...pool, level: 1 })).toBe(300);
    expect(capFor(rules, 300, { ...pool, level: 1 })).toBe(500);
    expect(capFor(rules, 300, { ...pool, level: 3 })).toBe(80);
    expect(capFor(rules, 300, { ...pool, audience: 'children', level: 1 })).toBe(50);
  });

  it('splits a total over the levels', () => {
    expect([1, 2, 3].map((level) => shareOf(100, [1, 2, 3], level as 1 | 2 | 3))).toEqual([34, 33, 33]);
  });

  it('gives each audience and tone its own pool', () => {
    const base = {
      topicNormalized: 'sql',
      context: null,
      locale: 'en',
      audience: 'adults' as const,
      tone: 'neutral' as const,
      types: ['scenario', 'conceptual'] as QuestionType[],
      embeddingModel: 'm',
    };
    expect(poolKey(base)).not.toBe(poolKey({ ...base, audience: 'children' }));
    expect(poolKey(base)).not.toBe(poolKey({ ...base, tone: 'friendly' }));
    expect(poolKey(base)).toBe(poolKey({ ...base, types: ['conceptual', 'scenario'] }));
  });
});

describe('pools end to end', () => {
  let repo: InMemoryRepository;
  let queue: FakeQueue;
  let embedder: FakeEmbedder;
  let written = 0;

  /** Each call writes the requested counts of questions no one has seen, testing distinct concepts. */
  const llm = () =>
    new FakeLlm(() => {
      const counts = llmInstance.requests.at(-1)?.counts as LevelCounts;
      const result: Question[] = ([1, 2, 3] as const).flatMap((d) =>
        Array.from({ length: counts[d] }, () => {
          const n = written++;
          return {
            q: `Q${n}?`,
            o: ['a', 'b', 'c', 'd'],
            a: 1,
            e: 'Because.',
            d,
            t: 'scenario',
            c: `Concept ${n}`,
          };
        }),
      );
      return Promise.resolve<GenerationResult>({
        questions: result,
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        usage: { inputTokens: 10, outputTokens: 10 },
      });
    });
  let llmInstance: FakeLlm;

  const openGate: GenerationGate = { reserve: () => Promise.resolve({ release: () => Promise.resolve() }) };
  const pools = (gate: GenerationGate = openGate, batchPerLevel = 8) =>
    new PoolService(
      repo,
      embedder,
      queue,
      gate,
      new PoolCaps(repo, 300, silentLogger, () => NOW),
      { ttlSeconds: TWO_YEARS, batchPerLevel, sliceTtlSeconds: 3600, jobStaleSeconds: 900 },
      {
        bank: new QuestionBank(repo, embedder, { margin: 0.08, strictMargin: 0.12 }, silentLogger, () => NOW),
        clock: () => NOW,
      },
    );
  const worker = () =>
    new GenerationService(
      repo,
      embedder,
      llmInstance,
      new QuestionBank(repo, embedder, { margin: 0.08, strictMargin: 0.12 }, silentLogger, () => NOW),
      new SpendGuard(new MemoryLimitStore(() => NOW), 100, () => NOW),
      new LogUsageRecorder(),
      { leaseSeconds: 300, maxDeliveryAttempts: 5, verifyAnswers: false },
      silentLogger,
      () => NOW,
    );
  const input: NextSliceInput = {
    topic: 'PostgreSQL',
    locale: 'en',
    audience: 'adults',
    tone: 'professional',
    types: ['scenario', 'conceptual'],
    levels: [1, 2, 3],
    questionsPerLevel: 4,
    poolSize: 60,
    revisit: 0,
  };

  const runJobs = async () => {
    for (const message of queue.published.splice(0)) await worker().handle(message, 1);
  };
  const ready = async (request: NextSliceInput, service = pools()) => {
    const first = await service.next(request, principal());
    if (first.status === 'ready') return first;
    await runJobs();
    const second = await service.next(request, principal());
    if (second.status !== 'ready') throw new Error('still pending');
    return second;
  };

  beforeEach(() => {
    repo = new InMemoryRepository();
    queue = new FakeQueue();
    embedder = new FakeEmbedder();
    written = 0;
    llmInstance = llm();
  });

  it('writes on demand, serves later takes without the model, and tells it what is covered', async () => {
    const first = await ready(input);
    expect(llmInstance.calls).toBe(1);
    expect(first.assessment.questions).toHaveLength(12);
    const stored = [...repo.bank.values()][0];
    expect(stored?.expiresAt.getTime()).toBe(NOW.getTime() + TWO_YEARS * 1000);

    const second = await ready({
      ...input,
      cursor: first.assessment.slice?.nextCursor,
      revisit: 3,
      seed: '1',
    });
    expect(llmInstance.calls).toBe(1);
    const repeats = second.assessment.questionIds.filter((id) => first.assessment.questionIds.includes(id));
    expect(repeats).toHaveLength(3);

    const third = await ready({ ...input, cursor: second.assessment.slice?.nextCursor, revisit: 3 });
    expect(third.assessment.questions).toHaveLength(12);
    expect(llmInstance.calls).toBe(2);
    expect(llmInstance.requests[1]?.pool?.covered).toHaveLength(24);
  });

  it('never stores a concept the pool already tests', async () => {
    await ready(input);
    const pool = [...repo.pools.values()][0];
    const before = pool?.levels[1].length ?? 0;
    const duplicate: Question = {
      q: 'New words, old idea?',
      o: ['a', 'b', 'c', 'd'],
      a: 0,
      e: 'Because.',
      d: 1,
      t: 'scenario',
      c: pool?.levels[1][0]?.concept,
    };
    llmInstance = new FakeLlm(() =>
      Promise.resolve({
        questions: [duplicate],
        provider: 'anthropic',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    await repo.claimJob({ id: 'd'.repeat(64), topic: 'PostgreSQL', locale: 'en' }, NOW, 900_000);
    const outcome = await worker().handle(
      {
        v: 1,
        jobId: 'd'.repeat(64),
        accountId: 'acct_1',
        topic: 'PostgreSQL',
        locale: 'en',
        questionsPerLevel: 1,
        promptVersion: PROMPT_VERSION,
        ttlSeconds: TWO_YEARS,
        pool: { id: pool?.id as string, counts: { 1: 1, 2: 0, 3: 0 } },
      },
      5,
    );
    expect(outcome).toBe('failed');
    expect(repo.pools.get(pool?.id as string)?.levels[1]).toHaveLength(before);
  });

  it('marks a level saturated instead of paying for repeats, and stops asking', async () => {
    await pools(openGate, 4).next(input, principal());
    llmInstance = new FakeLlm(() =>
      Promise.resolve({
        questions: [
          { q: 'Only one?', o: ['a', 'b', 'c', 'd'], a: 0, e: 'Because.', d: 1, t: 'scenario', c: 'One' },
        ],
        provider: 'anthropic',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    await runJobs();
    const pool = [...repo.pools.values()][0];
    expect(pool?.saturatedUntil[1]).toBeGreaterThan(NOW.getTime());
    expect(pool?.saturatedUntil[2]).toBeGreaterThan(NOW.getTime());
    expect((await pools(openGate, 4).next(input, principal())).status).toBe('ready');
  });

  it('raises and lowers a cap for everyone without a deploy', async () => {
    const service = pools();
    const first = await ready({ ...input, poolSize: undefined }, service);
    repo.capRules = [{ topic: 'postgresql', cap: 4 }];
    const capped = new PoolCaps(repo, 300, silentLogger, () => NOW);
    const live = new PoolService(
      repo,
      embedder,
      queue,
      openGate,
      capped,
      { ttlSeconds: TWO_YEARS, batchPerLevel: 8, sliceTtlSeconds: 3600, jobStaleSeconds: 900 },
      { clock: () => NOW },
    );
    const next = await live.next(
      { ...input, poolSize: undefined, cursor: first.assessment.slice?.nextCursor },
      principal(),
    );
    expect(next).toMatchObject({ status: 'ready', mode: 'random', pool: { limit: 12 } });
  });

  it('skips a withdrawn question without leaving a hole in the slice', async () => {
    const first = await ready(input);
    const gone = first.assessment.questionIds[0] as string;
    const question = repo.bank.get(gone);
    repo.bank.set(gone, { ...(question as NonNullable<typeof question>), status: 'quarantined' });
    await repo.expireAssessmentsWith(gone, NOW);
    const again = await ready(input);
    expect(again.assessment.questionIds).not.toContain(gone);
    expect(again.assessment.questions).toHaveLength(12);
  });

  it('serves what exists when the plan refuses a new generation', async () => {
    await ready({ ...input, poolSize: undefined });
    const refused: GenerationGate = {
      reserve: () => Promise.reject(new QuotaExceededError('generations_per_day', 1, NOW)),
    };
    const cursor = encodeCursor({ 1: 8, 2: 8, 3: 8 });
    const served = await pools(refused).next({ ...input, poolSize: undefined, cursor }, principal());
    expect(served).toMatchObject({ status: 'ready', mode: 'random' });
  });
});
