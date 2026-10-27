import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  bankScopeKey,
  isFresh,
  normalizeTopic,
  requestText,
  scopeKey,
  shuffleOptions,
  usableQuestions,
  type LevelCounts,
} from '../domain.js';
import { InvalidOutputError, PermanentError, TransientError } from '../errors.js';
import { PROMPT_VERSION } from '../prompt.js';
import { LEVELS, type BankQuestion, type GenerateMessage, type Question } from '../schemas.js';
import type {
  AssessmentRepository,
  Clock,
  Embedder,
  LlmCall,
  LlmProvider,
  UsageRecorder,
  Verdict,
} from '../ports.js';
import type { QuestionBank } from './question-bank.js';
import type { SpendGuard } from './spend.js';

export interface GenerationServiceOptions {
  leaseSeconds: number;
  maxDeliveryAttempts: number;
  /** Have the model answer every question blind and drop those whose key it disputes. */
  verifyAnswers: boolean;
}

/** Extra questions per level, so the answer check can drop some without failing the generation. */
export const spareQuestions = (perLevel: number) => Math.ceil(perLevel / 4);

/** Keeps the questions the checker answered the same way and judged unambiguous. */
export function keepVerified(questions: readonly Question[], verdicts: readonly Verdict[]): Question[] {
  const byIndex = new Map(verdicts.map((verdict) => [verdict.i, verdict]));
  return questions.filter((question, i) => {
    const verdict = byIndex.get(i);
    return verdict?.ok === true && verdict.a === question.a;
  });
}

/** Paid generation calls per attempt; each later round asks only for what earlier ones left missing. */
const GENERATION_ROUNDS = 2;

/** Every outcome acknowledges the message; retryable failures throw instead. */
export type GenerationOutcome = 'generated' | 'already-done' | 'skipped' | 'failed';

