import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
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
import { DOCS_PREFIX, registerSecurity } from './security.js';

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

const Id = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Invalid id')
  .describe('64 hex characters')
  .meta({ example: '3f9a1c0e5b7d2a4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d' });
const IdParams = z.strictObject({ id: Id });

const ResolveBody = z.strictObject({
  topic: z
    .string()
    .trim()
    .min(2)
    .max(MAX_TOPIC_LENGTH)
    .describe('What to assess. Equivalent phrasings resolve to the same cached assessment.')
    .meta({ example: 'TCP congestion control' }),
  locale: LocaleSchema.default('en').describe('Language of the questions'),
  ttlSeconds: z
    .number()
    .int()
    .min(3600)
    .optional()
    .describe('How long a newly generated assessment stays cached. Capped by the server.'),
});
const GradeBody = z.strictObject({
  answers: z
    .array(z.number().int().min(0).max(3).nullable())
    .max(200)
    .describe('One entry per question, in order: the chosen option index (0-3), or null if unanswered')
    .meta({ example: [0, 2, null, 1] }),
});

const AssessmentView = z.object({
  id: Id,
  topic: z.string(),
  locale: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().describe('After this the assessment is regenerated on the next request'),
  questions: z
    .array(
      z.object({
        i: z.number().int().describe('Question index'),
        q: z.string().describe('Question text'),
        o: z.array(z.string()).describe('Four options'),
        d: z.number().int().describe('Difficulty level: 1 (basic) to 3 (advanced)'),
      }),
    )
    .describe('Answers and explanations are released only by grading'),
});
const ReadyView = z
  .object({
    status: z.literal('ready'),
    match: z.enum(['exact', 'semantic']).describe('Whether the topic matched verbatim or by meaning'),
    assessment: AssessmentView,
  })
  .describe('Served from cache');
const JobView = z
  .object({
    jobId: Id,
    status: z.enum(['pending', 'running', 'done', 'failed']),
    assessmentId: Id.nullable().describe('Set once status is done'),
    error: z
      .enum(['topic_rejected', 'generation_capacity_exhausted', 'generation_failed'])
      .nullable()
      .describe('Set once status is failed'),
  })
  .describe('Generation job; poll it until status is done or failed');
const GradeView = z
  .object({
    score: z.number().int(),
    total: z.number().int(),
    results: z.array(
      z.object({
        i: z.number().int().describe('Question index'),
        correct: z.boolean(),
        a: z.number().int().describe('Index of the correct option'),
        e: z.string().describe('Explanation'),
      }),
    ),
  })
  .describe('Grading result');
const Counter = z.object({ used: z.number().int(), limit: z.number().int(), resetsAt: z.iso.datetime() });
const UsageView = z
  .object({
    accountId: z.string(),
    plan: z.string(),
    requests: Counter.describe('Requests this calendar month (UTC)'),
    generations: Counter.describe('New assessment generations today (UTC)'),
    rateLimit: z.object({
      requestsPerMinute: z.number().int(),
      burst: z.number().int(),
      maxConcurrent: z.number().int(),
    }),
  })
  .describe('Usage against the plan');
const ProblemView = z
  .object({
    type: z.string().meta({ example: 'urn:synapset:problem:rate_limited' }),
    title: z.string(),
    status: z.number().int(),
    code: z.string().describe('Stable machine-readable error code'),
  })
  .loose()
  .describe('Problem details (RFC 9457), served as application/problem+json');

const API_DESCRIPTION = `Turns a topic into a multiple-choice knowledge assessment with three difficulty levels, and grades the answers.

**Authentication.** Send an API key as \`Authorization: Bearer synapset_sk_…\`. Each key carries scopes: \`assessments:read\`, \`assessments:write\`, \`assessments:grade\`.

**Asynchronous generation.** \`POST /v1/assessments\` answers \`200\` when the topic is cached. On a miss it answers \`202\` with a job: poll \`GET /v1/jobs/{id}\` (honouring \`Retry-After\`) until it is \`done\`, then fetch \`GET /v1/assessments/{assessmentId}\`.

**Limits.** Every authenticated response carries \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\`. A \`429\` or \`503\` carries \`Retry-After\`.

**Errors.** Failures are \`application/problem+json\` (RFC 9457) with a stable \`code\` and a \`request_id\` that matches the \`X-Request-Id\` header.`;

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
      info: { title: 'Synapset Assessments API', version: '1.0.0', description: API_DESCRIPTION },
      tags: [
        { name: 'Assessments', description: 'Resolve, fetch and grade assessments' },
        { name: 'Jobs', description: 'Track generation of new assessments' },
        { name: 'Usage', description: 'Consumption against the plan' },
      ],
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

  await app.register(scalar, {
    routePrefix: DOCS_PREFIX,
    logLevel: 'silent',
    // Self-hosted: the page loads nothing from third parties, which keeps its CSP tight.
    configuration: {
      pageTitle: 'Synapset API Reference',
      withDefaultFonts: false,
      telemetry: false,
      showDeveloperTools: 'never',
      mcp: { disabled: true },
      agent: { disabled: true },
    },
  });

  // Not /healthz: Cloud Run reserves paths ending in "z" and never routes them to the container.
  app.get('/health', { logLevel: 'silent', schema: { hide: true } }, () => ({ status: 'ok' }));
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  app.post(
    '/v1/assessments',
    {
      config: { scope: 'assessments:write' },
      schema: {
        operationId: 'resolveAssessment',
        tags: ['Assessments'],
        summary: 'Resolve a topic',
        description:
          'Returns the cached assessment for the topic, matched verbatim or by meaning. On a miss, queues a generation and returns the job. Only a miss counts against the daily generation quota.',
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
      schema: {
        operationId: 'getAssessment',
        tags: ['Assessments'],
        summary: 'Get an assessment',
        description: 'Questions and options only; answers and explanations are released by grading.',
        params: IdParams,
        response: { 200: AssessmentView, ...errors(401, 403, 404, 429) },
      },
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
        operationId: 'gradeAssessment',
        tags: ['Assessments'],
        summary: 'Grade answers',
        description:
          'Scores the answers and returns the correct option and an explanation for every question.',
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
      schema: {
        operationId: 'getJob',
        tags: ['Jobs'],
        summary: 'Get a generation job',
        description:
          'Poll until status is done or failed. While pending or running, the response carries Retry-After.',
        params: IdParams,
        response: { 200: JobView, ...errors(401, 403, 404, 429) },
      },
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
        operationId: 'getUsage',
        tags: ['Usage'],
        summary: 'Get usage',
        description: "The calling account's consumption against its plan's quotas and rate limits.",
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
