import { z } from 'zod';

/** Must match the vector index dimension in infra/terraform/firestore.tf. */
export const EMBEDDING_DIMENSIONS = 768;

const LlmProviderName = z.enum(['anthropic', 'gemini']);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  GCP_PROJECT_ID: z.string().min(1),
  VERTEX_LOCATION: z.string().default('global'),
  FIRESTORE_DATABASE_ID: z.string().default('(default)'),
  PUBSUB_TOPIC: z.string().default('assessment-generate-v1'),

  LLM_PROVIDER: LlmProviderName.default('anthropic'),
  LLM_FALLBACK_PROVIDER: z.union([LlmProviderName, z.literal('none')]).default('gemini'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-2'),

  SIMILARITY_THRESHOLD: z.coerce.number().gt(0).lt(1).default(0.88),
  /** Questions generated per difficulty level; callers may request fewer, never more. */
  QUESTIONS_PER_LEVEL: z.coerce.number().int().min(1).max(20).default(10),
  /** Reuse relevant questions from earlier assessments instead of generating them. */
  REUSE_QUESTIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Similarity above a request's noise floor a bank question needs to be reused. Calibrated on
   * gemini-embedding-2: 0.08 kept 96% precision at 59% recall; lower reuses more, less precisely.
   */
  QUESTION_REUSE_MARGIN: z.coerce.number().min(0).max(0.5).default(0.08),
  /** Margin for requests with reuse "strict": 0.12 kept 100% precision at ~30% recall in calibration. */
  QUESTION_REUSE_STRICT_MARGIN: z.coerce.number().min(0).max(0.5).default(0.12),
  /** Distinct accounts that must report a question before it is quarantined. */
  FEEDBACK_QUARANTINE_REPORTS: z.coerce.number().int().min(1).default(2),
  /** Blind-answer every generated question and drop those whose key the model disputes. */
  VERIFY_ANSWERS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ASSESSMENT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(30 * 86_400),
  ASSESSMENT_MAX_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(365 * 86_400),
  /**
   * How long pool questions live. Long on purpose: a question written once is served for years instead of
   * being paid for again. Server-only; no request can change it.
   */
  QUESTION_POOL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(86_400)
    .default(2 * 365 * 86_400),
  /** Default ceiling per topic, audience, tone and difficulty. `pnpm admin pool-cap` overrides it live. */
  QUESTION_POOL_CAP: z.coerce.number().int().min(1).max(1000).default(300),
  /**
   * New questions written per level each time a pool runs out. Small on purpose: a pool grows as it is
   * used, so topics nobody retakes never pay for questions nobody sees.
   */
  QUESTION_POOL_BATCH_PER_LEVEL: z.coerce.number().int().min(1).max(20).default(6),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(30).default(300),
  JOB_STALE_SECONDS: z.coerce.number().int().min(60).default(900),
  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).default(5),

  /** rediss://:<auth>@host:6378. Unset: limits use Firestore (no fixed cost; see README "Cost profile"). */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  /** PEM of the Memorystore server CA (TLS server authentication). */
  REDIS_CA_CERT: z.string().optional(),
  /** Hard ceiling on LLM spend per UTC day across all accounts and providers. */
  LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(20),
  USAGE_TOPIC: z.string().default('usage-events-v1'),
  /** Proxies in front of the service whose X-Forwarded-For entries are trusted (LB + Cloud Run = 2). */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  /** Failed authentications per client IP per minute before the IP is throttled. */
  AUTH_FAILURES_PER_MINUTE: z.coerce.number().int().positive().default(20),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LlmProviderName = z.infer<typeof LlmProviderName>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  if (config.JOB_STALE_SECONDS <= config.JOB_LEASE_SECONDS) {
    throw new Error('Invalid configuration: JOB_STALE_SECONDS must exceed JOB_LEASE_SECONDS');
  }
  if (config.QUESTION_REUSE_STRICT_MARGIN < config.QUESTION_REUSE_MARGIN) {
    throw new Error('Invalid configuration: QUESTION_REUSE_STRICT_MARGIN is below QUESTION_REUSE_MARGIN');
  }
  if (config.ASSESSMENT_TTL_SECONDS > config.ASSESSMENT_MAX_TTL_SECONDS) {
    throw new Error('Invalid configuration: ASSESSMENT_TTL_SECONDS exceeds ASSESSMENT_MAX_TTL_SECONDS');
  }
  return config;
}
