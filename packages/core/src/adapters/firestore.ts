import {
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type VectorValue,
} from '@google-cloud/firestore';
import type { Assessment, BankQuestion, Job, QuestionReport } from '../schemas.js';
import type { AssessmentRepository, LeaseResult, NearestMatch, NewJob, QuestionMatch } from '../ports.js';

const DISTANCE_FIELD = '_distance';
/** Jobs are bookkeeping only; TTL removes them after this long. */
const JOB_RETENTION_MS = 7 * 86_400_000;
/** Firestore's limit on writes in one batch. */
const BATCH_LIMIT = 500;

const toDate = (value: unknown): Date => (value as Timestamp).toDate();
const toDateOrNull = (value: unknown): Date | null => (value ? toDate(value) : null);

function toAssessment(snapshot: DocumentSnapshot): Assessment {
  const d = snapshot.data() as DocumentData;
  return {
    id: snapshot.id,
    topic: d.topic as string,
    topicNormalized: d.topicNormalized as string,
    context: (d.context as string | null | undefined) ?? null,
    style: (d.style as string | null | undefined) ?? null,
    locale: d.locale as string,
    scope: d.scope as string,
    questions: d.questions as Assessment['questions'],
    llmProvider: d.llmProvider as string,
    model: d.model as string,
    promptVersion: d.promptVersion as string,
    embeddingModel: d.embeddingModel as string,
    usage: d.usage as Assessment['usage'],
    reusedQuestions: (d.reusedQuestions as number | undefined) ?? 0,
    questionIds: (d.questionIds as string[] | undefined) ?? [],
    createdAt: toDate(d.createdAt),
    expiresAt: toDate(d.expiresAt),
  };
}

function toBankQuestion(snapshot: DocumentSnapshot): BankQuestion {
  const d = snapshot.data() as DocumentData;
  return {
    id: snapshot.id,
    q: d.q as string,
    o: d.o as string[],
    a: d.a as number,
    e: d.e as string,
    d: d.d as number,
    scope: d.scope as string,
    // Quarantine records created from a report carry no embedding.
    embedding: (d.embedding as VectorValue | undefined)?.toArray() ?? [],
    sourceAssessmentId: (d.sourceAssessmentId as string | undefined) ?? '',
    status: (d.status as BankQuestion['status'] | undefined) ?? 'active',
    reports: (d.reports as number | undefined) ?? 0,
    createdAt: toDate(d.createdAt),
    expiresAt: toDate(d.expiresAt),
  };
}

function toReport(snapshot: DocumentSnapshot): QuestionReport {
  const d = snapshot.data() as DocumentData;
  return {
    id: snapshot.id,
    questionId: d.questionId as string,
    assessmentId: d.assessmentId as string,
    accountId: d.accountId as string,
    reason: d.reason as QuestionReport['reason'],
    comment: (d.comment as string | null | undefined) ?? null,
    reused: d.reused as boolean,
    dismissed: (d.dismissed as boolean | undefined) ?? false,
    createdAt: toDate(d.createdAt),
    expiresAt: toDate(d.expiresAt),
  };
}

function toJob(snapshot: DocumentSnapshot): Job {
  const d = snapshot.data() as DocumentData;
  return {
    id: snapshot.id,
    status: d.status as Job['status'],
    topic: d.topic as string,
    locale: d.locale as string,
    attempts: d.attempts as number,
    leaseUntil: toDateOrNull(d.leaseUntil),
    assessmentId: (d.assessmentId as string | null) ?? null,
    error: (d.error as string | null) ?? null,
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
    expiresAt: toDate(d.expiresAt),
  };
}

export class FirestoreAssessmentRepository implements AssessmentRepository {
  private readonly assessments: CollectionReference;
  private readonly aliases: CollectionReference;
  private readonly jobs: CollectionReference;
  private readonly questions: CollectionReference;
  private readonly reports: CollectionReference;

  constructor(private readonly db: Firestore) {
    this.questions = db.collection('questions');
    this.reports = db.collection('question_reports');
    this.assessments = db.collection('assessments');
    this.aliases = db.collection('topic_keys');
    this.jobs = db.collection('jobs');
  }

  async getAssessment(id: string): Promise<Assessment | null> {
    const snapshot = await this.assessments.doc(id).get();
    return snapshot.exists ? toAssessment(snapshot) : null;
  }

