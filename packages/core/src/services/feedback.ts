import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { bankQuestionId, bankScopeKey, selectIndexes, styleKey } from '../domain.js';
import type { Principal } from '../auth.js';
import type { Assessment, ReportReason } from '../schemas.js';
import type { AssessmentRepository, Clock } from '../ports.js';

/** Reports are kept a year for calibration; a quarantine outlives any assessment that could reuse it. */
const REPORT_RETENTION_MS = 365 * 86_400_000;
const QUARANTINE_RETENTION_MS = 2 * 365 * 86_400_000;

export interface FeedbackOptions {
  /** Distinct accounts that must report a question before it is quarantined. */
  quarantineAfterReports: number;
}

export interface ReportInput {
  assessment: Assessment;
  /** Questions per level the reporter was shown; `index` is a position in that selection. */
  questionsPerLevel: number;
  index: number;
  reason: ReportReason;
  comment?: string | undefined;
}

export type QuarantineOutcome = { status: 'quarantined'; expired: number } | { status: 'not_found' };
export type RestoreOutcome = { status: 'restored'; dismissed: number } | { status: 'not_found' };

export type ReportOutcome =
  | { status: 'recorded'; questionId: string; reports: number; quarantined: boolean }
  | { status: 'duplicate'; questionId: string }
  | { status: 'not_found' };

/**
 * Users report bad questions. A question reported by enough distinct accounts is quarantined: never
 * reused, blocked from being stored again, and every assessment containing it is expired so the next
 * request rebuilds it without that question. One account can report a question once, so a single caller
 * cannot quarantine anything on its own unless the threshold is 1.
 */
export class FeedbackService {
  constructor(
    private readonly repo: AssessmentRepository,
    private readonly options: FeedbackOptions,
    private readonly logger: Logger,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async report(input: ReportInput, reporter: Principal): Promise<ReportOutcome> {
    const { assessment } = input;
    const position = selectIndexes(assessment.questions, input.questionsPerLevel)[input.index];
    const question = position === undefined ? undefined : assessment.questions[position];
    if (position === undefined || !question) return { status: 'not_found' };

    const bankScope = bankScopeKey({
      locale: assessment.locale,
      style: styleKey(assessment.style),
      promptVersion: assessment.promptVersion,
      embeddingModel: assessment.embeddingModel,
    });
    // Assessments stored before question ids existed derive the same id from the text.
    const questionId = assessment.questionIds[position] ?? bankQuestionId(bankScope, question);
    const [banked] = await this.repo.getQuestions([questionId]);
    const now = this.clock();

    const recorded = await this.repo.recordReport({
      id: createHash('sha256').update(`${reporter.accountId}:${questionId}`).digest('hex'),
      questionId,
      assessmentId: assessment.id,
      accountId: reporter.accountId,
      reason: input.reason,
      comment: input.comment ?? null,
      reused: banked !== undefined && banked.sourceAssessmentId !== assessment.id,
      dismissed: false,
      createdAt: now,
      expiresAt: new Date(now.getTime() + REPORT_RETENTION_MS),
    });
    if (!recorded) return { status: 'duplicate', questionId };

    const reports = await this.repo.countReports(questionId);
    const quarantine = reports >= this.options.quarantineAfterReports;
    const alreadyQuarantined = banked?.status === 'quarantined';
    await this.repo.markQuestion(
      { id: questionId, scope: bankScope, ...question },
      {
        status: quarantine || alreadyQuarantined ? 'quarantined' : (banked?.status ?? 'active'),
        reports,
        expiresAt:
          quarantine || alreadyQuarantined
            ? new Date(now.getTime() + QUARANTINE_RETENTION_MS)
            : (banked?.expiresAt ?? assessment.expiresAt),
      },
    );

    if (quarantine && !alreadyQuarantined) {
      const expired = await this.repo.expireAssessmentsWith(questionId, now);
      // Older assessments have no question ids to query by; the reported one is expired directly.
      if (!assessment.questionIds.includes(questionId)) await this.repo.expireAssessment(assessment.id, now);
      this.logger.warn(
        { questionId, reports, expired, reason: input.reason },
        'Question quarantined by reports',
      );
    }
    return { status: 'recorded', questionId, reports, quarantined: quarantine || alreadyQuarantined };
  }

  /** Operator override: quarantines a bank question regardless of reports. */
  async quarantine(questionId: string): Promise<QuarantineOutcome> {
    const [question] = await this.repo.getQuestions([questionId]);
    if (!question) return { status: 'not_found' };
    const now = this.clock();
    await this.repo.markQuestion(question, {
      status: 'quarantined',
      reports: question.reports,
      expiresAt: new Date(now.getTime() + QUARANTINE_RETENTION_MS),
    });
    const expired = await this.repo.expireAssessmentsWith(questionId, now);
    this.logger.warn({ questionId, expired }, 'Question quarantined by an operator');
    return { status: 'quarantined', expired };
  }

  /**
   * Operator override after review: reactivates a question and dismisses its reports, so they no longer
   * count and it takes fresh reports from other accounts to quarantine it again. Records without an
   * embedding (kept only to block text) stay unsearchable and lapse after `ttlSeconds`.
   */
  async restore(questionId: string, ttlSeconds: number): Promise<RestoreOutcome> {
    const [question] = await this.repo.getQuestions([questionId]);
    if (!question) return { status: 'not_found' };
    const dismissed = await this.repo.dismissReports(questionId);
    await this.repo.markQuestion(question, {
      status: 'active',
      reports: 0,
      expiresAt: new Date(this.clock().getTime() + ttlSeconds * 1000),
    });
    this.logger.info({ questionId, dismissed }, 'Question restored by an operator');
    return { status: 'restored', dismissed };
  }
}
