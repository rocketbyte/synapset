import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Principal } from '../auth.js';
import { cleanContext, normalizeTopic, requestText, bankScopeKey, type LevelCounts } from '../domain.js';
import { BudgetExhaustedError, QuotaExceededError, TransientError } from '../errors.js';
import {
  capFor,
  decodeCursor,
  encodeCursor,
  planSlice,
  poolKey,
  poolStyle,
  shareOf,
  type Level,
  type PoolCapRule,
  type SliceMode,
} from '../pools.js';
import { PROMPT_VERSION } from '../prompt.js';
import {
  LEVELS,
  type Assessment,
  type Audience,
  type BankQuestion,
  type Job,
  type QuestionPool,
  type QuestionType,
  type Tone,
} from '../schemas.js';
import type { AssessmentRepository, Clock, Embedder, GenerationGate, JobQueue } from '../ports.js';
import type { QuestionBank } from './question-bank.js';

/** How long instances trust their copy of the cap rules: the delay before a change is live everywhere. */
const CAP_RULES_TTL_MS = 30_000;
/** Enough to replace questions withdrawn since a slice was planned. */
const PLAN_ATTEMPTS = 3;

/** Operators' cap rules, read at most once per `CAP_RULES_TTL_MS` per instance. */
export class PoolCaps {
  private cached: { rules: PoolCapRule[]; at: number } | null = null;

  constructor(
    private readonly repo: Pick<AssessmentRepository, 'getPoolCapRules'>,
    readonly defaultCap: number,
    private readonly logger: Logger,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async rules(): Promise<PoolCapRule[]> {
    const now = this.clock().getTime();
    if (this.cached && now - this.cached.at < CAP_RULES_TTL_MS) return this.cached.rules;
    try {
      this.cached = { rules: await this.repo.getPoolCapRules(), at: now };
    } catch (error) {
      // Caps protect spend but must not take serving down: keep the last known rules for another period.
      this.logger.warn({ err: error }, 'Pool cap rules unavailable; using the last known ones');
      this.cached = { rules: this.cached?.rules ?? [], at: now };
    }
    return this.cached.rules;
  }
}

export interface PoolServiceOptions {
  /** Server-only: how long generated pool questions live. Never taken from a request. */
  ttlSeconds: number;
  /** New questions written per level in one generation. */
  batchPerLevel: number;
  /** How long a served slice stays gradable. */
  sliceTtlSeconds: number;
  jobStaleSeconds: number;
}

export interface NextSliceInput {
  topic: string;
  context?: string | undefined;
  locale: string;
  audience: Audience;
  tone: Tone;
  types: readonly QuestionType[];
  levels: readonly Level[];
  questionsPerLevel: number;
  /** The most questions this consumer wants behind the topic, across its levels. */
  poolSize?: number | undefined;
  cursor?: string | undefined;
  revisit: number;
  /** Changes the random part of a slice; the same seed and cursor give the same slice. */
  seed?: string | undefined;
}

export interface PoolStatus {
  size: number;
  limit: number;
  exhausted: boolean;
}

export type NextSliceResult =
  | { status: 'ready'; assessment: Assessment; mode: SliceMode; pool: PoolStatus }
  | { status: 'pending'; job: Job };

export interface PoolServiceDependencies {
  /** Without a bank, everything a pool lacks is generated. */
  bank?: QuestionBank | undefined;
  clock?: Clock | undefined;
}

const liveEntries = (pool: QuestionPool, level: Level, now: Date) =>
  pool.levels[level].filter((entry) => entry.expiresAt > now.getTime());

const isSaturated = (pool: QuestionPool, level: Level, now: Date) => {
  const until = pool.saturatedUntil[level];
  return until !== undefined && until > now.getTime();
};

/**
 * Serves slices of a question pool. Consumers hold the cursor; the service keeps nothing about them. A
 * slice is stored as an ordinary assessment under an id derived from its content, so grading, reporting
 * and quarantine work as they do everywhere else.
 */
export class PoolService {
  private readonly bank: QuestionBank | undefined;
  private readonly clock: Clock;

