import { ApiError, GoogleGenAI } from '@google/genai';
import { PermanentError, ProviderUnavailableError, TransientError } from '../errors.js';

export function createGenAiClient(project: string, location: string): GoogleGenAI {
  return new GoogleGenAI({ vertexai: true, project, location });
}

export function classifyGoogleError(error: unknown, operation: string): Error {
  if (error instanceof ApiError) {
    const message = `${operation} failed with HTTP ${error.status}`;
    if (error.status === 401 || error.status === 403) {
      return new ProviderUnavailableError(message, { cause: error });
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return new TransientError(message, { cause: error });
    }
    return new PermanentError(message, { cause: error });
  }
  // Anything else is a transport failure (DNS, reset, timeout).
  return new TransientError(`${operation} failed`, { cause: error });
}
