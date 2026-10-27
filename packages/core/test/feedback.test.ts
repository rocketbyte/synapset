import { describe, expect, it } from 'vitest';
import { FeedbackService, bankQuestionId, bankScopeKey } from '@synapset/core';
import { InMemoryRepository, assessment, principal, questions, silentLogger } from './fakes.js';

const NOW = new Date('2026-10-26T12:00:00Z');

function setup() {
  const repo = new InMemoryRepository();
  const feedback = new FeedbackService(repo, { quarantineAfterReports: 2 }, silentLogger, () => NOW);
  const scope = bankScopeKey({
    locale: 'en',
    style: '',
    promptVersion: 'v',
    embeddingModel: 'fake-embedding',
  });
  const target = assessment({ questions: questions(2) });
  const ids = target.questions.map((q) => bankQuestionId(scope, q));
  const stored = { ...target, questionIds: ids };
  const other = assessment({ id: 'b'.repeat(64), questionIds: [ids[2] as string] });
  repo.assessments.set(stored.id, stored);
  repo.assessments.set(other.id, other);
  return { repo, feedback, stored, ids };
}

describe('FeedbackService', () => {
  it('quarantines a question once enough distinct accounts report it, and expires every assessment using it', async () => {
    const { repo, feedback, stored, ids } = setup();
    // Position 1 of a 1-per-level selection is the first medium question, stored at index 2.
    const input = { assessment: stored, questionsPerLevel: 1, index: 1, reason: 'wrong_answer' as const };

    await expect(feedback.report(input, principal({}, 'acct_1'))).resolves.toMatchObject({
      status: 'recorded',
      reports: 1,
      quarantined: false,
    });
    await expect(feedback.report(input, principal({}, 'acct_1'))).resolves.toMatchObject({
      status: 'duplicate',
    });
    expect(repo.bank.get(ids[2] as string)?.status).toBe('active');

    await expect(feedback.report(input, principal({}, 'acct_2'))).resolves.toMatchObject({
      status: 'recorded',
      reports: 2,
      quarantined: true,
    });
    expect(repo.bank.get(ids[2] as string)).toMatchObject({ status: 'quarantined', reports: 2 });
    for (const id of [stored.id, 'b'.repeat(64)]) {
      expect(repo.assessments.get(id)?.expiresAt).toEqual(NOW);
    }
  });

  it('records whether the reported question was reused, as a calibration signal', async () => {
    const { repo, feedback, stored, ids } = setup();
    await repo.saveQuestions([
      {
        ...(stored.questions[0] as (typeof stored.questions)[number]),
        id: ids[0] as string,
        scope: 's',
        embedding: [1],
        sourceAssessmentId: 'another-assessment',
        status: 'active',
        reports: 0,
        createdAt: NOW,
        expiresAt: NOW,
      },
    ]);

    await feedback.report(
      { assessment: stored, questionsPerLevel: 2, index: 0, reason: 'off_topic' },
      principal({}, 'acct_1'),
    );

    expect([...repo.reports.values()]).toEqual([
      expect.objectContaining({ reason: 'off_topic', reused: true }),
    ]);
  });

  it('restores a reviewed question so earlier reports no longer count toward quarantine', async () => {
    const { repo, feedback, stored, ids } = setup();
    const input = { assessment: stored, questionsPerLevel: 1, index: 1, reason: 'ambiguous' as const };
    await feedback.report(input, principal({}, 'acct_1'));
    await feedback.report(input, principal({}, 'acct_2'));

    await expect(feedback.restore(ids[2] as string, 3600)).resolves.toEqual({
      status: 'restored',
      dismissed: 2,
    });
    expect(repo.bank.get(ids[2] as string)).toMatchObject({
      status: 'active',
      reports: 0,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });

    await expect(feedback.report(input, principal({}, 'acct_3'))).resolves.toMatchObject({
      reports: 1,
      quarantined: false,
    });
  });

  it('lets an operator quarantine a question directly', async () => {
    const { repo, feedback, stored, ids } = setup();
    await repo.saveQuestions([
      {
        ...(stored.questions[2] as (typeof stored.questions)[number]),
        id: ids[2] as string,
        scope: 's',
        embedding: [1],
        sourceAssessmentId: stored.id,
        status: 'active',
        reports: 0,
        createdAt: NOW,
        expiresAt: NOW,
      },
    ]);

    await expect(feedback.quarantine(ids[2] as string)).resolves.toEqual({
      status: 'quarantined',
      expired: 2,
    });
    expect(repo.bank.get(ids[2] as string)?.status).toBe('quarantined');
    await expect(feedback.quarantine('missing')).resolves.toEqual({ status: 'not_found' });
  });

  it('rejects positions outside the selection', async () => {
    const { feedback, stored } = setup();
    await expect(
      feedback.report({ assessment: stored, questionsPerLevel: 1, index: 3, reason: 'other' }, principal()),
    ).resolves.toEqual({ status: 'not_found' });
  });
});