  constructor(
    private readonly repo: AssessmentRepository,
    private readonly embedder: Embedder,
    private readonly queue: JobQueue,
    private readonly gate: GenerationGate,
    private readonly caps: PoolCaps,
    private readonly options: PoolServiceOptions,
    dependencies: PoolServiceDependencies = {},
  ) {
    this.bank = dependencies.bank;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  /**
   * Cheapest source first: what the pool already holds, then the bank, then generation of the remainder.
   * Only the caller who claims the job is charged a generation.
   */
  async next(input: NextSliceInput, requester: Principal): Promise<NextSliceResult> {
    let pool = await this.pool(input);
    const limits = await this.limits(pool, input);
    const first = await this.assemble(pool, input, limits, true);
    if (first.status === 'ready') return first;

    const now = this.clock();
    const sizes = LEVELS.map((level) => pool.levels[level].length).join('.');
    const jobId = createHash('sha256').update(`pool:${pool.id}:${sizes}`).digest('hex');
    const { job, claimed } = await this.repo.claimJob(
      { id: jobId, topic: pool.topic, locale: pool.locale },
      now,
      this.options.jobStaleSeconds * 1000,
    );
    if (!claimed) return { status: 'pending', job };

    try {
      pool = await this.seedFromBank(pool, this.fill(pool, first.short, limits, now));
      const seeded = await this.assemble(pool, input, limits, true);
      if (seeded.status === 'ready') {
        await this.repo.completeJob(jobId, pool.id, now);
        return seeded;
      }

      let reservation;
      try {
        reservation = await this.gate.reserve(requester);
      } catch (error) {
        // Better a repeated question than no assessment: serve what the pool has when it has anything.
        const known = error instanceof QuotaExceededError || error instanceof BudgetExhaustedError;
        if (known && LEVELS.some((level) => liveEntries(pool, level, now).length > 0)) {
          const served = await this.assemble(pool, input, limits, false);
          if (served.status === 'ready') {
            await this.repo.failJob(jobId, 'generation not admitted', now);
            return served;
          }
        }
        throw error;
      }
      try {
        await this.queue.publish({
          v: 1,
          jobId,
          accountId: requester.accountId,
          topic: pool.topic,
          ...(pool.context ? { context: pool.context } : {}),
          locale: pool.locale,
          questionsPerLevel: this.options.batchPerLevel,
          promptVersion: PROMPT_VERSION,
          ttlSeconds: this.options.ttlSeconds,
          pool: { id: pool.id, counts: this.fill(pool, seeded.short, limits, now) },
        });
      } catch (error) {
        await reservation.release();
        throw error;
      }
      return { status: 'pending', job };
    } catch (error) {
      await this.repo.failJob(jobId, 'pool request failed', now);
      throw error;
    }
  }

  private async pool(input: NextSliceInput): Promise<QuestionPool> {
    const topicNormalized = normalizeTopic(input.topic);
    const context = cleanContext(input.context);
    const { locale, audience, tone } = input;
    const types = [...new Set(input.types)].sort();
    const id = poolKey({
      topicNormalized,
      context,
      locale,
      audience,
      tone,
      types,
      embeddingModel: this.embedder.model,
    });
    const existing = await this.repo.getPool(id);
    if (existing) return existing;
    const now = this.clock();
    return this.repo.createPool({
      id,
      topic: input.topic.trim(),
      topicNormalized,
      context,
      locale,
      audience,
      tone,
      types,
      scope: bankScopeKey({
        locale,
        style: poolStyle(audience, tone),
        // Fixed, for the same reason a pool's key has no prompt version.
        promptVersion: 'pool',
        embeddingModel: this.embedder.model,
      }),
      levels: { 1: [], 2: [], 3: [] },
      saturatedUntil: {},
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.options.ttlSeconds * 1000),
    });
  }

  private async limits(pool: QuestionPool, input: NextSliceInput): Promise<LevelCounts> {
    const rules = await this.caps.rules();
    const limitFor = (level: Level) => {
      const cap = capFor(rules, this.caps.defaultCap, { ...pool, level });
      if (!input.levels.includes(level)) return 0;
      return Math.min(cap, input.poolSize ? shareOf(input.poolSize, input.levels, level) : cap);
    };
    return { 1: limitFor(1), 2: limitFor(2), 3: limitFor(3) };
  }

  /** New questions to ask for: a full batch, so one fill serves several slices, within each level's limit. */
  private fill(pool: QuestionPool, short: Partial<LevelCounts>, limits: LevelCounts, now: Date): LevelCounts {
    const count = (level: Level) =>
      short[level] === undefined
        ? 0
        : Math.min(this.options.batchPerLevel, limits[level] - liveEntries(pool, level, now).length);
    return { 1: count(1), 2: count(2), 3: count(3) };
  }

