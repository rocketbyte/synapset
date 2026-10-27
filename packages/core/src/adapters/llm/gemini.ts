import { FinishReason, type GenerateContentResponse, type GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { InvalidOutputError, TopicRejectedError } from '../../errors.js';
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
import { classifyGoogleError } from '../google.js';

const MAX_OUTPUT_TOKENS = 32_000;
const BLOCKED: readonly (FinishReason | undefined)[] = [
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
];

function responseSchema(schema: z.ZodType) {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema);
  return rest;
}
const GENERATION_SCHEMA = responseSchema(GenerationOutputSchema);
const VERIFICATION_SCHEMA = responseSchema(VerificationOutputSchema);

export class GeminiLlmProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  async generate(input: PromptInput): Promise<GenerationResult> {
    const { output, ...call } = await this.request(
      SYSTEM_PROMPT,
      buildUserPrompt(input),
      GenerationOutputSchema,
      GENERATION_SCHEMA,
    );
    if (!output.ok) throw new TopicRejectedError('Topic is not a legitimate subject of knowledge');
    return { ...call, questions: output.qs };
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const { output, ...call } = await this.request(
      VERIFY_SYSTEM_PROMPT,
      buildVerifyPrompt(input),
      VerificationOutputSchema,
      VERIFICATION_SCHEMA,
    );
    return { ...call, verdicts: output.rs };
  }

  private async request<T>(
    system: string,
    prompt: string,
    schema: z.ZodType<T>,
    jsonSchema: Record<string, unknown>,
  ): Promise<LlmCall & { output: T }> {
    let response: GenerateContentResponse;
    try {
      response = await this.ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });
    } catch (error) {
      throw classifyGoogleError(error, 'Gemini generateContent');
    }

    const finishReason = response.candidates?.[0]?.finishReason;
    if (response.promptFeedback?.blockReason || BLOCKED.includes(finishReason)) {
      throw new TopicRejectedError(
        `Gemini blocked the topic (${response.promptFeedback?.blockReason ?? finishReason})`,
      );
    }
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new InvalidOutputError(`Output truncated at maxOutputTokens=${MAX_OUTPUT_TOKENS}`);
    }

    let output: T;
    try {
      output = schema.parse(JSON.parse(response.text ?? ''));
    } catch (error) {
      throw new InvalidOutputError('Structured output failed validation', { cause: error });
    }
    return {
      output,
      provider: this.name,
      model: response.modelVersion ?? this.model,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens:
          (response.usageMetadata?.candidatesTokenCount ?? 0) +
          (response.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    };
  }
}
