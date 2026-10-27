import { describe, expect, it } from 'vitest';
import { QuestionBank } from '@synapset/core';
import { FakeEmbedder, InMemoryRepository, axisVector, bankQuestion, silentLogger } from './fakes.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const SCOPE = 'bank-scope';
const query = axisVector({ 0: 1 });

function setup() {
  const repo = new InMemoryRepository();
  const bank = new QuestionBank(repo, new FakeEmbedder(), { margin: 0.08 }, silentLogger, () => NOW);
  const add = (...questions: ReturnType<typeof bankQuestion>[]) => repo.saveQuestions(questions);
  return { repo, bank, add };
}

describe('QuestionBank.select', () => {
  it('takes relevant questions per level, most relevant first, and leaves unrelated ones', async () => {
    const { bank, add } = setup();
    await add(
      bankQuestion(SCOPE, 1, 'close', axisVector({ 0: 0.9, 1: 0.44 })),
      bankQuestion(SCOPE, 1, 'closest', axisVector({ 0: 1, 2: 0.1 })),
      bankQuestion(SCOPE, 1, 'unrelated', axisVector({ 5: 1 })),
      bankQuestion(SCOPE, 2, 'related', axisVector({ 0: 0.7, 3: 0.7 })),
      bankQuestion('other-scope', 3, 'wrong-language', axisVector({ 0: 1 })),
    );

    const [easy, medium, hard] = await bank.select(query, SCOPE, { 1: 5, 2: 5, 3: 5 });

    expect(easy?.map((q) => q.id)).toEqual([`${SCOPE}-1-closest`, `${SCOPE}-1-close`]);
    expect(medium?.map((q) => q.id)).toEqual([`${SCOPE}-2-related`]);
    expect(hard).toEqual([]);
  });

  it('respects the count, skips expired questions and collapses near-duplicates', async () => {
    const { bank, add } = setup();
    await add(
      bankQuestion(SCOPE, 1, 'a', axisVector({ 0: 1, 1: 0.1 })),
      bankQuestion(SCOPE, 1, 'a-again', axisVector({ 0: 1, 1: 0.12 })),
      bankQuestion(SCOPE, 1, 'b', axisVector({ 0: 0.8, 2: 0.6 })),
      bankQuestion(SCOPE, 1, 'expired', axisVector({ 0: 1 }), new Date('2026-10-01T00:00:00Z')),
      bankQuestion(SCOPE, 1, 'c', axisVector({ 0: 0.8, 3: 0.6 })),
    );

    const [easy] = await bank.select(query, SCOPE, { 1: 2, 2: 0, 3: 0 });

    expect(easy?.map((q) => q.id)).toEqual([`${SCOPE}-1-a`, `${SCOPE}-1-b`]);
  });

  it('falls back to no reuse when the bank cannot be searched', async () => {
    const { repo, bank } = setup();
    repo.findNearestQuestions = () => Promise.reject(new Error('missing index'));

    await expect(bank.select(query, SCOPE, { 1: 1, 2: 1, 3: 1 })).resolves.toEqual([[], [], []]);
  });
});
