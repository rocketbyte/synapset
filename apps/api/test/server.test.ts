import { describe, expect, it } from 'vitest';
import {
  AssessmentService,
  Authenticator,
  FeedbackService,
  LogUsageRecorder,
  MemoryLimitStore,
  SpendGuard,
  counterKeys,
  createLogger,
  generateApiKey,
  toMicroUsd,
  type PlanLimits,
  type Scope,
} from '@synapset/core';
import {
  FakeEmbedder,
  FakeQueue,
  InMemoryIdentityRepository,
  InMemoryRepository,
  assessment,
  questions,
} from '../../../packages/core/test/fakes.js';
import { buildServer } from '../src/server.js';

const ALL_SCOPES: Scope[] = ['assessments:read', 'assessments:write', 'assessments:grade'];

async function setup(
  options: {
    scopes?: Scope[];
    limits?: Partial<PlanLimits>;
    budgetUsd?: number;
    questionsPerLevel?: number;
    quarantineAfterReports?: number;
  } = {},
) {
  const repo = new InMemoryRepository();
  const identities = new InMemoryIdentityRepository();
  const limits = new MemoryLimitStore();
  const usage = new LogUsageRecorder();
  const { key, keyId, hash } = generateApiKey();
  await identities.saveAccount({
    id: 'acct_1',
    name: 'Acme',
    plan: 'pro',
    status: 'active',
    limitOverrides: options.limits ?? {},
    createdAt: new Date(),
  });
  await identities.saveKey({
    keyId,
    hash,
    accountId: 'acct_1',
    name: 'test',
    scopes: options.scopes ?? ALL_SCOPES,
    status: 'active',
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  });

  const service = new AssessmentService(
    repo,
    new FakeEmbedder(),
    new FakeQueue(),
    new SpendGuard(limits, options.budgetUsd ?? 10),
    {
      questionsPerLevel: options.questionsPerLevel ?? 1,
      similarityThreshold: 0.88,
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 7200,
      jobStaleSeconds: 900,
    },
  );
  const app = await buildServer({
    service,
    feedback: new FeedbackService(
      repo,
      { quarantineAfterReports: options.quarantineAfterReports ?? 2 },
      createLogger('test', 'silent'),
    ),
    authenticator: new Authenticator(identities),
    limits,
    usage,
    logger: createLogger('test', 'silent'),
    projectId: 'p',
    trustedProxyHops: 1,
    authFailuresPerMinute: 3,
  });
  const auth = { authorization: `Bearer ${key}` };
  return { app, repo, limits, usage, auth };
}

describe('authentication', () => {
  it('requires a Bearer key and answers with RFC 9457 problems', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url: '/v1/assessments', payload: { topic: 'Rust' } });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="synapset"');
    expect(response.json()).toMatchObject({ status: 401, code: 'unauthorized', instance: '/v1/assessments' });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('rejects unknown keys and throttles repeated failures per IP', async () => {
    const { app } = await setup();
    const attempt = () =>
      app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: { authorization: `Bearer ${generateApiKey().key}` },
      });

    const first = await attempt();
    expect(first.statusCode).toBe(401);
    expect(first.headers['www-authenticate']).toContain('error="invalid_token"');
    await attempt();
    await attempt();
    const throttled = await attempt();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ code: 'too_many_auth_failures' });
  });

  it('enforces route scopes', async () => {
    const { app, auth } = await setup({ scopes: ['assessments:read'] });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: auth,
      payload: { topic: 'Rust ownership' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'insufficient_scope' });
  });
});

