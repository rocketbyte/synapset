import {
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
} from '@google-cloud/firestore';
import type { Assessment, Job } from '../schemas.js';
import type { AssessmentRepository, LeaseResult, NearestMatch, NewJob } from '../ports.js';

const DISTANCE_FIELD = '_distance';
/** Jobs are bookkeeping only; TTL removes them after this long. */
const JOB_RETENTION_MS = 7 * 86_400_000;

const toDate = (value: unknown): Date => (value as Timestamp).toDate();
const toDateOrNull = (value: unknown): Date | null => (value ? toDate(value) : null);

function toAssessment(snapshot: DocumentSnapshot): Assessment {
  const d = snapshot.data() as DocumentData;
  return {
    id: snapshot.id,
    topic: d.topic as string,
    topicNormalized: d.topicNormalized as string,
    locale: d.locale as string,
    scope: d.scope as string,
    questions: d.questions as Assessment['questions'],
    llmProvider: d.llmProvider as string,
    model: d.model as string,
    promptVersion: d.promptVersion as string,
    embeddingModel: d.embeddingModel as string,
    usage: d.usage as Assessment['usage'],
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

  constructor(private readonly db: Firestore) {
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
