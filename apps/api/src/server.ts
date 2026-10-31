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
  AUDIENCES,
  LEVELS,
  LocaleSchema,
  MAX_CONTEXT_LENGTH,
  MAX_STYLE_LENGTH,
  MAX_TOPIC_LENGTH,
  POOL_LANGUAGES,
  QUESTION_TYPES,
  QuotaExceededError,
  REPORT_REASONS,
  REUSE_MODES,
  TONES,
  TransientError,
  counterKeys,
  endOfUtcDay,
  endOfUtcMonth,
  selectIndexes,
  traceBindings,
  type Assessment,
  type AssessmentService,
  type Authenticator,
  type Clock,
  type FeedbackService,
  type Job,
  type LimitStore,
  type Logger,
  type PoolLanguage,
  type PoolService,
  type UsageRecorder,
} from '@synapset/core';
import { ProblemError, sendProblem } from './problems.js';
import { DOCS_PREFIX, registerSecurity } from './security.js';

export interface ServerOptions {
  service: AssessmentService;
  pools: PoolService;
  feedback: FeedbackService;
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

/** The largest slice per level; plain assessments are held to the server's own, lower maximum. */
const MAX_QUESTIONS_PER_LEVEL = 50;
const QuestionsPerLevel = z
  .number()
  .int()
  .min(1)
  .max(MAX_QUESTIONS_PER_LEVEL)
  .describe(
    "Questions per difficulty level (three levels). Defaults to the server's maximum, which GET /v1/usage reports.",
  )
  .meta({ example: 5 });

const ResolveBody = z.strictObject({
  topic: z
    .string()
    .trim()
    .min(2)
    .max(MAX_TOPIC_LENGTH)
    .describe('What to assess. Equivalent phrasings resolve to the same cached assessment.')
    .meta({ example: 'TCP congestion control' }),
  context: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CONTEXT_LENGTH)
    .optional()
    .describe(
      'What to cover: focus areas, emphasis, what to avoid. Also steers which existing questions are reused. Different context is a different assessment.',
    )
    .meta({ example: 'Focus on taxes: deductions, credits and how income tax is calculated.' }),
  style: z
    .string()
    .trim()
    .min(1)
    .max(MAX_STYLE_LENGTH)
    .optional()
    .describe(
      'How to write: audience, tone, reading level, question format. Existing questions are reused only from assessments written in the same style.',
    )
    .meta({ example: 'For high-school students; use short real-life scenarios.' }),
  reuse: z
    .enum(REUSE_MODES)
    .default('auto')
    .describe(
      'auto: reuse relevant existing questions. strict: reuse only very close matches. off: always generate new questions (costs a generation).',
    ),
  locale: LocaleSchema.default('en').describe('Language of the questions'),
  ttlSeconds: z
    .number()
    .int()
    .min(3600)
    .optional()
    .describe('How long a newly generated assessment stays cached. Capped by the server.'),
  questionsPerLevel: QuestionsPerLevel.optional(),
});
const Cursor = z
  .string()
  .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, 'Expected a cursor returned by this API')
  .describe('The slice.nextCursor of the previous slice. Omit to start at the beginning of the pool.');
