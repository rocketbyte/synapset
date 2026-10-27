import {
  FirestoreAssessmentRepository,
  GenerationService,
  LogUsageRecorder,
  PubSubUsageRecorder,
  QuestionBank,
  SpendGuard,
  VertexEmbedder,
  createFirestore,
  createGenAiClient,
  createLimitStore,
  createLlmProvider,
  createLogger,
  createPubSub,
  loadConfig,
} from '@synapset/core';
import { buildWorkerServer } from './server.js';

const config = loadConfig();
const logger = createLogger('synapset-worker', config.LOG_LEVEL);
const firestore = createFirestore(config);
const pubsub = createPubSub(config);
const limits = createLimitStore(config, logger, firestore);
const usage =
  config.NODE_ENV === 'production'
    ? new PubSubUsageRecorder(pubsub, config.USAGE_TOPIC, logger)
    : new LogUsageRecorder(logger);

const repository = new FirestoreAssessmentRepository(firestore);
const embedder = new VertexEmbedder(
  createGenAiClient(config.GCP_PROJECT_ID, config.VERTEX_LOCATION),
  config.EMBEDDING_MODEL,
);
const service = new GenerationService(
  repository,
  embedder,
  createLlmProvider(config, logger),
  new QuestionBank(
    repository,
    embedder,
    { margin: config.QUESTION_REUSE_MARGIN, strictMargin: config.QUESTION_REUSE_STRICT_MARGIN },
    logger,
  ),
  new SpendGuard(limits.store, config.LLM_DAILY_BUDGET_USD),
  usage,
  {
    leaseSeconds: config.JOB_LEASE_SECONDS,
    maxDeliveryAttempts: config.MAX_DELIVERY_ATTEMPTS,
    verifyAnswers: config.VERIFY_ANSWERS,
  },
  logger,
);

const app = buildWorkerServer({ service, logger, projectId: config.GCP_PROJECT_ID });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await usage.flush().catch((error: unknown) => {
        logger.error({ err: error }, 'Failed to flush usage events');
      });
      await Promise.allSettled([pubsub.close(), firestore.terminate(), limits.close()]);
      process.exit(0);
    })();
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });
logger.info(
  {
    provider: config.LLM_PROVIDER,
    fallback: config.LLM_FALLBACK_PROVIDER,
    dailyBudgetUsd: config.LLM_DAILY_BUDGET_USD,
  },
  'Worker ready',
);
