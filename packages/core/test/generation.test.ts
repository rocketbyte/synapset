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
const successResult = (): GenerationResult => ({
  questions: questions(1),
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  usage: { inputTokens: 500, outputTokens: 900 },
});
const success = () => Promise.resolve(successResult());

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
      { leaseSeconds: 300, maxDeliveryAttempts: 5, verifyAnswers: true },
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
    expect(stored?.usage.outputTokens).toBe(900 + 100); // generation + answer check
    expect(repo.embeddings.get(JOB_ID)).toHaveLength(768);
    expect(repo.jobs.get(JOB_ID)).toMatchObject({ status: 'done', assessmentId: JOB_ID });
  });

  it('records the cost against the daily budget and meters it to the triggering account', async () => {
    await service(new FakeLlm(success)).handle(message, 1);

    // Generation: 500 input x $0.10/M + 900 output x $0.50/M. Check: 100 x $0.10/M + 100 x $0.50/M.
    const generation = 0.0005;
    const check = 0.00006;
    expect(await store.get(counterKeys.dailySpend(NOW))).toBe(toMicroUsd(generation) + toMicroUsd(check));
    expect(usage.events).toEqual([
      expect.objectContaining({
        event: 'llm.generation',
        account_id: 'acct_1',
        job_id: JOB_ID,
        input_tokens: 500,
        output_tokens: 900,
        cost_usd: generation,
      }),
      expect.objectContaining({ event: 'llm.generation', input_tokens: 100, output_tokens: 100 }),
    ]);
  });

  it('generates spares and keeps only questions whose answer key the checker confirms', async () => {
    const llm = new FakeLlm(
      () => Promise.resolve({ ...successResult(), questions: questions(2) }),
      (question) => question.q === 'Level 2 question 0?',
    );

    await expect(service(llm).handle(message, 1)).resolves.toBe('generated');

    expect(llm.generatedPerLevel).toEqual([2]);
    expect(llm.verifyCalls).toBe(1);
    const stored = repo.assessments.get(JOB_ID);
    expect(stored?.questions.map((q) => q.q)).toEqual([
      'Level 1 question 0?',
      'Level 2 question 1?',
      'Level 3 question 0?',
    ]);
    expect(stored?.usage).toEqual({ inputTokens: 600, outputTokens: 1000 });
  });

  it('retries when too few questions survive the check', async () => {
    const llm = new FakeLlm(success, (question) => question.d === 3);

    await expect(service(llm).handle(message, 1)).rejects.toThrow(/Expected 1 valid questions per level/);
    expect(repo.jobs.get(JOB_ID)?.status).toBe('pending');
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
