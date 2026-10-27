import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  BudgetExhaustedError,
  LocaleSchema,
  MAX_TOPIC_LENGTH,
  QuotaExceededError,
  TransientError,
  counterKeys,
  endOfUtcDay,
  endOfUtcMonth,
  traceBindings,
  type Assessment,
  type AssessmentService,
  type Authenticator,
  type Clock,
  type Job,
  type LimitStore,
  type Logger,
  type UsageRecorder,
} from '@synapset/core';
import { ProblemError, sendProblem } from './problems.js';
import { registerSecurity } from './security.js';

export interface ServerOptions {
  service: AssessmentService;
  authenticator: Authenticator;
  limits: LimitStore;
  usage: UsageRecorder;
  logger: Logger;
  projectId: string;
  trustedProxyHops: number;
  authFailuresPerMinute: number;
  clock?: Clock;
}

const RETRY_AFTER_SECONDS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

const Id = z.string().regex(/^[a-f0-9]{64}$/, 'Invalid id');
const IdParams = z.strictObject({ id: Id });

const ResolveBody = z.strictObject({
  topic: z.string().trim().min(2).max(MAX_TOPIC_LENGTH),
  locale: LocaleSchema.default('en'),
  ttlSeconds: z.number().int().min(3600).optional(),
});
const GradeBody = z.strictObject({ answers: z.array(z.number().int().min(0).max(3).nullable()).max(200) });

const AssessmentView = z.object({
  id: Id,
  topic: z.string(),
  locale: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  questions: z.array(
    z.object({ i: z.number().int(), q: z.string(), o: z.array(z.string()), d: z.number().int() }),
  ),
});
const ReadyView = z.object({
  status: z.literal('ready'),
  match: z.enum(['exact', 'semantic']),
  assessment: AssessmentView,
});
const JobView = z.object({
  jobId: Id,
  status: z.enum(['pending', 'running', 'done', 'failed']),
  assessmentId: Id.nullable(),
  error: z.enum(['topic_rejected', 'generation_capacity_exhausted', 'generation_failed']).nullable(),
});
const GradeView = z.object({
  score: z.number().int(),
  total: z.number().int(),
  results: z.array(
    z.object({ i: z.number().int(), correct: z.boolean(), a: z.number().int(), e: z.string() }),
  ),
});
const Counter = z.object({ used: z.number().int(), limit: z.number().int(), resetsAt: z.iso.datetime() });
const UsageView = z.object({
  accountId: z.string(),
  plan: z.string(),
  requests: Counter,
  generations: Counter,
  rateLimit: z.object({
    requestsPerMinute: z.number().int(),
    burst: z.number().int(),
    maxConcurrent: z.number().int(),
  }),
});
const ProblemView = z
  .object({ type: z.string(), title: z.string(), status: z.number().int(), code: z.string() })
  .loose();

/** Answers and explanations are only released by grading. */
const presentAssessment = (a: Assessment) => ({
  id: a.id,
  topic: a.topic,
  locale: a.locale,
  createdAt: a.createdAt.toISOString(),
  expiresAt: a.expiresAt.toISOString(),
  questions: a.questions.map(({ q, o, d }, i) => ({ i, q, o, d })),
});

/** Internal error text stays in the logs; clients get a stable code. */
function jobError(job: Job) {
  if (job.status !== 'failed') return null;
  if (job.error?.startsWith('TopicRejectedError')) return 'topic_rejected' as const;
  if (job.error?.startsWith('BudgetExhaustedError')) return 'generation_capacity_exhausted' as const;
  return 'generation_failed' as const;
}

const presentJob = (job: Job) => ({
  jobId: job.id,
  status: job.status,
  assessmentId: job.assessmentId,
  error: jobError(job),
});

const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [code, ProblemView]));

