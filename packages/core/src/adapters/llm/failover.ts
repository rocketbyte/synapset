import type { Logger } from 'pino';
import { ProviderUnavailableError } from '../../errors.js';
import type { PromptInput, VerifyInput } from '../../prompt.js';
import type { Clock, GenerationResult, LlmProvider, VerificationResult } from '../../ports.js';

const COOLDOWN_MS = 5 * 60_000;

/**
 * Uses `primary` until it reports it cannot serve requests (e.g. credits exhausted), then routes to
 * `fallback` for a cooldown period before probing the primary again.
 */
export class FailoverLlmProvider implements LlmProvider {
  private primaryDownUntil = 0;

  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
    private readonly logger: Logger,
    private readonly clock: Clock = () => new Date(),
  ) {}

  get name() {
    return this.primary.name;
  }

  generate(input: PromptInput): Promise<GenerationResult> {
    return this.route((provider) => provider.generate(input));
  }

  verify(input: VerifyInput): Promise<VerificationResult> {
    return this.route((provider) => provider.verify(input));
  }

  private async route<T>(call: (provider: LlmProvider) => Promise<T>): Promise<T> {
    if (this.clock().getTime() < this.primaryDownUntil) return call(this.fallback);
    try {
      return await call(this.primary);
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      this.primaryDownUntil = this.clock().getTime() + COOLDOWN_MS;
      this.logger.error(
        { err: error, primary: this.primary.name, fallback: this.fallback.name },
        'LLM provider unavailable; failing over',
      );
      return call(this.fallback);
    }
  }
}
