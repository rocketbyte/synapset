import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { finalizeQuestions } from '../../domain.js';
import {
  InvalidOutputError,
  PermanentError,
  ProviderUnavailableError,
  TopicRejectedError,
  TransientError,
} from '../../errors.js';
import { SYSTEM_PROMPT, buildUserPrompt, type PromptInput } from '../../prompt.js';
import { GenerationOutputSchema } from '../../schemas.js';
import type { GenerationResult, LlmProvider } from '../../ports.js';

const OUTPUT_FORMAT = zodOutputFormat(GenerationOutputSchema);
const MAX_TOKENS = 16_000;

export interface AnthropicOptions {
  /** Omit to use the SDK's credential chain (env vars, then an `ant auth login` profile) in local dev. */
  apiKey?: string | undefined;
  model: string;
  effort: 'low' | 'medium' | 'high';
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      maxRetries: 2,
      timeout: 180_000,
    });
  }

  async generate(input: PromptInput): Promise<GenerationResult> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
        output_config: {
          effort: this.options.effort,
          format: { type: 'json_schema', schema: OUTPUT_FORMAT.schema },
        },
      });
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

    let output;
    try {
      output = OUTPUT_FORMAT.parse(text);
    } catch (error) {
      throw new InvalidOutputError('Structured output failed validation', { cause: error });
    }
    if (!output.ok) throw new TopicRejectedError('Topic is not a legitimate subject of knowledge');

    return {
      questions: finalizeQuestions(output.qs, input.questionsPerLevel),
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
