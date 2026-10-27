import type { Logger } from 'pino';
import { ProviderUnavailableError } from '../../errors.js';
import type { PromptInput } from '../../prompt.js';
import type { Clock, GenerationResult, LlmProvider } from '../../ports.js';

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

  async generate(input: PromptInput): Promise<GenerationResult> {
    if (this.clock().getTime() < this.primaryDownUntil) return this.fallback.generate(input);
    try {
      return await this.primary.generate(input);
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      this.primaryDownUntil = this.clock().getTime() + COOLDOWN_MS;
      this.logger.error(
        { err: error, primary: this.primary.name, fallback: this.fallback.name },
        'LLM provider unavailable; failing over',
      );
      return this.fallback.generate(input);
    }
  }
}
