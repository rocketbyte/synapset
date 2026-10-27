import type { Account, ApiKeyRecord, Principal } from './auth.js';
import type { LlmProviderName } from './config.js';
import type { PromptInput, VerifyInput } from './prompt.js';
import type { Assessment, GenerateMessage, Job, Question, TokenUsage } from './schemas.js';

export interface LlmCall {
  provider: LlmProviderName;
  model: string;
  usage: TokenUsage;
}

export interface GenerationResult extends LlmCall {
  /** As returned by the model: not yet checked for shape, duplicates or counts. */
  questions: Question[];
}

export interface Verdict {
  /** Index into the verified questions. */
  i: number;
  /** The option the checker chose, or -1 if it found none correct. */
  a: number;
  ok: boolean;
}

export interface VerificationResult extends LlmCall {
  verdicts: Verdict[];
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  generate(input: PromptInput): Promise<GenerationResult>;
  /** Answers the questions without the key, so the caller can drop those it disagrees with. */
  verify(input: VerifyInput): Promise<VerificationResult>;
}

export interface Embedder {
  readonly model: string;
  /** Returns a unit-length vector of EMBEDDING_DIMENSIONS values. */
  embed(text: string): Promise<number[]>;
}

export interface NearestMatch {
  assessment: Assessment;
  /** Cosine distance: 0 is identical. */
  distance: number;
}

export interface NewJob {
  id: string;
  topic: string;
  locale: string;
}

export type LeaseResult = { kind: 'acquired'; job: Job } | { kind: 'done' | 'busy' | 'missing' };

export interface AssessmentRepository {
  getAssessment(id: string): Promise<Assessment | null>;
  /** Nearest assessments in the scope within `maxDistance`, closest first. */
  findNearest(
    embedding: number[],
    scope: string,
    maxDistance: number,
    limit: number,
  ): Promise<NearestMatch[]>;
  getAlias(key: string): Promise<string | null>;
  saveAlias(key: string, assessmentId: string, expiresAt: Date): Promise<void>;
  saveAssessment(assessment: Assessment, embedding: number[]): Promise<void>;

  getJob(id: string): Promise<Job | null>;
  /** Creates or resets the job unless one is already in flight. `claimed` means the caller must publish. */
  claimJob(job: NewJob, now: Date, staleAfterMs: number): Promise<{ job: Job; claimed: boolean }>;
  acquireLease(id: string, now: Date, leaseMs: number): Promise<LeaseResult>;
  completeJob(id: string, assessmentId: string, now: Date): Promise<void>;
  releaseJob(id: string, error: string, now: Date): Promise<void>;
  failJob(id: string, error: string, now: Date): Promise<void>;
}

export interface JobQueue {
  publish(message: GenerateMessage): Promise<void>;
}

/** Structural match for lru-cache, so core does not depend on it. */
export interface AssessmentCache {
  get(key: string): Assessment | undefined;
  set(key: string, value: Assessment): unknown;
}

export type Clock = () => Date;

export interface AdmitRequest {
  rateKey: string;
  requestsPerMinute: number;
  burst: number;
  concurrencyKey: string;
  maxConcurrent: number;
  /** Unique per request; releases its concurrency slot. */
  token: string;
  /** Upper bound on a request's lifetime; slots older than this are reclaimed. */
  concurrencyTtlMs: number;
  quotaKey: string;
  quotaLimit: number;
  quotaExpiresAt: Date;
}

export type AdmitDecision =
  | { allowed: true; remaining: number; resetMs: number; quotaUsed: number }
  | {
      allowed: false;
      reason: 'rate' | 'concurrency' | 'quota';
      retryAfterMs: number;
      remaining: number;
      resetMs: number;
    };

/** Distributed counters. Every operation is atomic across API and worker instances. */
export interface LimitStore {
  /** Rate (token bucket), concurrency and quota checked together; nothing is consumed unless all pass. */
  admit(request: AdmitRequest): Promise<AdmitDecision>;
  release(concurrencyKey: string, token: string): Promise<void>;
  /** Adds `amount` if the result stays within `limit`. */
  consume(
    key: string,
    amount: number,
    limit: number,
    expiresAt: Date,
  ): Promise<{ allowed: boolean; used: number }>;
  /** Unconditional add (negative to refund); returns the new value. */
  add(key: string, amount: number, expiresAt: Date): Promise<number>;
  get(key: string): Promise<number>;
  /** Fixed-window hit counter; returns the count within the window. */
  hit(key: string, windowMs: number): Promise<number>;
}

export interface IdentityRepository {
  findKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  findKeyById(keyId: string): Promise<ApiKeyRecord | null>;
  listKeys(accountId: string): Promise<ApiKeyRecord[]>;
  saveKey(record: ApiKeyRecord): Promise<void>;
  revokeKey(keyId: string, now: Date): Promise<boolean>;
  getAccount(id: string): Promise<Account | null>;
  saveAccount(account: Account): Promise<void>;
}

interface UsageEventBase {
  event_id: string;
  /** Microseconds since the Unix epoch (BigQuery TIMESTAMP). */
  occurred_at: number;
  account_id: string;
}

export type UsageEvent =
  | (UsageEventBase & {
      event: 'api.request';
      key_id: string;
      request_id: string;
      method: string;
      route: string;
      status: number;
      latency_ms: number;
      match: 'exact' | 'semantic' | null;
      generation_queued: boolean;
    })
  | (UsageEventBase & {
      event: 'llm.generation';
      job_id: string;
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    });

/** Durable usage metering for billing. Never throws: metering must not fail the request it meters. */
export interface UsageRecorder {
  record(event: UsageEvent): void;
  flush(): Promise<void>;
}

export interface GenerationReservation {
  release(): Promise<void>;
}

/** Decides whether a caller may trigger a new (paid) LLM generation. */
export interface GenerationGate {
  reserve(principal: Principal): Promise<GenerationReservation>;
}
