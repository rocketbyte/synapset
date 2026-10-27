import { createHash, randomUUID } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  counterKeys,
  endOfUtcMonth,
  parseBearerKey,
  type Authenticator,
  type Clock,
  type LimitStore,
  type Logger,
  type Principal,
  type Scope,
  type UsageRecorder,
} from '@synapset/core';
import { ProblemError } from './problems.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Routes without a scope are public (health, OpenAPI document). */
    scope?: Scope;
  }
  interface FastifyRequest {
    principal: Principal | null;
    /** Concurrency slot held by this request; released when the response is sent. */
    slot: string | null;
    match: 'exact' | 'semantic' | null;
    generationQueued: boolean;
  }
}

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger,
  ZodTypeProvider
>;

export interface SecurityOptions {
  authenticator: Authenticator;
  limits: LimitStore;
  usage: UsageRecorder;
  authFailuresPerMinute: number;
  /** Upper bound on a request's lifetime; an orphaned concurrency slot is reclaimed after it. */
  requestTimeoutMs: number;
  clock?: Clock;
}

const REALM = 'Bearer realm="synapset"';

/** Every response is API data: never cached, never framed, never sniffed or rendered as a document. */
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/** The API reference (Scalar) is the one HTML surface; it is public and self-hosted. */
export const DOCS_PREFIX = '/docs';

/** Same posture for the reference page, relaxed only as far as rendering it needs: no third-party origins. */
const DOCS_HEADERS = {
  ...SECURITY_HEADERS,
  'cache-control': 'public, max-age=300',
  'content-security-policy': docsPolicy([]),
};

function docsPolicy(scriptHashes: string[]) {
  return [
    "default-src 'none'",
    `script-src 'self'${scriptHashes.map((hash) => ` '${hash}'`).join('')}`,
    // The bundle injects its stylesheet at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // "Test request" calls this API from the page.
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

/** Allows exactly the inline scripts the page was rendered with, so no 'unsafe-inline' is needed. */
function inlineScriptHashes(html: string) {
  return [...html.matchAll(INLINE_SCRIPT)].map(
    ([, body]) =>
      `sha256-${createHash('sha256')
        .update(body ?? '')
        .digest('base64')}`,
  );
}

const isDocsRoute = (url: string | undefined) =>
  url === DOCS_PREFIX || (url?.startsWith(`${DOCS_PREFIX}/`) ?? false);

/**
 * Request pipeline for every scoped route:
 * 1. authenticate the Bearer API key (failed attempts are throttled per client IP);
 * 2. authorize the route's scope;
 * 3. admit against the account's plan in one atomic step: rate (token bucket), concurrency, monthly quota;
 * 4. on response, release the concurrency slot and meter the request for billing.
 */
export function registerSecurity(app: App, options: SecurityOptions) {
  const { authenticator, limits, usage } = options;
  const clock = options.clock ?? (() => new Date());

  app.decorateRequest('principal', null);
  app.decorateRequest('slot', null);
  app.decorateRequest('match', null);
  app.decorateRequest('generationQueued', false);

  app.addHook('onRequest', async (request, reply) => {
    const headers = isDocsRoute(request.routeOptions.url) ? DOCS_HEADERS : SECURITY_HEADERS;
    reply.headers({ ...headers, 'x-request-id': request.id });
    const scope = request.routeOptions.config.scope;
    if (!scope) return;

    const principal = await authenticate(request, reply);
    if (!principal.scopes.has(scope)) {
      reply.header('www-authenticate', `${REALM}, error="insufficient_scope", scope="${scope}"`);
      throw new ProblemError({
        status: 403,
        code: 'insufficient_scope',
        detail: `This key lacks the ${scope} scope`,
      });
    }
    request.principal = principal;
    await admit(request, reply, principal);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload === 'string' && isDocsRoute(request.routeOptions.url) && payload.includes('<script')) {
      reply.header('content-security-policy', docsPolicy(inlineScriptHashes(payload)));
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const { principal, slot } = request;
    if (!principal) return;
    if (slot) {
      await limits.release(counterKeys.concurrency(principal.accountId), slot).catch((error: unknown) => {
        request.log.warn({ err: error }, 'Failed to release concurrency slot; it expires on its own');
      });
    }
    usage.record({
      event: 'api.request',
      event_id: randomUUID(),
      occurred_at: clock().getTime() * 1000,
      account_id: principal.accountId,
      key_id: principal.keyId,
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unknown',
      status: reply.statusCode,
      latency_ms: Math.round(reply.elapsedTime),
      match: request.match,
      generation_queued: request.generationQueued,
    });
  });

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<Principal> {
    const presented = request.headers.authorization;
    const key = parseBearerKey(presented);
    const principal = key ? await authenticator.authenticate(key) : null;
    if (principal) {
      request.log = request.log.child({ accountId: principal.accountId, keyId: principal.keyId });
      return principal;
    }

    const failures = await limits
      .hit(counterKeys.authFailures(request.ip), 60_000)
      .catch((error: unknown) => {
        request.log.warn({ err: error }, 'Auth failure throttle unavailable');
        return 0;
      });
    if (failures > options.authFailuresPerMinute) {
      throw new ProblemError({ status: 429, code: 'too_many_auth_failures', retryAfterSeconds: 60 });
    }
    reply.header('www-authenticate', presented ? `${REALM}, error="invalid_token"` : REALM);
    throw new ProblemError({
      status: 401,
      code: 'unauthorized',
      detail: presented
        ? 'The API key is invalid, expired or revoked'
        : 'Send the API key as "Authorization: Bearer <key>"',
    });
  }

  async function admit(request: FastifyRequest, reply: FastifyReply, principal: Principal) {
    const { limits: plan, accountId } = principal;
    const now = clock();
    const token = randomUUID();
    let decision;
    try {
      decision = await limits.admit({
        rateKey: counterKeys.rate(accountId),
        requestsPerMinute: plan.requestsPerMinute,
        burst: plan.burst,
        concurrencyKey: counterKeys.concurrency(accountId),
        maxConcurrent: plan.maxConcurrentRequests,
        token,
        concurrencyTtlMs: options.requestTimeoutMs * 2,
        quotaKey: counterKeys.monthlyRequests(accountId, now),
        quotaLimit: plan.requestsPerMonth,
        quotaExpiresAt: endOfUtcMonth(now),
      });
    } catch (error) {
      // Fail open: request limits protect capacity, and Cloud Armor still rate-limits at the edge.
      // LLM spend is never admitted without the store (see SpendGuard).
      request.log.warn({ err: error }, 'Limit store unavailable; admitting request without limits');
      return;
    }

    reply.headers({
      'ratelimit-limit': plan.burst,
      'ratelimit-remaining': decision.remaining,
      'ratelimit-reset': Math.ceil(decision.resetMs / 1000),
    });
    if (decision.allowed) {
      request.slot = token;
      return;
    }
    const retryAfterSeconds = decision.retryAfterMs / 1000;
    if (decision.reason === 'quota') {
      throw new ProblemError({
        status: 429,
        code: 'request_quota_exceeded',
        detail: `Monthly quota of ${plan.requestsPerMonth} requests reached`,
        retryAfterSeconds,
      });
    }
    throw new ProblemError({
      status: 429,
      code: decision.reason === 'rate' ? 'rate_limited' : 'too_many_concurrent_requests',
      retryAfterSeconds,
    });
  }
}