const NextBody = z.strictObject({
  topic: z
    .string()
    .trim()
    .min(2)
    .max(MAX_TOPIC_LENGTH)
    .describe('What to assess.')
    .meta({ example: 'PostgreSQL' }),
  context: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CONTEXT_LENGTH)
    .optional()
    .describe(
      'What the topic means here and what to cover. Part of what identifies the pool, so keep it stable and never put anything about a person in it.',
    )
    .meta({ example: 'The relational database, as used by software engineers.' }),
  locale: z
    .enum(POOL_LANGUAGES)
    .default('en')
    .describe('Language of the questions. Each language has its own pools, and so its own cap.'),
  audience: z.enum(AUDIENCES).default('adults').describe('Who the questions are written for'),
  tone: z.enum(TONES).default('neutral').describe('How the questions sound'),
  questionTypes: z
    .array(z.enum(QUESTION_TYPES))
    .min(1)
    .max(QUESTION_TYPES.length)
    .default(['conceptual', 'scenario'])
    .describe('The types to spread the questions across. A different set is a different pool.'),
  levels: z
    .array(z.union(LEVELS.map((level) => z.literal(level))))
    .min(1)
    .max(LEVELS.length)
    .default([...LEVELS])
    .describe('Difficulty levels to include: 1 (basic) to 3 (advanced)'),
  questionsPerLevel: QuestionsPerLevel,
  poolSize: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The most questions you want behind this topic, shared across the levels. Never raises the server cap, only lowers it for this request.',
    )
    .meta({ example: 100 }),
  cursor: Cursor.optional(),
  revisit: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(0)
    .describe('Earlier questions to mix in at random, counted within the slice.'),
  seed: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Varies the random part. The same request with the same seed returns the same slice, so a retry is safe; change it per attempt. Must not identify a person.',
    ),
});
const AssessmentQuery = z.strictObject({
  questionsPerLevel: z.coerce.number().pipe(QuestionsPerLevel).optional(),
});
const GradeBody = z.strictObject({
  questionsPerLevel: QuestionsPerLevel.optional().describe(
    'The count the assessment was fetched with; answers follow that selection',
  ),
  answers: z
    .array(z.number().int().min(0).max(3).nullable())
    .max(200)
    .describe('One entry per question, in order: the chosen option index (0-3), or null if unanswered')
    .meta({ example: [0, 2, null, 1] }),
});

const MAX_COMMENT_LENGTH = 500;
const FeedbackBody = z.strictObject({
  questionsPerLevel: QuestionsPerLevel.optional().describe(
    'The count the assessment was fetched with; i is a position in that selection',
  ),
  i: z.number().int().min(0).describe('Index of the question being reported'),
  reason: z.enum(REPORT_REASONS),
  comment: z
    .string()
    .trim()
    .max(MAX_COMMENT_LENGTH)
    .optional()
    .describe('Free text for reviewers. Stored only; never sent to a model.'),
});
const FeedbackView = z
  .object({
    status: z
      .enum(['recorded', 'duplicate'])
      .describe('duplicate: this account already reported the question; nothing changed'),
    quarantined: z
      .boolean()
      .describe('The question has enough reports to be withdrawn from reuse and from cached assessments'),
  })
  .describe('Report accepted');

const AssessmentView = z.object({
  id: Id,
  topic: z.string(),
  context: z.string().nullable(),
  style: z.string().nullable(),
  locale: z.string(),
  questionsPerLevel: z.number().int().describe('Questions per difficulty level in this response'),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().describe('After this the assessment is regenerated on the next request'),
  questions: z
    .array(
      z.object({
        i: z.number().int().describe('Question index'),
        q: z.string().describe('Question text'),
        o: z.array(z.string()).describe('Four options'),
        d: z.number().int().describe('Difficulty level: 1 (basic) to 3 (advanced)'),
        id: Id.optional().describe('Stable question id. Slices only.'),
        type: z.enum(QUESTION_TYPES).optional().describe('Question type. Slices only.'),
      }),
    )
    .describe('Answers and explanations are released only by grading'),
  slice: z
    .object({
      language: z.enum(POOL_LANGUAGES),
      audience: z.enum(AUDIENCES),
      tone: z.enum(TONES),
      mode: z
        .enum(['fresh', 'wrapping', 'random'])
        .describe(
          'fresh: new questions, plus any revisited. wrapping: the last new ones topped up with earlier ones. random: nothing new is left, so all are drawn at random.',
        ),
      nextCursor: Cursor.describe('Send this to continue after this slice'),
    })
    .optional()
    .describe('Set when the assessment is a slice of a pool'),
});
const ReadyView = z
  .object({
    status: z.literal('ready'),
    match: z
      .enum(['exact', 'semantic', 'composed'])
      .describe(
        'exact: same request seen before. semantic: an equivalent assessment exists. composed: assembled from existing questions on the subject, without generation.',
      ),
    assessment: AssessmentView,
  })
  .describe('Served from cache');
