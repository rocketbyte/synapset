import { LRUCache } from 'lru-cache';
import {
  AssessmentService,
  Authenticator,
  FeedbackService,
  FirestoreAssessmentRepository,
  FirestoreIdentityRepository,
  LogUsageRecorder,
  PoolCaps,
  PoolService,
  PubSubJobQueue,
  PubSubUsageRecorder,
  QuestionBank,
  SpendGuard,
  VertexEmbedder,
  createFirestore,
  createGenAiClient,
  createLimitStore,
  createLogger,
  createPubSub,
  loadConfig,
  type Assessment,
} from '@synapset/core';
import { buildServer } from './server.js';

const config = loadConfig();
const logger = createLogger('synapset-api', config.LOG_LEVEL);
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
const bank = config.REUSE_QUESTIONS
  ? new QuestionBank(
      repository,
      embedder,
      { margin: config.QUESTION_REUSE_MARGIN, strictMargin: config.QUESTION_REUSE_STRICT_MARGIN },
      logger,
    )
  : undefined;
const queue = new PubSubJobQueue(pubsub.topic(config.PUBSUB_TOPIC));
const gate = new SpendGuard(limits.store, config.LLM_DAILY_BUDGET_USD);
const pools = new PoolService(
  repository,
  embedder,
  queue,
  gate,
  new PoolCaps(repository, config.QUESTION_POOL_CAP, logger),
  {
    ttlSeconds: config.QUESTION_POOL_TTL_SECONDS,
    batchPerLevel: config.QUESTION_POOL_BATCH_PER_LEVEL,
    sliceTtlSeconds: config.ASSESSMENT_TTL_SECONDS,
    jobStaleSeconds: config.JOB_STALE_SECONDS,
  },
  { bank },
);
const service = new AssessmentService(
  repository,
  embedder,
  queue,
  gate,
  {
    questionsPerLevel: config.QUESTIONS_PER_LEVEL,
    similarityThreshold: config.SIMILARITY_THRESHOLD,
    defaultTtlSeconds: config.ASSESSMENT_TTL_SECONDS,
    maxTtlSeconds: config.ASSESSMENT_MAX_TTL_SECONDS,
    jobStaleSeconds: config.JOB_STALE_SECONDS,
  },
  {
    cache: new LRUCache<string, Assessment>({ max: 5_000, ttl: 60_000 }),
    bank,
  },
);

const app = await buildServer({
  service,
  pools,
  feedback: new FeedbackService(
    repository,
    { quarantineAfterReports: config.FEEDBACK_QUARANTINE_REPORTS },
    logger,
  ),
  authenticator: new Authenticator(new FirestoreIdentityRepository(firestore)),
  limits: limits.store,
  usage,
  logger,
  projectId: config.GCP_PROJECT_ID,
  trustedProxyHops: config.TRUSTED_PROXY_HOPS,
  authFailuresPerMinute: config.AUTH_FAILURES_PER_MINUTE,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      // Flush metered usage before exit: Cloud Run sends SIGTERM 10s before killing the instance.
      await usage.flush().catch((error: unknown) => {
        logger.error({ err: error }, 'Failed to flush usage events');
      });
      await Promise.allSettled([pubsub.close(), firestore.terminate(), limits.close()]);
      process.exit(0);
    })();
  });
}

// Runs during startup, while the instance still has full CPU; never fails startup.
void bank?.warmUp();
await app.listen({ host: '0.0.0.0', port: config.PORT });
