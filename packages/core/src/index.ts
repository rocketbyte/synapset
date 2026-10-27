import { Firestore } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { createGenAiClient } from './adapters/google.js';
import { AnthropicLlmProvider } from './adapters/llm/anthropic.js';
import { FailoverLlmProvider } from './adapters/llm/failover.js';
import { GeminiLlmProvider } from './adapters/llm/gemini.js';
import type { Config, LlmProviderName } from './config.js';
import { FirestoreLimitStore } from './adapters/firestore-limits.js';
import { MemoryLimitStore } from './adapters/memory-limits.js';
import { RedisLimitStore, createRedis } from './adapters/redis.js';
import type { LimitStore, LlmProvider } from './ports.js';

export * from './auth.js';
export * from './billing.js';
export * from './config.js';
export * from './domain.js';
export * from './errors.js';
export * from './logger.js';
export * from './ports.js';
export * from './prompt.js';
export * from './schemas.js';
export { createGenAiClient } from './adapters/google.js';
export { VertexEmbedder } from './adapters/embeddings.js';
export { FirestoreAssessmentRepository } from './adapters/firestore.js';
export { PubSubJobQueue } from './adapters/pubsub.js';
export { FirestoreIdentityRepository } from './adapters/identity.js';
export { PubSubUsageRecorder, LogUsageRecorder } from './adapters/usage.js';
export { FirestoreLimitStore, MemoryLimitStore, RedisLimitStore, createRedis };
export { AnthropicLlmProvider, GeminiLlmProvider, FailoverLlmProvider };
export * from './services/assessments.js';
export * from './services/generation.js';
export * from './services/identity.js';
export * from './services/spend.js';

function buildProvider(name: LlmProviderName, config: Config): LlmProvider {
  if (name === 'gemini') {
    return new GeminiLlmProvider(
      createGenAiClient(config.GCP_PROJECT_ID, config.VERTEX_LOCATION),
      config.GEMINI_MODEL,
    );
  }
  if (!config.ANTHROPIC_API_KEY && config.NODE_ENV === 'production') {
    throw new Error('ANTHROPIC_API_KEY is required in production when the anthropic provider is used');
  }
  return new AnthropicLlmProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
    effort: config.ANTHROPIC_EFFORT,
  });
}

/** LLM_PROVIDER, wrapped with automatic failover to LLM_FALLBACK_PROVIDER when one is configured. */
export function createLlmProvider(config: Config, logger: Logger): LlmProvider {
  const primary = buildProvider(config.LLM_PROVIDER, config);
  const fallbackName = config.LLM_FALLBACK_PROVIDER;
  if (fallbackName === 'none' || fallbackName === config.LLM_PROVIDER) return primary;
  return new FailoverLlmProvider(primary, buildProvider(fallbackName, config), logger);
}

export function createFirestore(config: Config): Firestore {
  return new Firestore({ projectId: config.GCP_PROJECT_ID, databaseId: config.FIRESTORE_DATABASE_ID });
}

export function createPubSub(config: Config): PubSub {
  return new PubSub({ projectId: config.GCP_PROJECT_ID });
}

/**
 * Redis when REDIS_URL is set: exact, shared limits at any traffic level (fixed monthly cost).
 * Otherwise Firestore: no fixed cost; quotas and spend stay exact, rate and concurrency become per instance.
 */
export function createLimitStore(
  config: Config,
  logger: Logger,
  firestore: Firestore,
): { store: LimitStore; close: () => Promise<void> } {
  if (!config.REDIS_URL) {
    logger.info('REDIS_URL not set: quotas and spend in Firestore, rate and concurrency limits per instance');
    return { store: new FirestoreLimitStore(firestore), close: () => Promise.resolve() };
  }
  const redis = createRedis(config.REDIS_URL, config.REDIS_CA_CERT);
  redis.on('error', (error: unknown) => {
    logger.error({ err: error }, 'Redis connection error');
  });
  return {
    store: new RedisLimitStore(redis),
    close: async () => {
      await redis.quit();
    },
  };
}
export * from './services/question-bank.js';
