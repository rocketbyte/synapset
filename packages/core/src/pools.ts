import { createHash } from 'node:crypto';
import { conceptKey, type LevelCounts } from './domain.js';
import {
  LEVELS,
  type Audience,
  type BankQuestion,
  type PoolEntry,
  type QuestionPool,
  type QuestionType,
  type Tone,
} from './schemas.js';

/** A rule's cap is capped too: every entry lives in the pool document, which has a size limit. */
export const MAX_POOL_CAP = 1000;

export type Level = (typeof LEVELS)[number];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface PoolIdentity {
  topicNormalized: string;
  context: string | null;
  locale: string;
  audience: Audience;
  tone: Tone;
  types: readonly QuestionType[];
  embeddingModel: string;
}

/**
 * One pool per subject and way of writing, so children's questions never use up the room adults' need.
 * The prompt version is left out on purpose: pools live for years, and a prompt change must not orphan them.
 */
export function poolKey(identity: PoolIdentity): string {
  return sha256(
    JSON.stringify([
      'pool',
      identity.topicNormalized,
      identity.context,
      identity.locale,
      identity.audience,
      identity.tone,
      [...identity.types].sort(),
      identity.embeddingModel,
    ]),
  );
}

/** Style of a pool as the question bank knows it: bank questions are shared only within the same labels. */
export const poolStyle = (audience: Audience, tone: Tone) => `pool ${audience} ${tone}`;

/** The cursor is an offset per level. Consumers hold it; a pool only ever grows at the end, so it stays valid. */
export const START_CURSOR: LevelCounts = { 1: 0, 2: 0, 3: 0 };

export const encodeCursor = (cursor: LevelCounts) => LEVELS.map((level) => cursor[level]).join('.');

export function decodeCursor(raw: string | undefined): LevelCounts {
  const parts = raw?.split('.').map(Number);
  if (!parts || parts.length !== LEVELS.length || !parts.every((n) => Number.isSafeInteger(n) && n >= 0))
    return START_CURSOR;
  return { 1: parts[0] as number, 2: parts[1] as number, 3: parts[2] as number };
}