const SliceView = z
  .object({
    status: z.literal('ready'),
    pool: z.object({
      size: z.number().int().describe('Questions available to this request'),
      limit: z.number().int().describe('The most this request can reach: server caps and poolSize applied'),
      exhausted: z.boolean().describe('Nothing new is left after this slice'),
    }),
    assessment: AssessmentView,
  })
  .describe('A slice, served without generation');
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
    assessments: z.object({
      maxQuestionsPerLevel: z.number().int().describe('Highest questionsPerLevel a request may ask for'),
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

**Question count.** Pass \`questionsPerLevel\` to get fewer questions than the server generates (three difficulty levels, so \`5\` returns 15). Each topic is generated once at the maximum, so any count is served from the same cached assessment. Use the same count when fetching and grading.

**Question pools.** \`POST /v1/pools/next\` serves slices of a pool of questions kept per topic, language, audience, tone and difficulty. You hold the cursor; the service keeps nothing about your users. Questions are generated only when a slice needs ones that do not exist, and never again after that. Slices are assessments: fetch, grade and report them the same way.

**Answer checking.** Before an assessment is stored, a second model pass answers every question without the key. Questions it answers differently, or finds ambiguous, are discarded.

**Limits.** Every authenticated response carries \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\`. A \`429\` or \`503\` carries \`Retry-After\`.

**Errors.** Failures are \`application/problem+json\` (RFC 9457) with a stable \`code\` and a \`request_id\` that matches the \`X-Request-Id\` header.`;

/** Answers and explanations are only released by grading. */
const presentAssessment = (service: AssessmentService, a: Assessment, perLevel: number) => ({
  id: a.id,
  topic: a.topic,
  context: a.context,
  style: a.style,
  locale: a.locale,
  questionsPerLevel: perLevel,
  createdAt: a.createdAt.toISOString(),
  expiresAt: a.expiresAt.toISOString(),
  questions: service.questionsFor(a, perLevel).map(({ q, o, d, t }, i) => ({
    i,
    q,
    o,
    d,
    ...(a.slice ? { id: a.questionIds[selectIndexes(a.questions, perLevel)[i] as number] } : {}),
    ...(a.slice && t ? { type: t } : {}),
  })),
  ...(a.slice
    ? {
        slice: {
          language: a.locale as PoolLanguage,
          audience: a.slice.audience,
          tone: a.slice.tone,
          mode: a.slice.mode,
          nextCursor: a.slice.nextCursor,
        },
      }
    : {}),
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

  /** Requests may ask for fewer questions than were generated, never more. A slice has its own size. */
  const perLevel = (requested: number | undefined, assessment?: Assessment) => {
    const max = assessment?.slice?.questionsPerLevel ?? service.maxQuestionsPerLevel;
    if (requested === undefined) return max;
    if (requested > max) {
      throw new ProblemError({
        status: 400,
        code: 'invalid_request',
        detail: `questionsPerLevel must be at most ${max}`,
      });
    }
    return requested;
  };

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
        { name: 'Pools', description: 'Serve slices of long-lived question pools' },
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
          'Returns the cached assessment for the topic, matched verbatim or by meaning. On a miss, queues a generation and returns the job. Only a miss counts against the daily generation quota.\n\nEvery topic is generated once at the maximum size, so any questionsPerLevel up to it is served from the same cached assessment, at no extra generation cost. Pass the same questionsPerLevel when fetching and grading it.',
        body: ResolveBody,
        response: { 200: ReadyView, 202: JobView, ...errors(400, 401, 403, 429, 503) },
      },
    },
    async (request, reply) => {
      const count = perLevel(request.body.questionsPerLevel);
      const result = await service.resolve(
        request.body,
        request.principal as NonNullable<typeof request.principal>,
      );
      if (result.status === 'ready') {
        request.match = result.match;
        return reply.code(200).send({
          status: 'ready' as const,
          match: result.match,
          assessment: presentAssessment(service, result.assessment, count),
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

  app.post(
    '/v1/pools/next',
    {
      config: { scope: 'assessments:write' },
      schema: {
        operationId: 'nextPoolSlice',
        tags: ['Pools'],
        summary: 'Get the next slice of a question pool',
        description:
          'Returns the slice after the cursor, as an assessment to fetch, grade and report like any other. When the pool lacks new questions it first takes relevant ones from the bank, then queues a generation of only what is still missing and returns the job; when the job is done, send the same request again. Past the end of a pool, slices are drawn at random. Pool content lifetime and caps are server configuration and cannot be set per request.',
        body: NextBody,
        response: { 200: SliceView, 202: JobView, ...errors(400, 401, 403, 429, 503) },
      },
    },
    async (request, reply) => {
      const { questionTypes, ...body } = request.body;
      const result = await options.pools.next(
        { ...body, types: questionTypes },
        request.principal as NonNullable<typeof request.principal>,
      );
      if (result.status === 'ready') {
        request.match = 'pool';
        return reply.code(200).send({
          status: 'ready' as const,
          pool: result.pool,
          assessment: presentAssessment(
            service,
            result.assessment,
            result.assessment.slice?.questionsPerLevel ?? body.questionsPerLevel,
          ),
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
        description:
          'Questions and options only; answers and explanations are released by grading. A given questionsPerLevel always returns the same questions, in the same order.',
        params: IdParams,
        querystring: AssessmentQuery,
        response: { 200: AssessmentView, ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const assessment = await service.get(request.params.id);
      if (!assessment) return sendProblem(reply, { status: 404, code: 'not_found' });
      const count = perLevel(request.query.questionsPerLevel, assessment);
      return reply.code(200).send(presentAssessment(service, assessment, count));
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
      const count = perLevel(request.body.questionsPerLevel, assessment);
      const { answers } = request.body;
      const expected = service.questionsFor(assessment, count).length;
      if (answers.length !== expected) {
        return sendProblem(reply, {
          status: 400,
          code: 'invalid_request',
          detail: `Expected ${expected} answers, got ${answers.length}`,
        });
      }
      return reply.code(200).send(service.grade(assessment, count, answers));
    },
  );

  app.post(
    '/v1/assessments/:id/feedback',
    {
      config: { scope: 'assessments:read' },
      schema: {
        operationId: 'reportQuestion',
        tags: ['Assessments'],
        summary: 'Report a question',
        description:
          'Flags a question as wrong, ambiguous, off-topic or outdated. Each account can report a question once. A question reported by enough distinct accounts is withdrawn: it is never reused, and cached assessments containing it are rebuilt without it on their next request.',
        params: IdParams,
        body: FeedbackBody,
        response: { 202: FeedbackView, ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const { questionsPerLevel, i, reason, comment } = request.body;
      const assessment = await service.get(request.params.id);
      if (!assessment) return sendProblem(reply, { status: 404, code: 'not_found' });
      const count = perLevel(questionsPerLevel, assessment);
      const outcome = await options.feedback.report(
        { assessment, questionsPerLevel: count, index: i, reason, comment: comment || undefined },
        request.principal as NonNullable<typeof request.principal>,
      );
      if (outcome.status === 'not_found') {
        return sendProblem(reply, {
          status: 400,
          code: 'invalid_request',
          detail: `i must be below ${service.questionsFor(assessment, count).length}`,
        });
      }
      return reply.code(202).send({
        status: outcome.status,
        quarantined: outcome.status === 'recorded' && outcome.quarantined,
      });
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
        assessments: { maxQuestionsPerLevel: service.maxQuestionsPerLevel },
      });
    },
  );

  return app;
}
