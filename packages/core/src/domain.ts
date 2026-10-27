import { createHash, randomInt } from 'node:crypto';
import { InvalidOutputError } from './errors.js';
import { LEVELS, OPTIONS_PER_QUESTION, type Assessment, type Question } from './schemas.js';

export interface GenerationScope {
  locale: string;
  questionsPerLevel: number;
  promptVersion: string;
  embeddingModel: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Case, width, whitespace and control characters never change the meaning of a topic. */
export function normalizeTopic(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function scopeKey(scope: GenerationScope): string {
  return sha256(
    JSON.stringify([scope.locale, scope.questionsPerLevel, scope.promptVersion, scope.embeddingModel]),
  ).slice(0, 24);
}

/** Deterministic document id for a topic within a scope: identical requests share one assessment. */
export function cacheKey(topicNormalized: string, scope: GenerationScope): string {
  return sha256(`${scopeKey(scope)}:${topicNormalized}`);
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
function shuffleOptions(question: Question): Question {
  const order = question.o.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return {
    q: question.q.trim(),
    o: order.map((i) => (question.o[i] as string).trim()),
    a: order.indexOf(question.a),
    e: question.e.trim(),
    d: question.d,
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

/**
 * Drops malformed and duplicate questions, then requires exactly `perLevel` per difficulty.
 * Throws InvalidOutputError (retryable) when too few usable questions remain.
 */
export function finalizeQuestions(raw: readonly Question[], perLevel: number): Question[] {
  const byLevel = new Map<number, Question[]>(LEVELS.map((level) => [level, []]));
  for (const question of usableQuestions(raw)) byLevel.get(question.d)?.push(question);

  const shortfalls = LEVELS.filter((level) => (byLevel.get(level)?.length ?? 0) < perLevel);
  if (shortfalls.length > 0) {
    const counts = LEVELS.map((level) => `d${level}=${byLevel.get(level)?.length ?? 0}`).join(', ');
    throw new InvalidOutputError(`Expected ${perLevel} valid questions per level, got ${counts}`);
  }

  return LEVELS.flatMap((level) => (byLevel.get(level) ?? []).slice(0, perLevel).map(shuffleOptions));
}

/** The first `perLevel` questions of each difficulty: every caller sees the same subset for a given count. */
export function selectQuestions<T extends Pick<Question, 'd'>>(
  questions: readonly T[],
  perLevel: number,
): T[] {
  return LEVELS.flatMap((level) => questions.filter((question) => question.d === level).slice(0, perLevel));
}
