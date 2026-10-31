import { z } from 'zod';
import { EMBEDDING_DIMENSIONS } from './config.js';

export const LEVELS = [1, 2, 3] as const;
export const OPTIONS_PER_QUESTION = 4;
export const MAX_TOPIC_LENGTH = 120;
/** Bounds the prompt tokens a caller's guidance can add. */
export const MAX_CONTEXT_LENGTH = 1000;
export const MAX_STYLE_LENGTH = 300;

/** How freely a request may reuse bank questions; `off` always generates. */
export const REUSE_MODES = ['auto', 'strict', 'off'] as const;
export type ReuseMode = (typeof REUSE_MODES)[number];

/** Who a pool's questions are written for. Part of what identifies a pool. */
export const AUDIENCES = ['children', 'teens', 'adults'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** How a pool's questions sound. Part of what identifies a pool. */
export const TONES = ['neutral', 'friendly', 'professional', 'academic'] as const;
export type Tone = (typeof TONES)[number];

/** What a question asks the reader to do. */
export const QUESTION_TYPES = [
  'conceptual',
  'scenario',
  'applied',
  'troubleshooting',
  'calculation',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const REPORT_REASONS = ['wrong_answer', 'ambiguous', 'off_topic', 'outdated', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Minified keys keep LLM output tokens and storage small. */
export const QuestionSchema = z.object({
  q: z.string().describe('Question text'),
  o: z.array(z.string()).describe('Exactly 4 answer options'),
  a: z.number().int().describe('0-based index of the single correct option'),
  e: z.string().describe('One-sentence explanation of the correct answer'),
  d: z.number().int().describe('Difficulty: 1 easy, 2 medium, 3 hard'),
  t: z.enum(QUESTION_TYPES).optional().describe('Question type, when the request lists types'),
  c: z.string().optional().describe('The concept tested, in a few words, when the request asks for it'),
});
export type Question = z.infer<typeof QuestionSchema>;

/** Structured-output contract shared by every LLM adapter. */
export const GenerationOutputSchema = z.object({
  ok: z.boolean().describe('false when the topic is not a legitimate subject of knowledge'),
  qs: z.array(QuestionSchema),
});
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>;

/** Structured-output contract for the blind answer check. */
export const VerificationOutputSchema = z.object({
  rs: z.array(
    z.object({
      i: z.number().int().describe('Index of the question'),
      a: z.number().int().describe('0-based index of the correct option, or -1 if none is correct'),
      ok: z
        .boolean()
        .describe('true only if exactly one option is unambiguously correct and the question is clear'),
    }),
  ),
});
export type VerificationOutput = z.infer<typeof VerificationOutputSchema>;

export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Expected a language tag such as "en" or "pt-BR"');

export const GenerateMessageSchema = z.object({
  v: z.literal(1),
  jobId: z.string().min(1),
  /** Account that triggered (and pays for) the generation. */
  accountId: z.string().min(1),
  topic: z.string().min(1).max(MAX_TOPIC_LENGTH),
  context: z.string().max(MAX_CONTEXT_LENGTH).optional(),
  style: z.string().max(MAX_STYLE_LENGTH).optional(),
  locale: LocaleSchema,
  questionsPerLevel: z.number().int().positive(),
  promptVersion: z.string(),
  ttlSeconds: z.number().int().positive(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS).optional(),
  /** Bank questions the API selected for reuse; the worker generates only what they leave missing. */
  reuse: z.array(z.string()).optional(),
  /** Set when the job grows a pool: the new questions wanted per level. Nothing here is an assessment. */
  pool: z
    .object({
      id: z.string().min(1),
      counts: z.object({
        1: z.number().int().min(0),
        2: z.number().int().min(0),
        3: z.number().int().min(0),
      }),
    })
    .optional(),
});
export type GenerateMessage = z.infer<typeof GenerateMessageSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface Assessment {
  id: string;
  topic: string;
  topicNormalized: string;
  /** Caller guidance on what to cover, which the questions were generated or selected for. */
  context: string | null;
  /** Caller guidance on audience, tone or format. */
  style: string | null;
  locale: string;
  /** Hash of everything that changes generated content; vector search is pre-filtered on it. */
  scope: string;
  questions: Question[];
  llmProvider: string;
  model: string;
  promptVersion: string;
  embeddingModel: string;
  usage: TokenUsage;
  /** Questions taken from the bank rather than generated for this assessment. */
  reusedQuestions: number;
  /** Bank id of each question, in order; lets a quarantined question invalidate every assessment using it. */
  questionIds: string[];
  /** Set when the assessment is a slice of a pool. */
  slice?: AssessmentSlice | undefined;
  createdAt: Date;
  expiresAt: Date;
}

export interface AssessmentSlice {
  poolId: string;
  audience: Audience;
  tone: Tone;
  mode: 'fresh' | 'wrapping' | 'random';
  /** What the consumer sends to continue after this slice. */
  nextCursor: string;
  questionsPerLevel: number;
}

/** A question's place in a pool. Entries are only ever added at the end, so cursors stay valid. */
export interface PoolEntry {
  id: string;
  /** Concept tested: tells the model what not to write again, at far fewer tokens than the questions. */
  concept: string;
  /** Epoch milliseconds. Live positions are what a cursor counts, so old questions lapse by themselves. */
  expiresAt: number;
}

/**
 * The questions behind one topic for one audience, tone and set of question types, per difficulty. Holds
 * nothing about any consumer.
 */
export interface QuestionPool {
  id: string;
  topic: string;
  topicNormalized: string;
  context: string | null;
  locale: string;
  audience: Audience;
  tone: Tone;
  types: QuestionType[];
  /** Bank scope of its questions. */
  scope: string;
  levels: Record<1 | 2 | 3, PoolEntry[]>;
  /** Epoch milliseconds per level: the subject ran out of new concepts, so generation waits until then. */
  saturatedUntil: Partial<Record<1 | 2 | 3, number>>;
  createdAt: Date;
  expiresAt: Date;
}

/** A checked question stored on its own, so other assessments can reuse it without an LLM call. */
export interface BankQuestion extends Question {
  id: string;
  /** Hash of what makes questions interchangeable: locale, style, prompt version, embedding model. */
  scope: string;
  /** Embedding of the question and its correct option. */
  embedding: number[];
  sourceAssessmentId: string;
  /** Quarantined questions are never reused and block identical text from being stored again. */
  status: 'active' | 'quarantined';
  /** Distinct accounts that reported the question. */
  reports: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface QuestionReport {
  id: string;
  questionId: string;
  assessmentId: string;
  accountId: string;
  reason: ReportReason;
  comment: string | null;
  /** Whether the question came from the bank in the reported assessment: calibration signal for reuse. */
  reused: boolean;
  /** Set when an operator restores the question; dismissed reports no longer count toward quarantine. */
  dismissed: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  topic: string;
  locale: string;
  attempts: number;
  leaseUntil: Date | null;
  assessmentId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}
