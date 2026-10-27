import {
  bankScopeKey,
  cacheKey,
  cleanContext,
  isFresh,
  normalizeTopic,
  requestIdentity,
  requestText,
  scopeKey,
  selectQuestions,
  styleKey,
  uniformCounts,
  type GenerationScope,
} from '../domain.js';
import type { Principal } from '../auth.js';
import { PROMPT_VERSION } from '../prompt.js';
import type { Assessment, BankQuestion, Job, ReuseMode } from '../schemas.js';
import type {
  AssessmentCache,
  AssessmentRepository,
  Clock,
  Embedder,
  GenerationGate,
  JobQueue,
} from '../ports.js';
import type { QuestionBank } from './question-bank.js';

const NEAREST_CANDIDATES = 5;

export interface AssessmentServiceOptions {
  /** Every assessment is generated with this many questions per level; callers may request fewer. */
  questionsPerLevel: number;
  similarityThreshold: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  jobStaleSeconds: number;
}

export interface ResolveInput {
  topic: string;
  /** What to cover: focus areas, emphasis, what to avoid. Part of what identifies the assessment. */
  context?: string | undefined;
  /** How to write: audience, tone, format. Bank questions are reused only within the same style. */
  style?: string | undefined;
  /** `strict` reuses only very close questions; `off` never reuses and always generates. Default `auto`. */
  reuse?: ReuseMode | undefined;
  locale: string;
  ttlSeconds?: number | undefined;
}

export type ResolveMatch = 'exact' | 'semantic' | 'composed';

export type ResolveResult =
  { status: 'ready'; assessment: Assessment; match: ResolveMatch } | { status: 'pending'; job: Job };

export interface AssessmentServiceDependencies {
  cache?: AssessmentCache | undefined;
  /** Without a bank every miss is generated in full. */
  bank?: QuestionBank | undefined;
  clock?: Clock | undefined;
}

export interface GradeResult {
  score: number;
  total: number;
  results: { i: number; correct: boolean; a: number; e: string }[];
}

