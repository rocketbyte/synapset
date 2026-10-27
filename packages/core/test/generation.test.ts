import { beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetExhaustedError,
  GenerationService,
  LogUsageRecorder,
  MemoryLimitStore,
  SpendGuard,
  counterKeys,
  toMicroUsd,
  PROMPT_VERSION,
  TopicRejectedError,
  TransientError,
  type GenerateMessage,
  type GenerationResult,
} from '@synapset/core';
import { FakeEmbedder, FakeLlm, InMemoryRepository, assessment, questions, silentLogger } from './fakes.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const JOB_ID = 'c'.repeat(64);
const message: GenerateMessage = {
  v: 1,
  jobId: JOB_ID,
  accountId: 'acct_1',
  topic: 'Rust ownership',
  locale: 'en',
  questionsPerLevel: 1,
  promptVersion: PROMPT_VERSION,
  ttlSeconds: 3600,
};
const success = (): Promise<GenerationResult> =>
  Promise.resolve({
    questions: questions(1),
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    usage: { inputTokens: 500, outputTokens: 900 },
  });

describe('GenerationService', () => {
  let repo: InMemoryRepository;
  let embedder: FakeEmbedder;
  let store: MemoryLimitStore;
  let usage: LogUsageRecorder;

  const service = (llm: FakeLlm) =>
    new GenerationService(
      repo,
      embedder,
      llm,
      new SpendGuard(store, 1, () => NOW),
      usage,
      { leaseSeconds: 300, maxDeliveryAttempts: 5 },
      silentLogger,
      () => NOW,
    );

  beforeEach(async () => {
    repo = new InMemoryRepository();
    embedder = new FakeEmbedder();
    store = new MemoryLimitStore(() => NOW);
    usage = new LogUsageRecorder();
    await repo.claimJob({ id: JOB_ID, topic: message.topic, locale: 'en' }, NOW, 900_000);
  });

  it('generates, stores with expiry, and completes the job', async () => {
    const llm = new FakeLlm(success);

    await expect(service(llm).handle(message, 1)).resolves.toBe('generated');

    const stored = repo.assessments.get(JOB_ID);
    expect(stored?.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(stored?.usage.outputTokens).toBe(900);
    expect(repo.embeddings.get(JOB_ID)).toHaveLength(768);
    expect(repo.jobs.get(JOB_ID)).toMatchObject({ status: 'done', assessmentId: JOB_ID });
  });

  it('records the cost against the daily budget and meters it to the triggering account', async () => {
    await service(new FakeLlm(success)).handle(message, 1);

    // 500 input x $0.10/M + 900 output x $0.50/M
    const cost = 0.0005;
    expect(await store.get(counterKeys.dailySpend(NOW))).toBe(toMicroUsd(cost));
    expect(usage.events).toEqual([
      expect.objectContaining({
        event: 'llm.generation',
        account_id: 'acct_1',
        job_id: JOB_ID,
        input_tokens: 500,
        output_tokens: 900,
        cost_usd: cost,
      }),
    ]);
  });

  it('fails queued jobs without calling the LLM once the budget is spent', async () => {
    await store.add(counterKeys.dailySpend(NOW), toMicroUsd(1), new Date('2026-10-28'));
    const llm = new FakeLlm(success);

    await expect(service(llm).handle(message, 1)).resolves.toBe('failed');
    expect(llm.calls).toBe(0);
    expect(repo.jobs.get(JOB_ID)?.error).toMatch(new RegExp(`^${new BudgetExhaustedError(NOW).name}`));
  });

  it('acknowledges duplicates without calling the LLM', async () => {
    const llm = new FakeLlm(success);
    await service(llm).handle(message, 1);

    await expect(service(llm).handle(message, 2)).resolves.toBe('already-done');
    expect(llm.calls).toBe(1);
  });

  it('skips the LLM when a fresh assessment already exists', async () => {
    repo.assessments.set(JOB_ID, assessment({ id: JOB_ID }));
    const llm = new FakeLlm(success);

    await expect(service(llm).handle(message, 1)).resolves.toBe('already-done');
    expect(llm.calls).toBe(0);
  });

  it('nacks while another worker holds the lease', async () => {
    await repo.acquireLease(JOB_ID, NOW, 300_000);
    await expect(service(new FakeLlm(success)).handle(message, 1)).rejects.toThrow(TransientError);
  });

  it('releases the job and rethrows retryable failures', async () => {
    const llm = new FakeLlm(() => Promise.reject(new TransientError('rate limited')));

    await expect(service(llm).handle(message, 1)).rejects.toThrow('rate limited');
    expect(repo.jobs.get(JOB_ID)?.status).toBe('pending');
  });

  it('fails the job on permanent errors and on the final delivery attempt', async () => {
    const rejected = new FakeLlm(() => Promise.reject(new TopicRejectedError('not a topic')));
    await expect(service(rejected).handle(message, 1)).resolves.toBe('failed');
    expect(repo.jobs.get(JOB_ID)?.error).toMatch(/^TopicRejectedError/);

    await repo.claimJob({ id: JOB_ID, topic: message.topic, locale: 'en' }, NOW, 900_000);
    const flaky = new FakeLlm(() => Promise.reject(new TransientError('timeout')));
    await expect(service(flaky).handle(message, 5)).resolves.toBe('failed');
  });
});