  private async assemble(
    pool: QuestionPool,
    input: NextSliceInput,
    limits: LevelCounts,
    mayGrow: boolean,
  ): Promise<
    | { status: 'ready'; assessment: Assessment; mode: SliceMode; pool: PoolStatus }
    | { status: 'short'; short: Partial<LevelCounts> }
  > {
    const now = this.clock();
    const cursor = decodeCursor(input.cursor);
    const withdrawn = new Set<string>();
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      const live = (level: Level) => liveEntries(pool, level, now).map((entry) => entry.id);
      const idsFor = (level: Level) =>
        live(level)
          .slice(0, limits[level])
          .filter((id) => !withdrawn.has(id));
      const ids = { 1: idsFor(1), 2: idsFor(2), 3: idsFor(3) };
      const canGrow = (level: Level) =>
        mayGrow && live(level).length < limits[level] && !isSaturated(pool, level, now);
      const plan = planSlice({
        levels: input.levels,
        ids,
        growable: { 1: canGrow(1), 2: canGrow(2), 3: canGrow(3) },
        cursor,
        perLevel: input.questionsPerLevel,
        revisit: input.revisit,
        seed: input.seed ?? encodeCursor(cursor),
      });
      if (Object.keys(plan.short).length > 0) return { status: 'short', short: plan.short };

      const chosen = input.levels.flatMap((level) => plan.picks[level]);
      if (chosen.length === 0) throw new TransientError(`Pool ${pool.id} has no questions to serve`);
      const nextCursor = encodeCursor(plan.next);
      const id = createHash('sha256')
        .update(`slice:${pool.id}:${chosen.join(',')}:${nextCursor}`)
        .digest('hex');
      const status: PoolStatus = {
        size: LEVELS.reduce((sum, level) => sum + ids[level].length, 0),
        limit: LEVELS.reduce((sum, level) => sum + limits[level], 0),
        exhausted: input.levels.every((level) => plan.next[level] >= ids[level].length),
      };

      const stored = await this.repo.getAssessment(id);
      if (stored && stored.expiresAt > now) {
        return { status: 'ready', assessment: stored, mode: plan.mode, pool: status };
      }

      const found = new Map(
        (await this.repo.getQuestions(chosen)).map((question) => [question.id, question]),
      );
      const usable = (question: BankQuestion | undefined): question is BankQuestion =>
        question?.status === 'active' && question.expiresAt > now;
      const missing = chosen.filter((chosenId) => !usable(found.get(chosenId)));
      if (missing.length > 0) {
        for (const missingId of missing) withdrawn.add(missingId);
        continue;
      }

      const questions = chosen.map((chosenId) => found.get(chosenId) as BankQuestion);
      const assessment: Assessment = {
        id,
        topic: pool.topic,
        topicNormalized: pool.topicNormalized,
        context: pool.context,
        style: null,
        locale: pool.locale,
        scope: `pool:${pool.id}`,
        questions: questions.map(({ q, o, a, e, d, t }) => ({ q, o, a, e, d, ...(t ? { t } : {}) })),
        llmProvider: 'bank',
        model: 'bank',
        promptVersion: PROMPT_VERSION,
        embeddingModel: this.embedder.model,
        usage: { inputTokens: 0, outputTokens: 0 },
        reusedQuestions: questions.length,
        questionIds: chosen,
        slice: {
          poolId: pool.id,
          audience: pool.audience,
          tone: pool.tone,
          mode: plan.mode,
          nextCursor,
          questionsPerLevel: input.questionsPerLevel,
        },
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.options.sliceTtlSeconds * 1000),
      };
      await this.repo.saveAssessment(assessment, null);
      return { status: 'ready', assessment, mode: plan.mode, pool: status };
    }
    throw new TransientError(`Pool ${pool.id} kept losing questions while a slice was planned`);
  }

  /** Moves relevant questions other pools already paid for into this one, strictly matched. */
  private async seedFromBank(pool: QuestionPool, counts: LevelCounts): Promise<QuestionPool> {
    if (!this.bank) return pool;
    const embedding = await this.embedder.embed(requestText(pool.topicNormalized, pool.context));
    const candidates = (await this.bank.select(embedding, pool.scope, counts, 'strict')).flat();
    if (candidates.length === 0) return pool;
    const held = await this.repo.getQuestions(
      LEVELS.flatMap((level) => pool.levels[level]).map(({ id }) => id),
    );
    const fitting = candidates.filter((candidate) => candidate.t && pool.types.includes(candidate.t));
    const added = this.bank.withoutDuplicates(fitting, held);
    if (added.length === 0) return pool;
    return this.repo.appendToPool(pool.id, added, {}, this.clock());
  }
}
