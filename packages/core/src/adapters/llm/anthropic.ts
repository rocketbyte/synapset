import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  InvalidOutputError,
  PermanentError,
  ProviderUnavailableError,
  TopicRejectedError,
  TransientError,
} from '../../errors.js';
import {
  SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  buildUserPrompt,
  buildVerifyPrompt,
  type PromptInput,
  type VerifyInput,
} from '../../prompt.js';
import { GenerationOutputSchema, VerificationOutputSchema } from '../../schemas.js';
import type { GenerationResult, LlmCall, LlmProvider, VerificationResult } from '../../ports.js';

const GENERATION_FORMAT = zodOutputFormat(GenerationOutputSchema);
const VERIFICATION_FORMAT = zodOutputFormat(VerificationOutputSchema);
/** Room for 20 questions per level plus spares; streamed, so a long response cannot hit request timeouts. */
const MAX_TOKENS = 32_000;

export interface AnthropicOptions {
  /** Omit to use the SDK's credential chain (env vars, then an `ant auth login` profile) in local dev. */
  apiKey?: string | undefined;
  model: string;
  effort: 'low' | 'medium' | 'high';
}

/** Structural match for the SDK's zodOutputFormat result. */
interface StructuredFormat<T> {
  schema: Record<string, unknown>;
  parse(text: string): T;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      maxRetries: 2,
      timeout: 300_000,
    });
  }

  async generate(input: PromptInput): Promise<GenerationResult> {
    const { output, ...call } = await this.request(SYSTEM_PROMPT, buildUserPrompt(input), GENERATION_FORMAT);
    if (!output.ok) throw new TopicRejectedError('Topic is not a legitimate subject of knowledge');
    return { ...call, questions: output.qs };
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const { output, ...call } = await this.request(
      VERIFY_SYSTEM_PROMPT,
      buildVerifyPrompt(input),
      VERIFICATION_FORMAT,
    );
    return { ...call, verdicts: output.rs };
  }

  private async request<T>(
    system: string,
    prompt: string,
    format: StructuredFormat<T>,
  ): Promise<LlmCall & { output: T }> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages
        .stream({
          model: this.options.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: prompt }],
          output_config: {
            effort: this.options.effort,
            format: { type: 'json_schema', schema: format.schema },
          },
        })
        .finalMessage();
    } catch (error) {
      throw classifyAnthropicError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new TopicRejectedError(
        `Anthropic refused the topic (${response.stop_details?.category ?? 'uncategorized'})`,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new InvalidOutputError(`Output truncated at max_tokens=${MAX_TOKENS}`);
    }

    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new InvalidOutputError('Response contained no text block');

    let output: T;
    try {
      output = format.parse(text);
    } catch (error) {
      throw new InvalidOutputError('Structured output failed validation', { cause: error });
    }
    return {
      output,
      provider: this.name,
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

function classifyAnthropicError(error: unknown): Error {
  // APIConnectionError (incl. timeouts) subclasses APIError, so it is checked first.
  if (error instanceof Anthropic.APIConnectionError) {
    return new TransientError('Anthropic connection failed', { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const message = `Anthropic API ${error.status ?? 'error'} ${error.type ?? ''}`.trim();
    if (
      error.type === 'billing_error' ||
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return new ProviderUnavailableError(message, { cause: error });
    }
    if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
      return new TransientError(message, { cause: error });
    }
    return new PermanentError(message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
