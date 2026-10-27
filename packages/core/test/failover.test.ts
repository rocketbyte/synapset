import { describe, expect, it } from 'vitest';
import {
  FailoverLlmProvider,
  ProviderUnavailableError,
  TransientError,
  type GenerationResult,
  type LlmProvider,
} from '@synapset/core';
import { questions, silentLogger } from './fakes.js';

const input = { topic: 'x', locale: 'en', counts: { 1: 1, 2: 1, 3: 1 } };

function provider(name: 'anthropic' | 'gemini', behaviour: () => Promise<GenerationResult>) {
  const p = {
    name,
    calls: 0,
    generate: () => (p.calls++, behaviour()),
    verify: () => Promise.reject(new Error('not used')),
  };
  return p satisfies LlmProvider;
}
const ok = (name: 'anthropic' | 'gemini') => () =>
  Promise.resolve({
    questions: questions(1),
    provider: name,
    model: name,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

describe('FailoverLlmProvider', () => {
  it('fails over when the primary is unavailable and skips it during the cooldown', async () => {
    let now = 0;
    const primary = provider('anthropic', () =>
      Promise.reject(new ProviderUnavailableError('billing_error')),
    );
    const fallback = provider('gemini', ok('gemini'));
    const llm = new FailoverLlmProvider(primary, fallback, silentLogger, () => new Date(now));

    expect((await llm.generate(input)).provider).toBe('gemini');
    expect((await llm.generate(input)).provider).toBe('gemini');
    expect(primary.calls).toBe(1);

    now += 6 * 60_000;
    await llm.generate(input);
    expect(primary.calls).toBe(2);
  });

  it('does not fail over on retryable errors', async () => {
    const primary = provider('anthropic', () => Promise.reject(new TransientError('429')));
    const fallback = provider('gemini', ok('gemini'));
    const llm = new FailoverLlmProvider(primary, fallback, silentLogger);

    await expect(llm.generate(input)).rejects.toThrow(TransientError);
    expect(fallback.calls).toBe(0);
  });
});
