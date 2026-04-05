import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createTestDb as createEmbeddedTestDb,
  domainCandidates,
  domainInferenceProfiles,
  objects,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  DEFAULT_DOMAIN_FEEDBACK_CONFIG,
  accumulateDomainCandidateFeedback,
  applyDomainFeedbackToSeedCandidate,
  deriveDomainFeedbackDescriptor,
} from '@/domain/feedbackLoop';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function seedWorkspace(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'domain-feedback-test' });
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

async function createDomain(db: TestDb, name: string): Promise<string> {
  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'domain',
    granularity: 'COMPOUND',
    name,
    path: `/${name}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });
  return id;
}

async function createCandidate(
  db: TestDb,
  serviceId: string,
  primaryDomainId: string | null,
  purity: number,
): Promise<typeof domainCandidates.$inferSelect> {
  const candidateId = generateId();
  await db.insert(domainCandidates).values({
    id: candidateId,
    workspaceId,
    objectId: serviceId,
    affinityMap: primaryDomainId ? { [primaryDomainId]: 1 } : {},
    purity,
    primaryDomainId: primaryDomainId ?? undefined,
    secondaryDomainIds: [],
    signals: {},
    status: 'PENDING',
  });

  const [candidate] = await db
    .select()
    .from(domainCandidates)
    .where(eq(domainCandidates.id, candidateId));
  if (!candidate) {
    throw new Error('candidate not found');
  }
  return candidate;
}

async function upsertDefaultProfile(
  db: TestDb,
  input?: {
    domainFeedbackConfig?: Record<string, unknown>;
    domainFeedbackAdjustments?: Record<string, unknown>;
  },
) {
  const existing = await db
    .select()
    .from(domainInferenceProfiles)
    .where(eq(domainInferenceProfiles.workspaceId, workspaceId));

  if (existing.length > 0) {
    await db
      .update(domainInferenceProfiles)
      .set({
        isDefault: true,
        domainFeedbackConfig: input?.domainFeedbackConfig ?? DEFAULT_DOMAIN_FEEDBACK_CONFIG,
        domainFeedbackAdjustments: input?.domainFeedbackAdjustments ?? {},
      })
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId));
    return;
  }

  await db.insert(domainInferenceProfiles).values({
    workspaceId,
    name: 'default',
    kind: 'NAMED',
    isDefault: true,
    domainFeedbackConfig: input?.domainFeedbackConfig ?? DEFAULT_DOMAIN_FEEDBACK_CONFIG,
    domainFeedbackAdjustments: input?.domainFeedbackAdjustments ?? {},
  });
}

describe('domain feedback loop', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seedWorkspace(db);
  });

  it('Track A key를 TRACK_A:{primaryDomainId}:{purityBucket} 형식으로 유도해야 한다', () => {
    expect(
      deriveDomainFeedbackDescriptor({
        primaryDomainId: 'domain-order',
        purity: 0.92,
        track: 'TRACK_A',
      }),
    ).toEqual({
      key: 'TRACK_A:domain-order:HIGH',
      track: 'TRACK_A',
      primaryDomainId: 'domain-order',
      purityBucket: 'HIGH',
    });
  });

  it('minSamples 미만이면 Track A 후보 생성 시 보정을 적용하지 않아야 한다', async () => {
    const domainId = await createDomain(db, 'orders');
    await upsertDefaultProfile(db, {
      domainFeedbackConfig: { enabled: true, minSamples: 3, maxAdjustment: 0.15 },
      domainFeedbackAdjustments: {
        [`TRACK_A:${domainId}:HIGH`]: {
          approved: 2,
          rejected: 0,
          total: 2,
          approvalRate: 1,
          adjustment: 0.075,
        },
      },
    });

    const result = await applyDomainFeedbackToSeedCandidate(db, {
      workspaceId,
      primaryDomainId: domainId,
      purity: 0.9,
      track: 'TRACK_A',
    });

    expect(result.purity).toBe(0.9);
    expect(result.feedback).toMatchObject({
      key: `TRACK_A:${domainId}:HIGH`,
      adjustment: 0,
      adjustedPurity: 0.9,
      applied: false,
      sampleCount: 2,
    });
  });

  it('approval rate에 따라 purity를 상하향 보정하고 clamp해야 한다', async () => {
    const upwardDomainId = await createDomain(db, 'payments');
    const mediumDomainId = await createDomain(db, 'billing');
    const clampedDomainId = await createDomain(db, 'checkout');
    await upsertDefaultProfile(db, {
      domainFeedbackConfig: { enabled: true, minSamples: 10, maxAdjustment: 0.2 },
      domainFeedbackAdjustments: {
        [`TRACK_A:${upwardDomainId}:HIGH`]: {
          approved: 9,
          rejected: 1,
          total: 10,
          approvalRate: 0.9,
          adjustment: 0.08,
        },
        [`TRACK_A:${mediumDomainId}:MEDIUM`]: {
          approved: 1,
          rejected: 9,
          total: 10,
          approvalRate: 0.1,
          adjustment: -0.08,
        },
        [`TRACK_A:${clampedDomainId}:HIGH`]: {
          approved: 10,
          rejected: 0,
          total: 10,
          approvalRate: 1,
          adjustment: 0.1,
        },
      },
    });

    const upward = await applyDomainFeedbackToSeedCandidate(db, {
      workspaceId,
      primaryDomainId: upwardDomainId,
      purity: 0.82,
      track: 'TRACK_A',
    });
    const downward = await applyDomainFeedbackToSeedCandidate(db, {
      workspaceId,
      primaryDomainId: mediumDomainId,
      purity: 0.62,
      track: 'TRACK_A',
    });
    const clamped = await applyDomainFeedbackToSeedCandidate(db, {
      workspaceId,
      primaryDomainId: clampedDomainId,
      purity: 0.96,
      track: 'TRACK_A',
    });

    expect(upward.purity).toBe(0.9);
    expect(upward.feedback).toMatchObject({
      key: `TRACK_A:${upwardDomainId}:HIGH`,
      adjustment: 0.08,
      adjustedPurity: 0.9,
      applied: true,
    });
    expect(downward.purity).toBe(0.54);
    expect(downward.feedback).toMatchObject({
      key: `TRACK_A:${mediumDomainId}:MEDIUM`,
      adjustment: -0.08,
      adjustedPurity: 0.54,
      applied: true,
    });
    expect(clamped.purity).toBe(1);
    expect(clamped.feedback).toMatchObject({
      key: `TRACK_A:${clampedDomainId}:HIGH`,
      adjustment: 0.1,
      adjustedPurity: 1,
      applied: true,
    });
  });

  it('Track B와 primaryDomainId 없음은 집계에서 no-op이어야 한다', async () => {
    const serviceId = await createService(db, 'orders-api');
    const domainId = await createDomain(db, 'orders');
    const trackBCandidate = await createCandidate(db, serviceId, domainId, 0.84);
    const noPrimaryCandidate = await createCandidate(db, serviceId, null, 0.84);

    const trackBResult = await accumulateDomainCandidateFeedback(db, trackBCandidate, 'APPROVED', {
      track: 'TRACK_B',
    });
    const noPrimaryResult = await accumulateDomainCandidateFeedback(db, noPrimaryCandidate, 'APPROVED');

    expect(trackBResult).toBeNull();
    expect(noPrimaryResult).toBeNull();

    const profiles = await db
      .select()
      .from(domainInferenceProfiles)
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId));
    expect(profiles).toHaveLength(0);
  });

  it('domain feedback 컬럼이 없는 스키마에서도 seed candidate 적용 경로가 실패하지 않아야 한다', async () => {
    const legacyDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw Object.assign(new Error('column "domain_feedback_config" does not exist'), { code: '42703' });
            },
          }),
        }),
      }),
    };

    const result = await applyDomainFeedbackToSeedCandidate(legacyDb as unknown as TestDb, {
      workspaceId,
      primaryDomainId: 'domain-order',
      purity: 0.82,
      track: 'TRACK_A',
    });

    expect(result.purity).toBe(0.82);
    expect(result.feedback).toMatchObject({
      key: 'TRACK_A:domain-order:HIGH',
      adjustment: 0,
      adjustedPurity: 0.82,
      applied: false,
      sampleCount: 0,
    });
  });

  it('domain feedback 컬럼이 없는 스키마에서도 집계 경로가 실패하지 않아야 한다', async () => {
    let selectCallCount = 0;
    const legacyDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCallCount += 1;
              if (selectCallCount === 1) {
                throw Object.assign(new Error('column "domain_feedback_config" does not exist'), { code: '42703' });
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

    const result = await accumulateDomainCandidateFeedback(
      legacyDb as unknown as TestDb,
      {
        id: generateId(),
        workspaceId,
        objectId: generateId(),
        affinityMap: {},
        purity: 0.72,
        primaryDomainId: 'domain-order',
        secondaryDomainIds: [],
        signals: {},
        status: 'PENDING',
        reviewedAt: null,
        reviewedBy: null,
        runId: null,
        createdAt: new Date(),
      },
      'APPROVED',
    );

    expect(result).toBeNull();
  });
});