  async findNearest(
    embedding: number[],
    scope: string,
    maxDistance: number,
    limit: number,
  ): Promise<NearestMatch[]> {
    const result = await this.assessments
      .where('scope', '==', scope)
      .findNearest({
        vectorField: 'embedding',
        queryVector: embedding,
        limit,
        distanceMeasure: 'COSINE',
        distanceThreshold: maxDistance,
        distanceResultField: DISTANCE_FIELD,
      })
      .get();
    return result.docs.map((doc) => ({
      assessment: toAssessment(doc),
      distance: doc.get(DISTANCE_FIELD) as number,
    }));
  }

  async getAlias(key: string): Promise<string | null> {
    const snapshot = await this.aliases.doc(key).get();
    return snapshot.exists ? (snapshot.get('assessmentId') as string) : null;
  }

  async saveAlias(key: string, assessmentId: string, expiresAt: Date): Promise<void> {
    await this.aliases.doc(key).set({ assessmentId, expiresAt: Timestamp.fromDate(expiresAt) });
  }

  async saveAssessment(assessment: Assessment, embedding: number[]): Promise<void> {
    const { id, createdAt, expiresAt, ...fields } = assessment;
    await this.assessments.doc(id).set({
      ...fields,
      embedding: FieldValue.vector(embedding),
      createdAt: Timestamp.fromDate(createdAt),
      expiresAt: Timestamp.fromDate(expiresAt),
    });
  }

  async findNearestQuestions(
    embedding: number[],
    scope: string,
    level: number,
    maxDistance: number,
    limit: number,
  ): Promise<QuestionMatch[]> {
    const result = await this.questions
      .where('scope', '==', scope)
      .where('d', '==', level)
      .findNearest({
        vectorField: 'embedding',
        queryVector: embedding,
        limit,
        distanceMeasure: 'COSINE',
        distanceThreshold: maxDistance,
        distanceResultField: DISTANCE_FIELD,
      })
      .get();
    return result.docs.map((doc) => ({
      question: toBankQuestion(doc),
      distance: doc.get(DISTANCE_FIELD) as number,
    }));
  }

  async getQuestions(ids: readonly string[]): Promise<BankQuestion[]> {
    if (ids.length === 0) return [];
    const snapshots = await this.db.getAll(...ids.map((id) => this.questions.doc(id)));
    return snapshots.filter((snapshot) => snapshot.exists).map(toBankQuestion);
  }

  async saveQuestions(questions: readonly BankQuestion[]): Promise<void> {
    for (let start = 0; start < questions.length; start += BATCH_LIMIT) {
      const batch = this.db.batch();
      for (const question of questions.slice(start, start + BATCH_LIMIT)) {
        // status and reports are left out so a regeneration never clears a quarantine or its reports.
        const {
          id,
          embedding,
          createdAt,
          expiresAt,
          status: _status,
          reports: _reports,
          ...fields
        } = question;
        batch.set(
          this.questions.doc(id),
          {
            ...fields,
            embedding: FieldValue.vector(embedding),
            createdAt: Timestamp.fromDate(createdAt),
            expiresAt: Timestamp.fromDate(expiresAt),
          },
          { merge: true },
        );
      }
      await batch.commit();
    }
  }