/** The same seed gives the same order, so a repeated request gets the same slice without any stored state. */
export function seededOrder<T extends string | number>(items: readonly T[], seed: string): T[] {
  return items
    .map((item) => ({ item, rank: sha256(`${seed}:${item}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    .map(({ item }) => item);
}

export interface SlicePlanInput {
  levels: readonly Level[];
  /** Live ids per level in pool order, already cut to the level's limit. */
  ids: Record<Level, readonly string[]>;
  /** Levels that can still gain questions. */
  growable: Record<Level, boolean>;
  cursor: LevelCounts;
  perLevel: number;
  /** Questions from before the cursor to mix in. */
  revisit: number;
  seed: string;
}

export type SliceMode = 'fresh' | 'wrapping' | 'random';

export interface SlicePlan {
  /** Chosen ids per level, shuffled so revisited questions do not stand out. */
  picks: Record<Level, string[]>;
  next: LevelCounts;
  mode: SliceMode;
  /** Unseen questions missing per growable level; generation should cover these before serving. */
  short: Partial<LevelCounts>;
}

/**
 * Picks a slice: new questions from the cursor on, plus `revisit` earlier ones at random. A level with
 * nothing new left and no room to grow draws entirely at random from what it has.
 */
export function planSlice(input: SlicePlanInput): SlicePlan {
  const { levels, ids, growable, cursor, perLevel, revisit, seed } = input;
  const position = (level: Level) => Math.min(cursor[level], ids[level].length);

  const back: LevelCounts = { 1: 0, 2: 0, 3: 0 };
  let left = revisit;
  let moved = true;
  while (left > 0 && moved) {
    moved = false;
    for (const level of seededOrder(levels, `${seed}:levels`)) {
      if (left > 0 && back[level] < Math.min(position(level), perLevel)) {
        back[level]++;
        left--;
        moved = true;
      }
    }
  }

  const picks: Record<Level, string[]> = { 1: [], 2: [], 3: [] };
  const next: LevelCounts = { ...cursor };
  const short: Partial<LevelCounts> = {};
  let wrapped = false;
  let unseenLeft = false;
  for (const level of levels) {
    const at = position(level);
    const unseen = ids[level].slice(at);
    const wanted = perLevel - back[level];
    const fresh = unseen.slice(0, wanted);
    const gap = wanted - fresh.length;
    if (gap > 0 && growable[level]) short[level] = gap;
    if (gap > 0) wrapped = true;
    if (unseen.length > 0) unseenLeft = true;
    const earlier = seededOrder(ids[level].slice(0, at), `${seed}:${level}`).slice(0, back[level] + gap);
    picks[level] = seededOrder([...fresh, ...earlier], `${seed}:mix`);
    next[level] = at + fresh.length;
  }
  return { picks, next, short, mode: !unseenLeft ? 'random' : wrapped ? 'wrapping' : 'fresh' };
}

/** A level's share of a total, the remainder going to the first levels: 100 over three is 34, 33, 33. */
export function shareOf(total: number, levels: readonly Level[], level: Level): number {
  const base = Math.floor(total / levels.length);
  return base + (levels.indexOf(level) < total % levels.length ? 1 : 0);
}

/** A live cap. A rule applies when every dimension it names matches; omitted dimensions match anything. */
export interface PoolCapRule {
  topic?: string;
  audience?: Audience;
  tone?: Tone;
  locale?: string;
  level?: Level;
  cap: number;
}

export type PoolCapDimensions = Pick<QuestionPool, 'topicNormalized' | 'audience' | 'tone' | 'locale'> & {
  level: Level;
};

/** The most specific matching rule wins; on a tie, the most recently added. */
export function capFor(
  rules: readonly PoolCapRule[],
  fallback: number,
  { topicNormalized, audience, tone, locale, level }: PoolCapDimensions,
): number {
  let best = { cap: fallback, specificity: -1 };
  for (const rule of rules) {
    const dimensions: [unknown, unknown][] = [
      [rule.topic, topicNormalized],
      [rule.audience, audience],
      [rule.tone, tone],
      [rule.locale, locale],
      [rule.level, level],
    ];
    const named = dimensions.filter(([wanted]) => wanted !== undefined);
    if (named.some(([wanted, actual]) => wanted !== actual)) continue;
    if (named.length >= best.specificity) best = { cap: rule.cap, specificity: named.length };
  }
  return best.cap;
}

/** Longest concept label stored; the pool document holds one per question. */
const MAX_CONCEPT_LENGTH = 80;

/** A pool with the questions added at the end of their levels, ids and concepts already held skipped. */
export function withQuestions(
  pool: QuestionPool,
  questions: readonly Pick<BankQuestion, 'id' | 'd' | 'c' | 'q' | 'expiresAt'>[],
  saturatedUntil: QuestionPool['saturatedUntil'],
  now: Date,
): QuestionPool {
  const levels = Object.fromEntries(
    LEVELS.map((level) => [level, [...pool.levels[level]]]),
  ) as QuestionPool['levels'];
  const held = new Set(LEVELS.flatMap((level) => levels[level].map((entry) => entry.id)));
  const concepts = new Set(
    LEVELS.flatMap((level) => levels[level].map((entry) => conceptKey(level, entry.concept))),
  );
  let expiresAt = pool.expiresAt;
  for (const question of questions) {
    const level = question.d as Level;
    const concept = (question.c ?? question.q).slice(0, MAX_CONCEPT_LENGTH);
    const key = conceptKey(level, concept);
    if (held.has(question.id) || concepts.has(key)) continue;
    const entry: PoolEntry = { id: question.id, concept, expiresAt: question.expiresAt.getTime() };
    levels[level].push(entry);
    held.add(question.id);
    concepts.add(key);
    if (question.expiresAt > expiresAt) expiresAt = question.expiresAt;
  }
  const saturated = Object.fromEntries(
    Object.entries({ ...pool.saturatedUntil, ...saturatedUntil }).filter(
      ([, until]) => until > now.getTime(),
    ),
  );
  return { ...pool, levels, saturatedUntil: saturated, expiresAt };
}
