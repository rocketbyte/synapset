import { createHash, randomInt } from 'node:crypto';
import { InvalidOutputError } from './errors.js';
import { LEVELS, OPTIONS_PER_QUESTION, type Assessment, type Question, type ReuseMode } from './schemas.js';

export interface GenerationScope {
  locale: string;
  /** styleKey() of the request: a similar assessment in another style is not a match. */
  style: string;
  questionsPerLevel: number;
  promptVersion: string;
  embeddingModel: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Case, width, whitespace and control characters never change the meaning of a topic. */
export function normalizeTopic(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Guidance keeps its casing for the prompt; only whitespace and control characters are cleaned. */
export function cleanContext(raw: string | undefined): string | null {
  const cleaned = raw?.normalize('NFKC').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned : null;
}

/** What a request is about, as one text: every embedding search derives from it. Style is not subject matter. */
export function requestText(topicNormalized: string, context: string | null): string {
  return context ? `${topicNormalized}. ${context.toLowerCase()}` : topicNormalized;
}

/** Style compared by its words: "For kids." and "for kids" are the same style. */
export function styleKey(style: string | null): string {
  return (style ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface RequestIdentity {
  topicNormalized: string;
  context: string | null;
  style: string | null;
  reuse: ReuseMode;
}

/** Everything that changes which questions a request gets; the cache key derives from it. */
export function requestIdentity({ topicNormalized, context, style, reuse }: RequestIdentity): string {
  const parts = [requestText(topicNormalized, context)];
  const key = styleKey(style);
  if (key) parts.push(`style: ${key}`);
  if (reuse !== 'auto') parts.push(`reuse: ${reuse}`);
  return parts.join('\n');
}

/** Concepts compared by their words, per difficulty: the same idea may be asked once at each level. */
export const conceptKey = (level: number, concept: string) =>
  `${level}:${concept
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()}`;

/** Text embedded for a bank question: retrieval matched topics best on the question plus its answer. */
export const questionText = (question: Pick<Question, 'q' | 'o' | 'a'>) =>
  `${question.q} ${question.o[question.a] ?? ''}`.trim();

export interface BankScope {
  locale: string;
  /** styleKey() of the request; questions are only reused within the style they were written for. */
  style: string;
  promptVersion: string;
  embeddingModel: string;
}

/** Questions are interchangeable across assessments of any size, so the bank scope omits the count. */
export function bankScopeKey(scope: BankScope): string {
  return sha256(
    JSON.stringify(['bank', scope.locale, scope.style, scope.promptVersion, scope.embeddingModel]),
  ).slice(0, 24);
}

/** Bank document id: the same question text in a scope is stored once. */
export const bankQuestionId = (scope: string, question: Pick<Question, 'q'>) =>
  sha256(`${scope}:${question.q.trim().toLowerCase()}`);

export function cosine(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function scopeKey(scope: GenerationScope): string {
  return sha256(
    JSON.stringify([
      scope.locale,
      scope.style,
      scope.questionsPerLevel,
      scope.promptVersion,
      scope.embeddingModel,
    ]),
  ).slice(0, 24);
}

/** Deterministic document id for a request within a scope: identical requests share one assessment. */
export function cacheKey(text: string, scope: GenerationScope): string {
  return sha256(`${scopeKey(scope)}:${text}`);
}

export const isFresh = (assessment: Pick<Assessment, 'expiresAt'>, now: Date) =>
  assessment.expiresAt.getTime() > now.getTime();

export function unitVector(values: readonly number[]): number[] {
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw new InvalidOutputError('Embedding has zero magnitude');
  return values.map((v) => v / norm);
}

const optionKey = (option: string) => option.trim().toLowerCase();

function isWellFormed(question: Question): boolean {
  return (
    question.q.trim().length > 0 &&
    question.e.trim().length > 0 &&
    (LEVELS as readonly number[]).includes(question.d) &&
    question.o.length === OPTIONS_PER_QUESTION &&
    question.o.every((option) => option.trim().length > 0) &&
    new Set(question.o.map(optionKey)).size === OPTIONS_PER_QUESTION &&
    Number.isInteger(question.a) &&
    question.a >= 0 &&
    question.a < OPTIONS_PER_QUESTION
  );
}

/** LLMs over-place the correct answer in some positions; a uniform shuffle removes that tell. */
export function shuffleOptions(question: Question): Question {
  const order = question.o.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return {
    ...question,
    q: question.q.trim(),
    o: order.map((i) => (question.o[i] as string).trim()),
    a: order.indexOf(question.a),
    e: question.e.trim(),
  };
}

/** Drops malformed and duplicate questions. */
export function usableQuestions(raw: readonly Question[]): Question[] {
  const seen = new Set<string>();
  return raw.filter((question) => {
    const key = question.q.trim().toLowerCase();
    if (!isWellFormed(question) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How many questions each difficulty level needs. */
export type LevelCounts = Record<(typeof LEVELS)[number], number>;

export const uniformCounts = (perLevel: number): LevelCounts => ({ 1: perLevel, 2: perLevel, 3: perLevel });

/**
 * Drops malformed and duplicate questions, then takes exactly `counts[d]` per difficulty, options shuffled.
 * Throws InvalidOutputError (retryable) when too few usable questions remain.
 */
export function finalizeQuestions(raw: readonly Question[], counts: LevelCounts | number): Question[] {
  const wanted = typeof counts === 'number' ? uniformCounts(counts) : counts;
  const byLevel = new Map<number, Question[]>(LEVELS.map((level) => [level, []]));
  for (const question of usableQuestions(raw)) byLevel.get(question.d)?.push(question);

  const short = LEVELS.some((level) => (byLevel.get(level)?.length ?? 0) < wanted[level]);
  if (short) {
    const got = LEVELS.map((level) => `d${level}=${byLevel.get(level)?.length ?? 0}/${wanted[level]}`).join(
      ', ',
    );
    throw new InvalidOutputError(`Too few valid questions per level: ${got}`);
  }

  return LEVELS.flatMap((level) => (byLevel.get(level) ?? []).slice(0, wanted[level]).map(shuffleOptions));
}

/** Positions of the first `perLevel` questions of each difficulty, in presentation order. */
export function selectIndexes(questions: readonly Pick<Question, 'd'>[], perLevel: number): number[] {
  return LEVELS.flatMap((level) =>
    questions.flatMap((question, i) => (question.d === level ? [i] : [])).slice(0, perLevel),
  );
}

/** The first `perLevel` questions of each difficulty: every caller sees the same subset for a given count. */
export function selectQuestions<T extends Pick<Question, 'd'>>(
  questions: readonly T[],
  perLevel: number,
): T[] {
  return selectIndexes(questions, perLevel).map((i) => questions[i] as T);
}
