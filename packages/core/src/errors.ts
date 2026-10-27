/** Retrying may succeed (rate limit, timeout, 5xx, unusable LLM output). Pub/Sub redelivers. */
export class TransientError extends Error {
  override name = 'TransientError';
}

/** Retrying will not help (bad input, refused topic, misconfiguration). The job is marked failed. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

/** The provider cannot serve any request (credits exhausted, auth, permission). Triggers LLM failover. */
export class ProviderUnavailableError extends PermanentError {
  override name = 'ProviderUnavailableError';
}

/** The LLM returned output that failed parsing or validation. */
export class InvalidOutputError extends TransientError {
  override name = 'InvalidOutputError';
}

/** The LLM judged the topic not to be a legitimate subject of knowledge. */
export class TopicRejectedError extends PermanentError {
  override name = 'TopicRejectedError';
}

/** Service-wide daily LLM budget reached; new generations resume at `retryAt`. */
export class BudgetExhaustedError extends PermanentError {
  override name = 'BudgetExhaustedError';
  constructor(readonly retryAt: Date) {
    super(`Daily LLM budget exhausted until ${retryAt.toISOString()}`);
  }
}

/** An account exceeded one of its plan quotas. */
export class QuotaExceededError extends Error {
  override name = 'QuotaExceededError';
  constructor(
    readonly quota: 'requests_per_month' | 'generations_per_day',
    readonly limit: number,
    readonly retryAt: Date,
  ) {
    super(`Quota ${quota} (${limit}) exceeded until ${retryAt.toISOString()}`);
  }
}