export class GenerationService {
  constructor(
    private readonly repo: AssessmentRepository,
    private readonly embedder: Embedder,
    private readonly llm: LlmProvider,
    private readonly bank: QuestionBank,
    private readonly spend: Pick<SpendGuard, 'assertBudgetAvailable' | 'recordSpend'>,
    private readonly usage: UsageRecorder,
    private readonly options: GenerationServiceOptions,
    private readonly logger: Logger,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async handle(message: GenerateMessage, deliveryAttempt: number): Promise<GenerationOutcome> {
    const log = this.logger.child({ jobId: message.jobId, deliveryAttempt });
    const lease = await this.repo.acquireLease(message.jobId, this.clock(), this.options.leaseSeconds * 1000);
    if (lease.kind === 'busy') throw new TransientError('Job is leased by another worker');
    if (lease.kind !== 'acquired') {
      log.info({ lease: lease.kind }, 'Nothing to do for job');
      return lease.kind === 'done' ? 'already-done' : 'skipped';
    }

    try {
      if (message.promptVersion !== PROMPT_VERSION) {
        throw new PermanentError(
          `Message built for prompt ${message.promptVersion}, worker runs ${PROMPT_VERSION}`,
        );
      }

      const existing = await this.repo.getAssessment(message.jobId);
      if (existing && isFresh(existing, this.clock())) {
        await this.repo.completeJob(message.jobId, existing.id, this.clock());
        return 'already-done';
      }

      const now = this.clock();
      const perLevel = message.questionsPerLevel;
      const topicNormalized = normalizeTopic(message.topic);
      const context = message.context ?? null;
      const embedding =
        message.embedding ?? (await this.embedder.embed(requestText(topicNormalized, context)));
      const bankScope = bankScopeKey({
        locale: message.locale,
        promptVersion: message.promptVersion,
        embeddingModel: this.embedder.model,
      });

      // Reused questions may have expired since the API chose them; generation covers the gap.
      const reused = (await this.bank.get(message.reuse ?? [])).filter((q) => q.expiresAt > now);
      const reusedByLevel = LEVELS.map((level) => reused.filter((q) => q.d === level).slice(0, perLevel));
      const needed = Object.fromEntries(
        LEVELS.map((level, i) => [level, perLevel - (reusedByLevel[i]?.length ?? 0)]),
      ) as LevelCounts;

      let generated: { question: Question; embedding: number[] }[] = [];
      let usage = { inputTokens: 0, outputTokens: 0 };
      let costUsd = 0;
      let source = { provider: 'bank', model: 'bank' };
      if (LEVELS.some((level) => needed[level] > 0)) {
        const result = await this.generate(message, needed, reused, log);
        ({ usage, costUsd } = result);
        source = { provider: result.provider, model: result.model };
        generated = result.questions;
      }

      const questions = LEVELS.flatMap((level, i) => [
        ...generated.filter(({ question }) => question.d === level).map(({ question }) => question),
        ...(reusedByLevel[i] ?? []).map(({ q, o, a, e, d }) => ({ q, o, a, e, d })),
      ]);
      const expiresAt = new Date(now.getTime() + message.ttlSeconds * 1000);
      await this.repo.saveAssessment(
        {
          id: message.jobId,
          topic: message.topic,
          topicNormalized,
          context,
          locale: message.locale,
          scope: scopeKey({
            locale: message.locale,
            questionsPerLevel: perLevel,
            promptVersion: message.promptVersion,
            embeddingModel: this.embedder.model,
          }),
          questions,
          llmProvider: source.provider,
          model: source.model,
          promptVersion: message.promptVersion,
          embeddingModel: this.embedder.model,
          usage,
          reusedQuestions: questions.length - generated.length,
          createdAt: now,
          expiresAt,
        },
        embedding,
      );
      await this.bank
        .add(
          generated.map(({ question }) => question),
          generated.map(({ embedding: vector }) => vector),
          bankScope,
          message.jobId,
          expiresAt,
        )
        .catch((error: unknown) => {
          // The assessment is complete; only future reuse is lost.
          log.warn({ err: error }, 'Failed to add questions to the bank');
        });
      await this.repo.completeJob(message.jobId, message.jobId, now);
      log.info(
        {
          ...source,
          usage,
          costUsd,
          generated: generated.length,
          reused: questions.length - generated.length,
        },
        'Assessment generated',
      );
      return 'generated';
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const finalAttempt = deliveryAttempt >= this.options.maxDeliveryAttempts;
      if (error instanceof PermanentError || finalAttempt) {
        await this.repo.failJob(message.jobId, reason, this.clock());
        log.error({ err: error }, 'Assessment generation failed permanently');
        return 'failed';
      }
      await this.repo.releaseJob(message.jobId, reason, this.clock());
      log.warn({ err: error }, 'Assessment generation failed; Pub/Sub will retry');
      throw error;
    }
  }

  /**
   * Writes the questions the bank could not supply (plus spares), checks their answers, and drops any that
   * duplicate a reused or already accepted question. Questions that pass are kept between rounds, so a
   * shortfall costs only the missing questions. Still short after the last round is retryable.
   */
  private async generate(
    message: GenerateMessage,
    needed: LevelCounts,
    reused: readonly BankQuestion[],
    log: Logger,
  ) {
    const accepted: { question: Question; embedding: number[] }[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let source = { provider: this.llm.name as string, model: '' };
    const missing = () =>
      Object.fromEntries(
        LEVELS.map((level) => [
          level,
          Math.max(0, needed[level] - accepted.filter(({ question }) => question.d === level).length),
        ]),
      ) as LevelCounts;

    for (let round = 1; round <= GENERATION_ROUNDS; round++) {
      const gap = missing();
      if (LEVELS.every((level) => gap[level] === 0)) break;
      // Checked before every paid call: jobs queued before the budget ran out must not spend past it.
      await this.spend.assertBudgetAvailable();
      const existing = [
        ...reused,
        ...accepted.map(({ question, embedding }) => ({ q: question.q, embedding })),
      ];
      const result = await this.generateRound(message, gap, existing, log);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      costUsd += result.costUsd;
      source = { provider: result.provider, model: result.model };
      accepted.push(...result.questions);
      log.info({ round, missing: gap, accepted: result.questions.length }, 'Generation round finished');
    }

    const gap = missing();
    const short = LEVELS.filter((level) => gap[level] > 0);
    if (short.length > 0) {
      throw new InvalidOutputError(
        `Too few valid questions after ${GENERATION_ROUNDS} rounds: ${short.map((level) => `difficulty ${level} missing ${gap[level]}`).join(', ')}`,
      );
    }
    const questions = LEVELS.flatMap((level) =>
      accepted
        .filter(({ question }) => question.d === level)
        .slice(0, needed[level])
        .map(({ question, embedding }) => ({ question: shuffleOptions(question), embedding })),
    );
    return { questions, usage, costUsd, ...source };
  }

  /** One paid generation (and check) for exactly the `gap`, with spares. */
  private async generateRound(
    message: GenerateMessage,
    gap: LevelCounts,
    existing: readonly { q: string; embedding: number[] }[],
    log: Logger,
  ) {
    const { verifyAnswers } = this.options;
    const requested = Object.fromEntries(
      LEVELS.map((level) => [
        level,
        gap[level] + (verifyAnswers && gap[level] > 0 ? spareQuestions(gap[level]) : 0),
      ]),
    ) as LevelCounts;
    const result = await this.llm.generate({
      topic: message.topic,
      context: message.context,
      locale: message.locale,
      counts: requested,
      existing: existing.map((question) => question.q),
    });
    let costUsd = await this.recordCost(message, result, log);
    const usage = { ...result.usage };

    const existingTexts = new Set(existing.map((question) => question.q.trim().toLowerCase()));
    let candidates = usableQuestions(result.questions).filter(
      (question) =>
        gap[question.d as keyof LevelCounts] > 0 && !existingTexts.has(question.q.trim().toLowerCase()),
    );
    if (verifyAnswers && candidates.length > 0) {
      const verification = await this.llm.verify({ locale: message.locale, questions: candidates });
      costUsd += await this.recordCost(message, verification, log);
      usage.inputTokens += verification.usage.inputTokens;
      usage.outputTokens += verification.usage.outputTokens;
      const verified = keepVerified(candidates, verification.verdicts);
      log.info(
        { candidates: candidates.length, rejected: candidates.length - verified.length },
        'Answers checked',
      );
      candidates = verified;
    }

    const distinct = await this.bank.distinct(candidates, existing);
    const questions = LEVELS.flatMap((level) =>
      distinct.filter(({ question }) => question.d === level).slice(0, gap[level]),
    );
    return { questions, usage, costUsd, provider: result.provider, model: result.model };
  }

  /**
   * Spend is recorded as soon as tokens are paid for, even if persisting the assessment then fails.
   * Returns 0 when the spend could not be recorded.
   */
  private async recordCost(message: GenerateMessage, result: LlmCall, log: Logger): Promise<number> {
    let costUsd: number | null = null;
    try {
      costUsd = await this.spend.recordSpend(result.model, result.usage);
    } catch (error) {
      log.error({ err: error, usage: result.usage }, 'Failed to record LLM spend');
    }
    this.usage.record({
      event: 'llm.generation',
      event_id: randomUUID(),
      occurred_at: this.clock().getTime() * 1000,
      account_id: message.accountId,
      job_id: message.jobId,
      provider: result.provider,
      model: result.model,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cost_usd: costUsd ?? 0,
    });
    return costUsd ?? 0;
  }
}