  recordReport(report: QuestionReport): Promise<boolean> {
    const ref = this.reports.doc(report.id);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return false;
      const { id: _id, createdAt, expiresAt, ...fields } = report;
      tx.create(ref, {
        ...fields,
        createdAt: Timestamp.fromDate(createdAt),
        expiresAt: Timestamp.fromDate(expiresAt),
      });
      return true;
    });
  }

  async countReports(questionId: string): Promise<number> {
    const result = await this.reports
      .where('questionId', '==', questionId)
      .where('dismissed', '==', false)
      .count()
      .get();
    return result.data().count;
  }

  async dismissReports(questionId: string): Promise<number> {
    const result = await this.reports
      .where('questionId', '==', questionId)
      .where('dismissed', '==', false)
      .select()
      .get();
    for (let start = 0; start < result.docs.length; start += BATCH_LIMIT) {
      const batch = this.db.batch();
      for (const doc of result.docs.slice(start, start + BATCH_LIMIT))
        batch.update(doc.ref, { dismissed: true });
      await batch.commit();
    }
    return result.docs.length;
  }

  async markQuestion(
    question: Pick<BankQuestion, 'id' | 'scope' | 'q' | 'o' | 'a' | 'e' | 'd'>,
    update: { status: BankQuestion['status']; reports: number; expiresAt: Date },
  ): Promise<void> {
    // Only content fields: callers may pass a full bank question, whose plain embedding array would
    // otherwise overwrite the stored vector.
    const { id, scope, q, o, a, e, d } = question;
    await this.questions
      .doc(id)
      .set(
        { scope, q, o, a, e, d, ...update, expiresAt: Timestamp.fromDate(update.expiresAt) },
        { merge: true },
      );
  }

  async expireAssessmentsWith(questionId: string, now: Date): Promise<number> {
    // expiresAt is exempt from indexing, so already-expired matches are included; re-expiring them is harmless.
    const result = await this.assessments.where('questionIds', 'array-contains', questionId).select().get();
    for (let start = 0; start < result.docs.length; start += BATCH_LIMIT) {
      const batch = this.db.batch();
      for (const doc of result.docs.slice(start, start + BATCH_LIMIT)) {
        batch.update(doc.ref, { expiresAt: Timestamp.fromDate(now) });
      }
      await batch.commit();
    }
    return result.docs.length;
  }

  async expireAssessment(id: string, now: Date): Promise<void> {
    await this.assessments.doc(id).update({ expiresAt: Timestamp.fromDate(now) });
  }

  async listReports(limit: number): Promise<QuestionReport[]> {
    const result = await this.reports.orderBy('createdAt', 'desc').limit(limit).get();
    return result.docs.map(toReport);
  }

  async getJob(id: string): Promise<Job | null> {
    const snapshot = await this.jobs.doc(id).get();
    return snapshot.exists ? toJob(snapshot) : null;
  }

  claimJob(job: NewJob, now: Date, staleAfterMs: number): Promise<{ job: Job; claimed: boolean }> {
    const ref = this.jobs.doc(job.id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? toJob(snapshot) : null;
      const inFlight =
        existing !== null &&
        (existing.status === 'pending' || existing.status === 'running') &&
        now.getTime() - existing.updatedAt.getTime() < staleAfterMs;
      if (existing && inFlight) return { job: existing, claimed: false };

      const fresh: Job = {
        id: job.id,
        status: 'pending',
        topic: job.topic,
        locale: job.locale,
        attempts: 0,
        leaseUntil: null,
        assessmentId: null,
        error: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + JOB_RETENTION_MS),
      };
      const { id: _id, ...fields } = fresh;
      tx.set(ref, fields);
      return { job: fresh, claimed: true };
    });
  }

  acquireLease(id: string, now: Date, leaseMs: number): Promise<LeaseResult> {
    const ref = this.jobs.doc(id);
    return this.db.runTransaction(async (tx): Promise<LeaseResult> => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return { kind: 'missing' };
      const job = toJob(snapshot);
      if (job.status === 'done') return { kind: 'done' };
      // A failed job is only revived by a new claim, which resets it to pending.
      if (job.status === 'failed') return { kind: 'missing' };
      if (job.status === 'running' && job.leaseUntil && job.leaseUntil > now) return { kind: 'busy' };

      const leaseUntil = new Date(now.getTime() + leaseMs);
      tx.update(ref, { status: 'running', leaseUntil, attempts: FieldValue.increment(1), updatedAt: now });
      return {
        kind: 'acquired',
        job: { ...job, status: 'running', leaseUntil, attempts: job.attempts + 1, updatedAt: now },
      };
    });
  }

  async completeJob(id: string, assessmentId: string, now: Date): Promise<void> {
    await this.jobs
      .doc(id)
      .update({ status: 'done', assessmentId, leaseUntil: null, error: null, updatedAt: now });
  }

  async releaseJob(id: string, error: string, now: Date): Promise<void> {
    await this.jobs.doc(id).update({ status: 'pending', leaseUntil: null, error, updatedAt: now });
  }

  async failJob(id: string, error: string, now: Date): Promise<void> {
    await this.jobs.doc(id).update({ status: 'failed', leaseUntil: null, error, updatedAt: now });
  }
}