describe('limits and metering', () => {
  it('sends rate limit headers and throttles past the burst', async () => {
    const { app, auth } = await setup({ limits: { burst: 2, requestsPerMinute: 1 } });
    const call = () => app.inject({ method: 'GET', url: '/v1/usage', headers: auth });

    const ok = await call();
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['ratelimit-limit']).toBe('2');
    expect(ok.headers['ratelimit-remaining']).toBe('1');
    await call();
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('enforces the monthly request quota', async () => {
    const { app, auth } = await setup({ limits: { requestsPerMonth: 1 } });
    expect((await app.inject({ method: 'GET', url: '/v1/usage', headers: auth })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth });
    expect(denied.statusCode).toBe(429);
    expect(denied.json()).toMatchObject({ code: 'request_quota_exceeded' });
  });

  it('releases concurrency slots and records a usage event per request', async () => {
    const { app, auth, usage } = await setup({ limits: { maxConcurrentRequests: 1 } });
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: 'GET', url: '/v1/usage', headers: auth })).statusCode).toBe(200);
    }
    expect(usage.events).toHaveLength(3);
    expect(usage.events[0]).toMatchObject({
      event: 'api.request',
      account_id: 'acct_1',
      route: '/v1/usage',
      status: 200,
    });
  });

  it('reports usage against the plan', async () => {
    const { app, auth } = await setup();
    const response = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth });
    expect(response.json()).toMatchObject({
      accountId: 'acct_1',
      plan: 'pro',
      requests: { used: 1, limit: 1_000_000 },
      generations: { used: 0, limit: 1_000 },
    });
  });

  it('returns 503 with Retry-After once the LLM budget is spent', async () => {
    const { app, auth, limits } = await setup({ budgetUsd: 1 });
    await limits.add(counterKeys.dailySpend(new Date()), toMicroUsd(1), new Date(Date.now() + 172_800_000));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: auth,
      payload: { topic: 'Rust ownership' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'generation_capacity_exhausted' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('returns 429 once the daily generation quota is used', async () => {
    const { app, auth } = await setup({ limits: { generationsPerDay: 1 } });
    const resolve = (topic: string) =>
      app.inject({ method: 'POST', url: '/v1/assessments', headers: auth, payload: { topic } });
    expect((await resolve('Rust ownership')).statusCode).toBe(202);
    const denied = await resolve('Go channels');
    expect(denied.statusCode).toBe(429);
    expect(denied.json()).toMatchObject({ code: 'generation_quota_exceeded' });
  });
});

describe('assessments', () => {
  it('returns 202 with a job location on a miss', async () => {
    const { app, auth } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: auth,
      payload: { topic: 'Rust ownership' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toMatch(/^\/v1\/jobs\/[a-f0-9]{64}$/);
    expect(response.headers['retry-after']).toBe('3');
    expect(response.json()).toMatchObject({ status: 'pending' });
  });

  it('accepts context, keeps it in the assessment identity and bounds its length', async () => {
    const { app, auth } = await setup();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/v1/assessments', headers: auth, payload });

    const plain = await post({ topic: 'Finance' });
    const focused = await post({ topic: 'Finance', context: 'Focus on taxes and deductions' });
    expect(focused.statusCode).toBe(202);
    expect(focused.json<{ jobId: string }>().jobId).not.toBe(plain.json<{ jobId: string }>().jobId);

    const tooLong = await post({ topic: 'Finance', context: 'x'.repeat(1001) });
    expect(tooLong.statusCode).toBe(400);
  });

  it('accepts style and reuse, each making a distinct assessment', async () => {
    const { app, auth } = await setup();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/v1/assessments', headers: auth, payload });
    const ids = await Promise.all(
      [
        { topic: 'Finance' },
        { topic: 'Finance', style: 'For kids.' },
        { topic: 'Finance', reuse: 'off' },
      ].map(async (payload) => (await post(payload)).json<{ jobId: string }>().jobId),
    );
    expect(new Set(ids).size).toBe(3);
    // Style is compared by its words.
    const same = await post({ topic: 'Finance', style: 'for KIDS' });
    expect(same.json<{ jobId: string }>().jobId).toBe(ids[1]);

    expect((await post({ topic: 'Finance', reuse: 'sometimes' })).statusCode).toBe(400);
  });

  it('records reports once per account and quarantines a question at the threshold', async () => {
    const { app, repo, auth } = await setup({ quarantineAfterReports: 1 });
    const target = assessment({ expiresAt: new Date(Date.now() + 60_000) });
    repo.assessments.set(target.id, target);
    const report = (payload: object) =>
      app.inject({ method: 'POST', url: `/v1/assessments/${target.id}/feedback`, headers: auth, payload });

    const first = await report({ i: 1, reason: 'wrong_answer', comment: 'Option 2 is also correct' });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ status: 'recorded', quarantined: true });
    expect([...repo.bank.values()]).toEqual([
      expect.objectContaining({ q: target.questions[1]?.q, status: 'quarantined', reports: 1 }),
    ]);
    // The reported assessment is withdrawn, so the next request rebuilds it without that question.
    expect(repo.assessments.get(target.id)?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    repo.assessments.set(target.id, target);
    expect((await report({ i: 1, reason: 'ambiguous' })).json()).toEqual({
      status: 'duplicate',
      quarantined: false,
    });
    expect((await report({ i: 3, reason: 'other' })).statusCode).toBe(400);
    expect((await report({ i: 0, reason: 'boring' })).statusCode).toBe(400);
  });

  it('rejects invalid and unexpected input', async () => {
    const { app, auth } = await setup();
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: auth,
      payload: { topic: 'x', locale: 'english' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_request' });

    const extra = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: auth,
      payload: { topic: 'Rust ownership', admin: true },
    });
    expect(extra.statusCode).toBe(400);

    const text = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: { ...auth, 'content-type': 'text/plain' },
      payload: 'topic=Rust',
    });
    expect(text.statusCode).toBe(415);

    const poisoned = await app.inject({
      method: 'POST',
      url: '/v1/assessments',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{"topic":"Rust ownership","__proto__":{"x":1}}',
    });
    expect(poisoned.statusCode).toBe(400);
  });

  it('hides answers until grading', async () => {
    const { app, repo, auth } = await setup();
    const target = assessment({ expiresAt: new Date(Date.now() + 60_000) });
    repo.assessments.set(target.id, target);

    const fetched = await app.inject({ method: 'GET', url: `/v1/assessments/${target.id}`, headers: auth });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ questions: object[] }>().questions[0]).not.toHaveProperty('a');
    expect(fetched.json()).not.toHaveProperty('usage');

    const graded = await app.inject({
      method: 'POST',
      url: `/v1/assessments/${target.id}/grade`,
      headers: auth,
      payload: { answers: target.questions.map((q) => q.a) },
    });
    expect(graded.json()).toMatchObject({ score: 3, total: 3 });
  });

  it('serves any question count up to the generated size from the same assessment', async () => {
    const { app, repo, auth } = await setup({ questionsPerLevel: 3 });
    const target = assessment({ questions: questions(3), expiresAt: new Date(Date.now() + 60_000) });
    repo.assessments.set(target.id, target);
    const url = `/v1/assessments/${target.id}`;

    const full = await app.inject({ method: 'GET', url, headers: auth });
    expect(full.json()).toMatchObject({ questionsPerLevel: 3 });
    expect(full.json<{ questions: object[] }>().questions).toHaveLength(9);

    const small = await app.inject({ method: 'GET', url: `${url}?questionsPerLevel=2`, headers: auth });
    const view = small.json<{
      questionsPerLevel: number;
      questions: { i: number; q: string; d: number }[];
    }>();
    expect(view.questionsPerLevel).toBe(2);
    expect(view.questions.map((q) => [q.i, q.d])).toEqual([
      [0, 1],
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 3],
      [5, 3],
    ]);

    const selected = view.questions.map(({ q }) => target.questions.find((t) => t.q === q)?.a ?? null);
    const graded = await app.inject({
      method: 'POST',
      url: `${url}/grade`,
      headers: auth,
      payload: { questionsPerLevel: 2, answers: selected },
    });
    expect(graded.json()).toMatchObject({ score: 6, total: 6 });

    const tooMany = await app.inject({ method: 'GET', url: `${url}?questionsPerLevel=4`, headers: auth });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toMatchObject({ detail: 'questionsPerLevel must be at most 3' });

    const miscounted = await app.inject({
      method: 'POST',
      url: `${url}/grade`,
      headers: auth,
      payload: { answers: selected },
    });
    expect(miscounted.statusCode).toBe(400);

    const usage = await app.inject({ method: 'GET', url: '/v1/usage', headers: auth });
    expect(usage.json()).toMatchObject({ assessments: { maxQuestionsPerLevel: 3 } });
  });

  it('sets security headers and returns problems for unknown routes', async () => {
    const { app, auth } = await setup();
    const response = await app.inject({ method: 'GET', url: '/v1/nope', headers: auth });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publishes an OpenAPI document with the bearer scheme', async () => {
    const { app } = await setup();
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/assessments', '/v1/assessments/{id}', '/v1/jobs/{id}', '/v1/usage']),
    );
    expect(spec.components.securitySchemes).toHaveProperty('apiKey');
    expect(Object.keys(spec.paths).some((path) => path.startsWith('/docs'))).toBe(false);
  });

  it('serves a self-hosted API reference without authentication', async () => {
    const { app } = await setup();
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
    expect(csp).not.toContain('http');
    expect(csp).toContain("connect-src 'self'");

    const script = await app.inject({ method: 'GET', url: '/docs/js/scalar.js' });
    expect(script.statusCode).toBe(200);
    const spec = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(spec.json()).toMatchObject({ info: { title: 'Synapset Assessments API' } });

    // The API itself keeps the strict policy.
    const api = await app.inject({ method: 'GET', url: '/v1/usage' });
    expect(api.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
