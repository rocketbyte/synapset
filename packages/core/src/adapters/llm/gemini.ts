import { FinishReason, type GenerateContentResponse, type GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { finalizeQuestions } from '../../domain.js';
import { InvalidOutputError, TopicRejectedError } from '../../errors.js';
import { SYSTEM_PROMPT, buildUserPrompt, type PromptInput } from '../../prompt.js';
import { GenerationOutputSchema } from '../../schemas.js';
import type { GenerationResult, LlmProvider } from '../../ports.js';
import { classifyGoogleError } from '../google.js';

const { $schema: _dialect, ...RESPONSE_SCHEMA } = z.toJSONSchema(GenerationOutputSchema);
const MAX_OUTPUT_TOKENS = 16_000;
const BLOCKED: readonly (FinishReason | undefined)[] = [
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
];

export class GeminiLlmProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  async generate(input: PromptInput): Promise<GenerationResult> {
    let response: GenerateContentResponse;
    try {
      response = await this.ai.models.generateContent({
        model: this.model,
        contents: buildUserPrompt(input),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_SCHEMA,
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

    let output;
    try {
      output = GenerationOutputSchema.parse(JSON.parse(response.text ?? ''));
    } catch (error) {
      throw new InvalidOutputError('Structured output failed validation', { cause: error });
    }
    if (!output.ok) throw new TopicRejectedError('Topic is not a legitimate subject of knowledge');

    return {
      questions: finalizeQuestions(output.qs, input.questionsPerLevel),
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
