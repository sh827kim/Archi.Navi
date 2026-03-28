import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import {
  createPgliteClient,
  domainInferenceProfiles,
  evidences,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { approveRelationCandidate } from '@/relation/approveRelationCandidate';
import {
  applyFeedbackToRelationCandidateInput,
  DEFAULT_RELATION_FEEDBACK_CONFIG,
} from '@/relation/feedbackLoop';
import { saveRelationCandidate } from '@/relation/candidateStore';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000081';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function seedWorkspace(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'feedback-loop-test' });
}

async function createService(db: TestDb, name: string): Promise<string> {
  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name,
    path: `/${name}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });
  return id;
}

async function createEvidence(db: TestDb, excerpt: string): Promise<string> {
  const id = generateId();
  await db.insert(evidences).values({
    id,
    workspaceId,
    evidenceType: 'FILE',
    filePath: 'src/test.ts',
    excerpt,
    metadata: {},
  });
  return id;
}

async function upsertDefaultProfile(
  db: TestDb,
  input?: {
    feedbackConfig?: Record<string, unknown>;
    feedbackAdjustments?: Record<string, unknown>;
  },
) {
  const existing = await db.select().from(domainInferenceProfiles).where(eq(domainInferenceProfiles.workspaceId, workspaceId));
  if (existing.length > 0) {
    await db
      .update(domainInferenceProfiles)
      .set({
        isDefault: true,
        feedbackConfig: input?.feedbackConfig ?? DEFAULT_RELATION_FEEDBACK_CONFIG,
        feedbackAdjustments: input?.feedbackAdjustments ?? {},
      })
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId));
    return;
  }

  await db.insert(domainInferenceProfiles).values({
    workspaceId,
    name: 'default',
    kind: 'NAMED',
    isDefault: true,
    feedbackConfig: input?.feedbackConfig ?? DEFAULT_RELATION_FEEDBACK_CONFIG,
    feedbackAdjustments: input?.feedbackAdjustments ?? {},
  });
}

describe('relation feedback loop', () => {
  let db: TestDb;
  let subjectObjectId: string;
  let objectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedWorkspace(db);
    await upsertDefaultProfile(db);
    subjectObjectId = await createService(db, 'gateway');
    objectId = await createService(db, 'orders');
  });

  it('approval/rejection을 relation feedback key 단위로 누적해야 한다', async () => {
    const approvedCandidateId = generateId();
    const rejectedCandidateId = generateId();

    await db.insert(relationCandidates).values([
      {
        id: approvedCandidateId,
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.7,
        metadata: { source: 'CODE', kind: 'call' },
        status: 'PENDING',
      },
      {
        id: rejectedCandidateId,
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.72,
        metadata: { source: 'CODE', kind: 'call' },
        status: 'PENDING',
      },
    ]);

    await approveRelationCandidate(db, approvedCandidateId, 'APPROVED');
    await approveRelationCandidate(db, rejectedCandidateId, 'REJECTED');

    const [profile] = await db
      .select({
        feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments,
      })
      .from(domainInferenceProfiles)
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId));

    const adjustments = (profile?.feedbackAdjustments ?? {}) as Record<string, Record<string, number>>;
    expect(adjustments['CALL:code:call']).toMatchObject({
      approved: 1,
      rejected: 1,
      total: 2,
      approvalRate: 0.5,
      adjustment: 0,
    });
  });

  it('minSamples 미만이면 저장 경로에서 보정을 적용하지 않아야 한다', async () => {
    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 3, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call': {
          approved: 2,
          rejected: 0,
          total: 2,
          approvalRate: 1,
          adjustment: 0.075,
        },
      },
    });

    const evidenceId = await createEvidence(db, 'fetch("/orders")');
    await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.6,
        metadata: { source: 'CODE', kind: 'call' },
      },
      evidenceId,
    );

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    expect(candidate?.confidence).toBe(0.6);
    expect((candidate?.metadata as Record<string, unknown>).feedback).toMatchObject({
      key: 'CALL:code:call',
      adjustment: 0,
      adjustedConfidence: 0.6,
      applied: false,
      sampleCount: 2,
    });
  });

  it('approval rate에 따라 상하향 보정하고 clamp해야 한다', async () => {
    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call': {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.06,
        },
        'CALL:code:reject_prone': {
          approved: 1,
          rejected: 9,
          total: 10,
          approvalRate: 0.1,
          adjustment: -0.06,
        },
        'CALL:code:perfect': {
          approved: 10,
          rejected: 0,
          total: 10,
          approvalRate: 1,
          adjustment: 0.075,
        },
      },
    });

    const upward = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.6,
      metadata: { source: 'CODE', kind: 'call' },
    });
    const downward = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.6,
      metadata: { source: 'CODE', kind: 'reject_prone' },
    });
    const clamped = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.98,
      metadata: { source: 'CODE', kind: 'perfect' },
    });

    expect(upward.confidence).toBe(0.66);
    expect((upward.metadata.feedback as Record<string, unknown>).adjustment).toBe(0.06);
    expect(downward.confidence).toBe(0.54);
    expect((downward.metadata.feedback as Record<string, unknown>).adjustment).toBe(-0.06);
    expect(clamped.confidence).toBe(0.99);
  });

  it('enabled=false이면 no-op이어야 한다', async () => {
    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: false, minSamples: 1, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call': {
          approved: 20,
          rejected: 0,
          total: 20,
          approvalRate: 1,
          adjustment: 0.075,
        },
      },
    });

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.61,
      metadata: { source: 'CODE', kind: 'call' },
    });

    expect(adjusted.confidence).toBe(0.61);
    expect((adjusted.metadata.feedback as Record<string, unknown>)).toMatchObject({
      adjustment: 0,
      adjustedConfidence: 0.61,
      applied: false,
    });
  });
});