export class AssessmentService {
  constructor(
    private readonly repo: AssessmentRepository,
    private readonly embedder: Embedder,
    private readonly queue: JobQueue,
    private readonly gate: GenerationGate,
    private readonly options: AssessmentServiceOptions,
    dependencies: AssessmentServiceDependencies = {},
  ) {
    this.cache = dependencies.cache;
    this.bank = dependencies.bank;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  private readonly cache: AssessmentCache | undefined;
  private readonly bank: QuestionBank | undefined;
  private readonly clock: Clock;

  /**
   * Cheapest source first: memory, exact key, alias, similar assessment, then questions reused from the
   * bank. Only what the bank cannot cover is generated, and only the caller who claims that job is
   * charged a generation against its plan and the LLM budget.
   */
  async resolve(input: ResolveInput, requester: Principal): Promise<ResolveResult> {
    const now = this.clock();
    const topicNormalized = normalizeTopic(input.topic);
    const context = cleanContext(input.context);
    const style = cleanContext(input.style);
    const reuseMode = input.reuse ?? 'auto';
    const scope: GenerationScope = {
      locale: input.locale,
      style: styleKey(style),
      questionsPerLevel: this.options.questionsPerLevel,
      promptVersion: PROMPT_VERSION,
      embeddingModel: this.embedder.model,
    };
    const key = cacheKey(requestIdentity({ topicNormalized, context, style, reuse: reuseMode }), scope);

    const exact = await this.findExact(key, now);
    if (exact) return { status: 'ready', assessment: exact, match: 'exact' };

    const embedding = await this.embedder.embed(requestText(topicNormalized, context));
    const nearest =
      reuseMode === 'off'
        ? undefined
        : (
            await this.repo.findNearest(
              embedding,
              scopeKey(scope),
              1 - this.options.similarityThreshold,
              NEAREST_CANDIDATES,
            )
          ).find((match) => isFresh(match.assessment, now));
    if (nearest) {
      await this.repo.saveAlias(key, nearest.assessment.id, nearest.assessment.expiresAt);
      this.cache?.set(key, nearest.assessment);
      return { status: 'ready', assessment: nearest.assessment, match: 'semantic' };
    }

    const perLevel = this.options.questionsPerLevel;
    const reuse =
      this.bank && reuseMode !== 'off'
        ? await this.bank.select(
            embedding,
            bankScopeKey({
              locale: input.locale,
              style: scope.style,
              promptVersion: PROMPT_VERSION,
              embeddingModel: this.embedder.model,
            }),
            uniformCounts(perLevel),
            reuseMode,
          )
        : [];
    const ttlSeconds = Math.min(
      input.ttlSeconds ?? this.options.defaultTtlSeconds,
      this.options.maxTtlSeconds,
    );
    if (reuse.length > 0 && reuse.every((level) => level.length === perLevel)) {
      const assessment = composeAssessment(
        key,
        input.topic.trim(),
        topicNormalized,
        context,
        style,
        input.locale,
        {
          scope: scopeKey(scope),
          embeddingModel: this.embedder.model,
          questions: reuse.flat(),
          now,
          ttlSeconds,
        },
      );
      await this.repo.saveAssessment(assessment, embedding);
      this.cache?.set(key, assessment);
      return { status: 'ready', assessment, match: 'composed' };
    }

    const { job, claimed } = await this.repo.claimJob(
      { id: key, topic: input.topic.trim(), locale: input.locale },
      now,
      this.options.jobStaleSeconds * 1000,
    );
    if (claimed) {
      let reservation;
      try {
        reservation = await this.gate.reserve(requester);
      } catch (error) {
        // Not charged and nothing queued: free the job so the next caller can claim it.
        await this.repo.failJob(key, 'generation not admitted', now);
        throw error;
      }
      try {
        await this.queue.publish({
          v: 1,
          jobId: key,
          accountId: requester.accountId,
          topic: job.topic,
          ...(context ? { context } : {}),
          ...(style ? { style } : {}),
          locale: input.locale,
          questionsPerLevel: scope.questionsPerLevel,
          promptVersion: PROMPT_VERSION,
          ttlSeconds,
          embedding,
          reuse: reuse.flat().map((question) => question.id),
        });
      } catch (error) {
        // Unblock the next request instead of leaving a pending job that no message will ever process.
        await this.repo.failJob(key, 'publish failed', now);
        await reservation.release();
        throw error;
      }
    }
    return { status: 'pending', job };
  }

  async get(id: string): Promise<Assessment | null> {
    const assessment = await this.repo.getAssessment(id);
    return assessment && isFresh(assessment, this.clock()) ? assessment : null;
  }

  getJob(id: string): Promise<Job | null> {
    return this.repo.getJob(id);
  }

  get maxQuestionsPerLevel(): number {
    return this.options.questionsPerLevel;
  }

  /** The questions a caller sees when asking for `perLevel` per difficulty, in the order they are graded. */
  questionsFor(assessment: Assessment, perLevel: number) {
    return selectQuestions(assessment.questions, perLevel);
  }

  /**
   * `answers[i]` is the chosen option index for question i of the `perLevel` selection, or null when
   * unanswered.
   */
  grade(assessment: Assessment, perLevel: number, answers: readonly (number | null)[]): GradeResult {
    const results = this.questionsFor(assessment, perLevel).map((question, i) => ({
      i,
      correct: answers[i] === question.a,
      a: question.a,
      e: question.e,
    }));
    return { score: results.filter((r) => r.correct).length, total: results.length, results };
  }

  private async findExact(key: string, now: Date): Promise<Assessment | null> {
    const cached = this.cache?.get(key);
    if (cached && isFresh(cached, now)) return cached;

    let assessment = await this.repo.getAssessment(key);
    if (!assessment || !isFresh(assessment, now)) {
      const aliasId = await this.repo.getAlias(key);
      assessment = aliasId ? await this.repo.getAssessment(aliasId) : null;
    }
    if (!assessment || !isFresh(assessment, now)) return null;
    this.cache?.set(key, assessment);
    return assessment;
  }
}

/** An assessment built entirely from bank questions: no LLM call, no generation charged. */
function composeAssessment(
  id: string,
  topic: string,
  topicNormalized: string,
  context: string | null,
  style: string | null,
  locale: string,
  parts: { scope: string; embeddingModel: string; questions: BankQuestion[]; now: Date; ttlSeconds: number },
): Assessment {
  return {
    id,
    topic,
    topicNormalized,
    context,
    style,
    locale,
    scope: parts.scope,
    questions: parts.questions.map(({ q, o, a, e, d }) => ({ q, o, a, e, d })),
    llmProvider: 'bank',
    model: 'bank',
    promptVersion: PROMPT_VERSION,
    embeddingModel: parts.embeddingModel,
    usage: { inputTokens: 0, outputTokens: 0 },
    reusedQuestions: parts.questions.length,
    questionIds: parts.questions.map((question) => question.id),
    createdAt: parts.now,
    expiresAt: new Date(parts.now.getTime() + parts.ttlSeconds * 1000),
  };
}