export async function buildServer(options: ServerOptions) {
  const { service, limits, projectId } = options;
  const clock = options.clock ?? (() => new Date());

  const app = Fastify({
    loggerInstance: options.logger,
    // Only the proxies we deploy (Google LB, Cloud Run front end) may set the client IP.
    trustProxy: (_address, hop) => hop < options.trustedProxyHops,
    bodyLimit: 16 * 1024,
    requestTimeout: REQUEST_TIMEOUT_MS,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    // Client-supplied request ids are not trusted: they would let callers forge log correlation.
    genReqId: () => randomUUID(),
    routerOptions: { maxParamLength: 100 },
    childLoggerFactory: (logger, bindings, childOptions, rawReq) =>
      logger.child(
        { ...bindings, ...traceBindings(rawReq.headers['x-cloud-trace-context'], projectId) },
        childOptions,
      ),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // JSON only: no text/plain bodies.
  app.removeContentTypeParser('text/plain');

  app.setNotFoundHandler((_request, reply) => sendProblem(reply, { status: 404, code: 'not_found' }));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ProblemError) return sendProblem(reply, error.problem);
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendProblem(reply, {
        status: 400,
        code: 'invalid_request',
        detail: 'The request does not match the schema',
        extensions: {
          errors: error.validation.map((issue) => ({
            pointer: issue.instancePath || '/',
            detail: issue.message,
          })),
        },
      });
    }
    if (error instanceof QuotaExceededError) {
      return sendProblem(reply, {
        status: 429,
        code: 'generation_quota_exceeded',
        detail: `Daily limit of ${error.limit} new assessment generations reached; cached topics remain available`,
        retryAfterSeconds: (error.retryAt.getTime() - clock().getTime()) / 1000,
      });
    }
    if (error instanceof BudgetExhaustedError) {
      request.log.error('Daily LLM budget exhausted; new generations are paused');
      return sendProblem(reply, {
        status: 503,
        code: 'generation_capacity_exhausted',
        detail: 'New assessments cannot be generated right now; cached topics remain available',
        retryAfterSeconds: (error.retryAt.getTime() - clock().getTime()) / 1000,
      });
    }
    if (error instanceof TransientError) {
      request.log.warn({ err: error }, 'Dependency temporarily unavailable');
      return sendProblem(reply, {
        status: 503,
        code: 'service_unavailable',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'Response failed schema validation');
      return sendProblem(reply, { status: 500, code: 'internal_error' });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return sendProblem(reply, { status: error.statusCode, code: 'bad_request', detail: error.message });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return sendProblem(reply, { status: 500, code: 'internal_error' });
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Synapset Assessments API', version: '1.0.0' },
      components: {
        securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'synapset_sk_… API key' } },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });

  registerSecurity(app, {
    authenticator: options.authenticator,
    limits,
    usage: options.usage,
    authFailuresPerMinute: options.authFailuresPerMinute,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    clock,
  });

  app.get('/healthz', { logLevel: 'silent', schema: { hide: true } }, () => ({ status: 'ok' }));
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  app.post(
    '/v1/assessments',
    {
      config: { scope: 'assessments:write' },
      schema: {
        summary: 'Get the assessment for a topic, generating it on a cache miss',
        body: ResolveBody,
        response: { 200: ReadyView, 202: JobView, ...errors(400, 401, 403, 429, 503) },
      },
    },
    async (request, reply) => {
      const result = await service.resolve(
        request.body,
        request.principal as NonNullable<typeof request.principal>,
      );
      if (result.status === 'ready') {
        request.match = result.match;
        return reply.code(200).send({
          status: 'ready' as const,
          match: result.match,
          assessment: presentAssessment(result.assessment),
        });
      }
      request.generationQueued = true;
      return reply
        .code(202)
        .header('location', `/v1/jobs/${result.job.id}`)
        .header('retry-after', RETRY_AFTER_SECONDS)
        .send(presentJob(result.job));
    },
  );

  app.get(
    '/v1/assessments/:id',
    {
      config: { scope: 'assessments:read' },
      schema: { params: IdParams, response: { 200: AssessmentView, ...errors(401, 403, 404, 429) } },
    },
    async (request, reply) => {
      const assessment = await service.get(request.params.id);
      if (!assessment) return sendProblem(reply, { status: 404, code: 'not_found' });
      return reply.code(200).send(presentAssessment(assessment));
    },
  );

  app.post(
    '/v1/assessments/:id/grade',
    {
      config: { scope: 'assessments:grade' },
      schema: {
        params: IdParams,
        body: GradeBody,
        response: { 200: GradeView, ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const assessment = await service.get(request.params.id);
      if (!assessment) return sendProblem(reply, { status: 404, code: 'not_found' });
      const { answers } = request.body;
      if (answers.length !== assessment.questions.length) {
        return sendProblem(reply, {
          status: 400,
          code: 'invalid_request',
          detail: `Expected ${assessment.questions.length} answers, got ${answers.length}`,
        });
      }
      return reply.code(200).send(service.grade(assessment, answers));
    },
  );

  app.get(
    '/v1/jobs/:id',
    {
      config: { scope: 'assessments:read' },
      schema: { params: IdParams, response: { 200: JobView, ...errors(401, 403, 404, 429) } },
    },
    async (request, reply) => {
      const job = await service.getJob(request.params.id);
      if (!job) return sendProblem(reply, { status: 404, code: 'not_found' });
      if (job.status === 'pending' || job.status === 'running')
        reply.header('retry-after', RETRY_AFTER_SECONDS);
      return reply.code(200).send(presentJob(job));
    },
  );

  app.get(
    '/v1/usage',
    {
      config: { scope: 'assessments:read' },
      schema: {
        summary: 'Current usage against the plan',
        response: { 200: UsageView, ...errors(401, 403, 429, 503) },
      },
    },
    async (request, reply) => {
      const principal = request.principal as NonNullable<typeof request.principal>;
      const now = clock();
      const [requests, generations] = await Promise.all([
        limits.get(counterKeys.monthlyRequests(principal.accountId, now)),
        limits.get(counterKeys.dailyGenerations(principal.accountId, now)),
      ]);
      const { limits: plan } = principal;
      return reply.code(200).send({
        accountId: principal.accountId,
        plan: principal.plan,
        requests: {
          used: requests,
          limit: plan.requestsPerMonth,
          resetsAt: endOfUtcMonth(now).toISOString(),
        },
        generations: {
          used: generations,
          limit: plan.generationsPerDay,
          resetsAt: endOfUtcDay(now).toISOString(),
        },
        rateLimit: {
          requestsPerMinute: plan.requestsPerMinute,
          burst: plan.burst,
          maxConcurrent: plan.maxConcurrentRequests,
        },
      });
    },
  );

  return app;
}
