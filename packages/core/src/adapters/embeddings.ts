import type { GoogleGenAI } from '@google/genai';
import { EMBEDDING_DIMENSIONS } from '../config.js';
import { unitVector } from '../domain.js';
import { PermanentError } from '../errors.js';
import type { Embedder } from '../ports.js';
import { classifyGoogleError } from './google.js';

export class VertexEmbedder implements Embedder {
  constructor(
    private readonly ai: GoogleGenAI,
    readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    let values: number[] | undefined;
    try {
      const response = await this.ai.models.embedContent({
        model: this.model,
        contents: text,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      values = response.embeddings?.[0]?.values;
    } catch (error) {
      throw classifyGoogleError(error, 'Vertex embedContent');
    }
    if (values?.length !== EMBEDDING_DIMENSIONS) {
      throw new PermanentError(
        `Expected ${EMBEDDING_DIMENSIONS} embedding values, got ${values?.length ?? 0}`,
      );
    }
    // Truncated (MRL) embeddings are not unit length; normalizing keeps cosine distances comparable.
    return unitVector(values);
  }
}
