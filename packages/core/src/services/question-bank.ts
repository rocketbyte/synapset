import type { Logger } from 'pino';
import { EMBEDDING_DIMENSIONS } from '../config.js';
import { bankQuestionId, conceptKey, cosine, questionText, type LevelCounts } from '../domain.js';
import { LEVELS, type BankQuestion, type Question, type QuestionLabels, type ReuseMode } from '../schemas.js';
import type { AssessmentRepository, Clock, Embedder } from '../ports.js';

/**
 * Unrelated questions across many domains. A query's similarity to them estimates its noise floor:
 * broad queries ("finance") sit closer to everything than focused ones, so one fixed threshold either
 * misses broad matches or admits off-topic ones.
 */
export const BACKGROUND_QUESTIONS = [
  'What is the capital of Australia? Canberra',
  'Who painted the Mona Lisa? Leonardo da Vinci',
  'What is the chemical symbol for gold? Au',
  'How many players does a soccer team have on the field? Eleven',
  'What gas do plants absorb during photosynthesis? Carbon dioxide',
  'Which planet is known as the Red Planet? Mars',
  'What is the time complexity of binary search? O(log n)',
  'What does a semicolon do in a SQL statement? Terminates it',
  'Who wrote Romeo and Juliet? William Shakespeare',
  'What is the boiling point of water at sea level? 100 degrees Celsius',
  'What is the main ingredient of guacamole? Avocado',
  'Which instrument has 88 keys? The piano',
  'What is the largest organ of the human body? The skin',
  'What does GDP measure? The total value of goods and services produced',
  'What is the past tense of "go"? Went',
  'Which muscle pumps blood through the body? The heart',
  'What is the speed of light in a vacuum? About 300,000 km per second',
  'What does CPU stand for? Central processing unit',
  'Which treaty ended World War I? The Treaty of Versailles',
  'What is the square root of 144? 12',
  'What does a router do in a network? Forwards packets between networks',
  'Which vitamin does sunlight help the body produce? Vitamin D',
  'What is a haiku? A three-line poem with 5-7-5 syllables',
  'What does a mortgage loan finance? The purchase of real estate',
];
/** Percentile of background similarity taken as the floor; robust to one background item being on-topic. */
const FLOOR_PERCENTILE = 0.9;

/**
 * The similarity a query has to unrelated questions anyway. A question is reused when its similarity
 * exceeds this by the configured margin; calibration uses the same function to choose that margin.
 */
export function noiseFloor(queryEmbedding: readonly number[], background: readonly number[][]): number {
  const similarities = background.map((b) => cosine(queryEmbedding, b)).sort((a, b) => a - b);
  return similarities[
    Math.min(similarities.length - 1, Math.floor(FLOOR_PERCENTILE * similarities.length))
  ] as number;
}
/** Candidates fetched per needed question, so the diversity filter has room to work. */
const OVERFETCH = 3;
/** Two bank questions this similar test the same idea; only the more relevant is used. */
const NEAR_DUPLICATE = 0.9;
const EMBED_CONCURRENCY = 8;

export interface QuestionBankOptions {
  /** Similarity above the query's noise floor a question needs to be reused (reuse mode `auto`). */
  margin: number;
  /** The same, for reuse mode `strict`. */
  strictMargin: number;
}

/**
 * Stores every checked question with its embedding and finds the ones relevant to a new request, so
 * related assessments share questions instead of paying an LLM to write them again.
 */
export class QuestionBank {
  private background: Promise<number[][]> | null = null;

