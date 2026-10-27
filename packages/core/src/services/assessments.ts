import {
  cacheKey,
  isFresh,
  normalizeTopic,
  scopeKey,
  selectQuestions,
  type GenerationScope,
} from '../domain.js';
import type { Principal } from '../auth.js';
import { PROMPT_VERSION } from '../prompt.js';
import type { Assessment, Job } from '../schemas.js';
import type {
  AssessmentCache,
  AssessmentRepository,
  Clock,
  Embedder,
  GenerationGate,
  JobQueue,
} from '../ports.js';

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
  locale: string;
  ttlSeconds?: number | undefined;
}

export type ResolveResult =
  { status: 'ready'; assessment: Assessment; match: 'exact' | 'semantic' } | { status: 'pending'; job: Job };

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
    private readonly cache?: AssessmentCache,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /**
   * Cheapest source first: memory, exact key, alias, vector search. Only a full miss enqueues generation,
   * and only the caller who claims the job is charged a generation against its plan and the LLM budget.
   */
  async resolve(input: ResolveInput, requester: Principal): Promise<ResolveResult> {
    const now = this.clock();
    const topicNormalized = normalizeTopic(input.topic);
    const scope: GenerationScope = {
      locale: input.locale,
      questionsPerLevel: this.options.questionsPerLevel,
      promptVersion: PROMPT_VERSION,
      embeddingModel: this.embedder.model,
    };
    const key = cacheKey(topicNormalized, scope);

    const exact = await this.findExact(key, now);
    if (exact) return { status: 'ready', assessment: exact, match: 'exact' };

    const embedding = await this.embedder.embed(topicNormalized);
    const nearest = (
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
          locale: input.locale,
          questionsPerLevel: scope.questionsPerLevel,
          promptVersion: PROMPT_VERSION,
          ttlSeconds: Math.min(
            input.ttlSeconds ?? this.options.defaultTtlSeconds,
            this.options.maxTtlSeconds,
          ),
          embedding,
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
