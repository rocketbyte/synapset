import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { finalizeQuestions, isFresh, normalizeTopic, scopeKey, usableQuestions } from '../domain.js';
import { PermanentError, TransientError } from '../errors.js';
import { PROMPT_VERSION } from '../prompt.js';
import type { GenerateMessage, Question } from '../schemas.js';
import type {
  AssessmentRepository,
  Clock,
  Embedder,
  LlmCall,
  LlmProvider,
  UsageRecorder,
  Verdict,
} from '../ports.js';
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

/** Every outcome acknowledges the message; retryable failures throw instead. */
export type GenerationOutcome = 'generated' | 'already-done' | 'skipped' | 'failed';

export class GenerationService {
  constructor(
    private readonly repo: AssessmentRepository,
    private readonly embedder: Embedder,
    private readonly llm: LlmProvider,
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

      const topicNormalized = normalizeTopic(message.topic);
      const embedding = message.embedding ?? (await this.embedder.embed(topicNormalized));
      // Checked here as well as at admission: jobs queued before the budget ran out must not spend past it.
      await this.spend.assertBudgetAvailable();
      const perLevel = message.questionsPerLevel;
      const { verifyAnswers } = this.options;
      const result = await this.llm.generate({
        topic: message.topic,
        locale: message.locale,
        questionsPerLevel: perLevel + (verifyAnswers ? spareQuestions(perLevel) : 0),
      });
      let costUsd = await this.recordCost(message, result, log);
      let usage = result.usage;

      let candidates = usableQuestions(result.questions);
      if (verifyAnswers) {
        const verification = await this.llm.verify({ locale: message.locale, questions: candidates });
        costUsd += await this.recordCost(message, verification, log);
        usage = {
          inputTokens: usage.inputTokens + verification.usage.inputTokens,
          outputTokens: usage.outputTokens + verification.usage.outputTokens,
        };
        const verified = keepVerified(candidates, verification.verdicts);
        log.info(
          { candidates: candidates.length, rejected: candidates.length - verified.length },
          'Answers checked',
        );
        candidates = verified;
      }
      // Too few left is retryable: Pub/Sub redelivers and the next attempt generates afresh.
      const questions = finalizeQuestions(candidates, perLevel);

      const now = this.clock();
      await this.repo.saveAssessment(
        {
          id: message.jobId,
          topic: message.topic,
          topicNormalized,
          locale: message.locale,
          scope: scopeKey({
            locale: message.locale,
            questionsPerLevel: message.questionsPerLevel,
            promptVersion: message.promptVersion,
            embeddingModel: this.embedder.model,
          }),
          questions,
          llmProvider: result.provider,
          model: result.model,
          promptVersion: message.promptVersion,
          embeddingModel: this.embedder.model,
          usage,
          createdAt: now,
          expiresAt: new Date(now.getTime() + message.ttlSeconds * 1000),
        },
        embedding,
      );
      await this.repo.completeJob(message.jobId, message.jobId, now);
      log.info({ provider: result.provider, model: result.model, usage, costUsd }, 'Assessment generated');
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
