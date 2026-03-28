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
  accumulateRelationCandidateFeedback,
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
        metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
        status: 'PENDING',
      },
      {
        id: rejectedCandidateId,
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.72,
        metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
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
    expect(adjustments['CALL:code:call:spring_boot:java']).toMatchObject({
      approved: 1,
      rejected: 1,
      total: 2,
      approvalRate: 0.5,
      adjustment: 0,
    });
  });

  it('framework/language가 없으면 legacy v1 key로 fallback해야 한다', async () => {
    const candidateId = generateId();

    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.7,
      metadata: { source: 'CODE', kind: 'call' },
      status: 'PENDING',
    });

    await approveRelationCandidate(db, candidateId, 'APPROVED');

    const [profile] = await db
      .select({
        feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments,
      })
      .from(domainInferenceProfiles)
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId));

    const adjustments = (profile?.feedbackAdjustments ?? {}) as Record<string, Record<string, number>>;
    expect(Object.keys(adjustments)).toEqual(['CALL:code:call']);
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
        'CALL:code:call:spring_boot:java': {
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
      metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
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
    expect((upward.metadata.feedback as Record<string, unknown>).key).toBe(
      'CALL:code:call:spring_boot:java',
    );
  });

  it('specialized key가 없어도 legacy v1 bucket으로 dual-read fallback해야 한다', async () => {
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
      },
    });

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.6,
      metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
    });

    expect(adjusted.confidence).toBe(0.66);
    expect((adjusted.metadata.feedback as Record<string, unknown>)).toMatchObject({
      key: 'CALL:code:call:spring_boot:java',
      applied: true,
      sampleCount: 10,
    });
  });

  it('specialized key와 legacy key가 같이 있으면 specialized key를 우선 적용해야 한다', async () => {
    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call:spring_boot:java': {
          approved: 10,
          rejected: 0,
          total: 10,
          approvalRate: 1,
          adjustment: 0.075,
        },
        'CALL:code:call': {
          approved: 1,
          rejected: 9,
          total: 10,
          approvalRate: 0.1,
          adjustment: -0.06,
        },
      },
    });

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.6,
      metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
    });

    expect(adjusted.confidence).toBe(0.675);
    expect((adjusted.metadata.feedback as Record<string, unknown>).adjustment).toBe(0.075);
  });

  it('specialized v2 bucket이 minSamples 미만이면 mature한 legacy v1 bucket으로 fallback해야 한다', async () => {
    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call:spring_boot:java': {
          approved: 2,
          rejected: 0,
          total: 2,
          approvalRate: 1,
          adjustment: 0.075,
        },
        'CALL:code:call': {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.06,
        },
      },
    });

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.6,
      metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
    });

    expect(adjusted.confidence).toBe(0.66);
    expect((adjusted.metadata.feedback as Record<string, unknown>)).toMatchObject({
      key: 'CALL:code:call:spring_boot:java',
      adjustment: 0.06,
      sampleCount: 10,
      applied: true,
    });
  });

  it('config/db source는 framework/language가 있어도 v1 key만 사용해야 한다', async () => {
    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'READ:db:fk_constraint': {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.06,
        },
      },
    });

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'read',
      subjectObjectId,
      objectId,
      confidence: 0.6,
      metadata: {
        source: 'fk_constraint',
        framework: 'spring-boot',
        language: 'java',
      },
    });

    expect(adjusted.confidence).toBe(0.66);
    expect((adjusted.metadata.feedback as Record<string, unknown>).key).toBe('READ:db:fk_constraint');
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

  it('pending 후보 업데이트 시 기존 framework/language specialization을 보존해야 한다', async () => {
    const evidenceId1 = await createEvidence(db, 'fetch("/orders")');
    const evidenceId2 = await createEvidence(db, 'fetch("/orders/v2")');

    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call:spring_boot:java': {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.06,
        },
      },
    });

    await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.6,
        metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
      },
      evidenceId1,
    );

    await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.7,
        metadata: { source: 'CODE', kind: 'call' },
      },
      evidenceId2,
    );

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    expect(candidate?.confidence).toBe(0.76);
    expect(candidate?.metadata).toMatchObject({
      framework: 'spring-boot',
      language: 'java',
      feedback: {
        key: 'CALL:code:call:spring_boot:java',
        adjustment: 0.06,
        adjustedConfidence: 0.76,
      },
    });
  });

  it('낮은 confidence 증거가 specialization을 제공하면 pending 후보 metadata를 갱신해야 한다', async () => {
    const evidenceId1 = await createEvidence(db, 'fetch("/orders")');
    const evidenceId2 = await createEvidence(db, 'fetch("/orders/v2")');

    await upsertDefaultProfile(db, {
      feedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.15 },
      feedbackAdjustments: {
        'CALL:code:call:spring_boot:java': {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.06,
        },
      },
    });

    await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.7,
        metadata: { source: 'CODE', kind: 'call' },
      },
      evidenceId1,
    );

    await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.6,
        metadata: { source: 'CODE', kind: 'call', framework: 'spring-boot', language: 'java' },
      },
      evidenceId2,
    );

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    expect(candidate?.confidence).toBe(0.76);
    expect(candidate?.metadata).toMatchObject({
      framework: 'spring-boot',
      language: 'java',
      feedback: {
        key: 'CALL:code:call:spring_boot:java',
        adjustment: 0.06,
        adjustedConfidence: 0.76,
      },
    });
  });

  it('feedback 컬럼이 없는 스키마에서도 저장 경로가 실패하지 않아야 한다', async () => {
    const legacyDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw Object.assign(new Error('column "feedback_config" does not exist'), { code: '42703' });
            },
          }),
        }),
      }),
    };

    const adjusted = await applyFeedbackToRelationCandidateInput(legacyDb as unknown as TestDb, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.62,
      metadata: { source: 'CODE', kind: 'call' },
    });

    expect(adjusted.confidence).toBe(0.62);
    expect((adjusted.metadata.feedback as Record<string, unknown>)).toMatchObject({
      key: 'CALL:code:call',
      adjustment: 0,
      adjustedConfidence: 0.62,
      applied: false,
      sampleCount: 0,
    });
  });

  it('feedback 컬럼이 없는 스키마에서도 집계 경로가 실패하지 않아야 한다', async () => {
    let selectCallCount = 0;
    const legacyDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCallCount += 1;
              if (selectCallCount === 1) {
                throw Object.assign(new Error('column "feedback_config" does not exist'), { code: '42703' });
              }
              return [];
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: generateId() }],
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => [],
        }),
      }),
    };

    const result = await accumulateRelationCandidateFeedback(
      legacyDb as unknown as TestDb,
      {
        id: generateId(),
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        metadata: { source: 'CODE', kind: 'call' },
        confidence: 0.6,
        status: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date(),
        approvedAt: null,
        reviewedBy: null,
        evidenceId: null,
      },
      'APPROVED',
    );

    expect(result).toBeNull();
  });
});
