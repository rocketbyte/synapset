import { z } from 'zod';
import { EMBEDDING_DIMENSIONS } from './config.js';

export const LEVELS = [1, 2, 3] as const;
export const OPTIONS_PER_QUESTION = 4;
export const MAX_TOPIC_LENGTH = 120;
/** Bounds the prompt tokens a caller's guidance can add. */
export const MAX_CONTEXT_LENGTH = 1000;

/** Minified keys keep LLM output tokens and storage small. */
export const QuestionSchema = z.object({
  q: z.string().describe('Question text'),
  o: z.array(z.string()).describe('Exactly 4 answer options'),
  a: z.number().int().describe('0-based index of the single correct option'),
  e: z.string().describe('One-sentence explanation of the correct answer'),
  d: z.number().int().describe('Difficulty: 1 easy, 2 medium, 3 hard'),
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
  locale: LocaleSchema,
  questionsPerLevel: z.number().int().positive(),
  promptVersion: z.string(),
  ttlSeconds: z.number().int().positive(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS).optional(),
  /** Bank questions the API selected for reuse; the worker generates only what they leave missing. */
  reuse: z.array(z.string()).optional(),
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
  /** Caller guidance the questions were generated or selected for. */
  context: string | null;
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
  createdAt: Date;
  expiresAt: Date;
}

/** A checked question stored on its own, so other assessments can reuse it without an LLM call. */
export interface BankQuestion extends Question {
  id: string;
  /** Hash of what makes questions interchangeable: locale, prompt version, embedding model. */
  scope: string;
  /** Embedding of the question and its correct option. */
  embedding: number[];
  sourceAssessmentId: string;
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