  constructor(
    private readonly repo: AssessmentRepository,
    private readonly embedder: Embedder,
    private readonly options: QuestionBankOptions,
    private readonly logger: Logger,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /**
   * Relevant, mutually distinct bank questions for each level, most relevant first, at most `counts[d]`.
   * Never throws: reuse only saves money, so on any failure the request falls back to generation.
   */
  async select(
    queryEmbedding: number[],
    scope: string,
    counts: LevelCounts,
    mode: Exclude<ReuseMode, 'off'> = 'auto',
  ): Promise<BankQuestion[][]> {
    try {
      const margin = mode === 'strict' ? this.options.strictMargin : this.options.margin;
      const minSimilarity = (await this.floor(queryEmbedding)) + margin;
      const now = this.clock();
      return await Promise.all(
        LEVELS.map(async (level) => {
          if (counts[level] === 0) return [];
          const matches = await this.repo.findNearestQuestions(
            queryEmbedding,
            scope,
            level,
            1 - minSimilarity,
            counts[level] * OVERFETCH,
          );
          const chosen: BankQuestion[] = [];
          for (const { question } of matches) {
            if (chosen.length === counts[level]) break;
            if (question.status !== 'active' || question.expiresAt <= now) continue;
            if (chosen.some((c) => cosine(c.embedding, question.embedding) >= NEAR_DUPLICATE)) continue;
            chosen.push(question);
          }
          return chosen;
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Question bank unavailable; generating without reuse');
      return LEVELS.map(() => []);
    }
  }

  /** Embeds the background set ahead of the first request, which would otherwise wait for it. */
  async warmUp(): Promise<void> {
    try {
      await this.floor(new Array<number>(EMBEDDING_DIMENSIONS).fill(0));
    } catch (error) {
      this.logger.warn({ err: error }, 'Question bank warm-up failed; the first request will retry');
    }
  }

  /** Ids among `ids` that reports have quarantined; generated questions with these ids are discarded. */
  async quarantined(ids: readonly string[]): Promise<Set<string>> {
    const found = await this.get(ids);
    return new Set(
      found.filter((question) => question.status === 'quarantined').map((question) => question.id),
    );
  }

  get(ids: readonly string[]): Promise<BankQuestion[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repo.getQuestions(ids);
  }

  /**
   * Embeds newly generated questions and drops those that test the same idea as a reused question or an
   * earlier candidate. The embeddings are kept for storing the survivors in the bank.
   */
  async distinct(
    candidates: readonly Question[],
    existing: readonly { embedding: number[] }[],
  ): Promise<{ question: Question; embedding: number[] }[]> {
    const vectors = await this.embed(candidates);
    const kept: { question: Question; embedding: number[] }[] = [];
    candidates.forEach((question, i) => {
      const embedding = vectors[i] as number[];
      const duplicate =
        existing.some((other) => cosine(other.embedding, embedding) >= NEAR_DUPLICATE) ||
        kept.some((other) => cosine(other.embedding, embedding) >= NEAR_DUPLICATE);
      if (!duplicate) kept.push({ question, embedding });
    });
    return kept;
  }

  /** `candidates` without those that test the same idea as a question already held, or as each other. */
  withoutDuplicates<T extends { embedding: number[]; d: number; c?: string | undefined }>(
    candidates: readonly T[],
    held: readonly { embedding: number[]; d: number; c?: string | undefined }[],
  ): T[] {
    const concepts = new Set(held.flatMap((q) => (q.c ? [conceptKey(q.d, q.c)] : [])));
    const kept: T[] = [];
    for (const candidate of candidates) {
      const key = candidate.c ? conceptKey(candidate.d, candidate.c) : null;
      if (key && concepts.has(key)) continue;
      const near = (other: { embedding: number[] }) =>
        cosine(other.embedding, candidate.embedding) >= NEAR_DUPLICATE;
      if (held.some(near) || kept.some(near)) continue;
      if (key) concepts.add(key);
      kept.push(candidate);
    }
    return kept;
  }

  private async embed(questions: readonly Question[]): Promise<number[][]> {
    const vectors: number[][] = new Array<number[]>(questions.length);
    let next = 0;
    const worker = async () => {
      while (next < questions.length) {
        const i = next++;
        vectors[i] = await this.embedder.embed(questionText(questions[i] as Question));
      }
    };
    await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, questions.length) }, worker));
    return vectors;
  }

  async add(
    questions: readonly Question[],
    embeddings: readonly number[][],
    scope: string,
    sourceAssessmentId: string,
    expiresAt: Date,
    labels?: QuestionLabels,
  ): Promise<void> {
    const now = this.clock();
    await this.repo.saveQuestions(
      questions.map((question, i) => ({
        ...question,
        ...(labels ? { labels } : {}),
        id: bankQuestionId(scope, question),
        scope,
        embedding: embeddings[i] as number[],
        sourceAssessmentId,
        status: 'active' as const,
        reports: 0,
        createdAt: now,
        expiresAt,
      })),
    );
  }

  private async floor(queryEmbedding: number[]): Promise<number> {
    this.background ??= Promise.all(BACKGROUND_QUESTIONS.map((text) => this.embedder.embed(text))).catch(
      (error: unknown) => {
        this.background = null;
        throw error;
      },
    );
    return noiseFloor(queryEmbedding, await this.background);
  }
}
