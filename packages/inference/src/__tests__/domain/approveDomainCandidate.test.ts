/**
 * approveDomainCandidate 통합 테스트
 * PGlite 인메모리 DB로 도메인 후보 승인/거부 + object_domain_affinities 생성 검증
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  domainCandidates,
  domainInferenceProfiles,
  objectDomainAffinities,
  objects,
  workspaces,
} from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { approveDomainCandidate } from '@/domain/approveDomainCandidate';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
    const db = createPgliteClient();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000020';

async function setupWorkspace(db: TestDb) {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
}

/** service object 생성 헬퍼 */
async function createService(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** domain object 생성 헬퍼 */
async function createDomain(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'domain',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** domain_candidates 레코드 생성 헬퍼 */
async function createCandidate(
  db: TestDb,
  serviceId: string,
  affinityMap: Record<string, number>,
  purity: number,
  primaryDomainId?: string,
  signals: Record<string, unknown> = {},
): Promise<string> {
    const id = generateId();
    await db.insert(domainCandidates).values({
        id,
        workspaceId,
        objectId: serviceId,
        affinityMap,
        purity,
        ...(primaryDomainId ? { primaryDomainId } : {}),
        secondaryDomainIds: [],
        signals,
        status: 'PENDING',
    });
    return id;
}

async function readDomainFeedbackAdjustments(db: TestDb) {
  const [profile] = await db
    .select({
      domainFeedbackAdjustments: domainInferenceProfiles.domainFeedbackAdjustments,
    })
    .from(domainInferenceProfiles)
    .where(eq(domainInferenceProfiles.workspaceId, workspaceId));

  return (profile?.domainFeedbackAdjustments ?? {}) as Record<string, {
    approved: number;
    rejected: number;
    total: number;
    approvalRate: number;
    adjustment: number;
  }>;
}

describe('approveDomainCandidate', () => {
    let db: TestDb;

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    it('T1: candidate not found → Error throw', async () => {
        const nonExistentId = '00000000-0000-0000-0000-000000000099';
        await expect(
            approveDomainCandidate(db, nonExistentId, 'APPROVED'),
        ).rejects.toThrow('candidate not found');
    });

    it('T2: REJECTED → status 업데이트, affinities 생성 안함', async () => {
        const serviceId = await createService(db, 'order-service');
        const domainId = await createDomain(db, 'order');
        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domainId]: 0.8 },
            0.8,
            domainId,
        );

        const result = await approveDomainCandidate(db, candidateId, 'REJECTED');

        expect(result.success).toBe(true);
        expect(result.status).toBe('REJECTED');
        expect(result.affinityCount).toBe(0);

        // domain_candidates 상태 확인
        const rows = await db
            .select()
            .from(domainCandidates)
            .where(eq(domainCandidates.id, candidateId));
        const updated = rows[0];
        expect(updated).toBeDefined();
        expect(updated?.status).toBe('REJECTED');
        expect(updated?.reviewedAt).not.toBeNull();

        // object_domain_affinities 없어야 함
        const affinities = await db
            .select()
            .from(objectDomainAffinities)
            .where(eq(objectDomainAffinities.objectId, serviceId));
        expect(affinities).toHaveLength(0);
    });

    it('T3: APPROVED → domain_candidates status 업데이트 및 reviewedAt 설정', async () => {
        const serviceId = await createService(db, 'payment-service');
        const domainId = await createDomain(db, 'payment');
        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domainId]: 1.0 },
            0.9,
            domainId,
        );

        const before = Date.now();
        await approveDomainCandidate(db, candidateId, 'APPROVED');

        const rows = await db
            .select()
            .from(domainCandidates)
            .where(eq(domainCandidates.id, candidateId));
        const updated = rows[0];
        expect(updated).toBeDefined();
        expect(updated?.status).toBe('APPROVED');
        expect(updated?.reviewedAt).not.toBeNull();
        // reviewedAt이 현재 시각 근처인지 확인
        const reviewedTime = updated?.reviewedAt?.getTime() ?? 0;
        expect(reviewedTime).toBeGreaterThanOrEqual(before - 1000);
    });

    it('T4: APPROVED → affinityMap 각 항목에 대해 object_domain_affinities 생성', async () => {
        const serviceId = await createService(db, 'user-service');
        const domain1Id = await createDomain(db, 'user');
        const domain2Id = await createDomain(db, 'auth');

        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domain1Id]: 0.7, [domain2Id]: 0.3 },
            0.75,
            domain1Id,
        );

        const result = await approveDomainCandidate(db, candidateId, 'APPROVED');
        expect(result.affinityCount).toBe(2);

        const affinities = await db
            .select()
            .from(objectDomainAffinities)
            .where(eq(objectDomainAffinities.objectId, serviceId));
        expect(affinities).toHaveLength(2);

        const d1Affinity = affinities.find((a) => a.domainId === domain1Id);
        const d2Affinity = affinities.find((a) => a.domainId === domain2Id);
        expect(d1Affinity?.affinity).toBeCloseTo(0.7, 5);
        expect(d2Affinity?.affinity).toBeCloseTo(0.3, 5);
    });

    it('T5: APPROVED → confidence = candidate.purity, source = APPROVED_INFERENCE', async () => {
        const serviceId = await createService(db, 'inventory-service');
        const domainId = await createDomain(db, 'inventory');
        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domainId]: 0.9 },
            0.85,
            domainId,
        );

        await approveDomainCandidate(db, candidateId, 'APPROVED');

        const affinityRows = await db
            .select()
            .from(objectDomainAffinities)
            .where(eq(objectDomainAffinities.objectId, serviceId));
        const affinity = affinityRows[0];
        expect(affinity).toBeDefined();

        expect(affinity?.confidence).toBeCloseTo(0.85, 5);
        expect(affinity?.source).toBe('APPROVED_INFERENCE');
    });

    it('T6: APPROVED 중복 → upsert (기존 affinities 업데이트)', async () => {
        const serviceId = await createService(db, 'catalog-service');
        const domainId = await createDomain(db, 'catalog');

        // 첫 번째 후보 승인
        const candidate1Id = await createCandidate(
            db,
            serviceId,
            { [domainId]: 0.6 },
            0.6,
            domainId,
        );
        await approveDomainCandidate(db, candidate1Id, 'APPROVED');

        // 두 번째 후보 승인 (같은 objectId + domainId, 다른 affinity)
        const candidate2Id = await createCandidate(
            db,
            serviceId,
            { [domainId]: 0.9 },
            0.9,
            domainId,
        );
        await approveDomainCandidate(db, candidate2Id, 'APPROVED');

        // upsert로 하나만 남아야 함
        const affinities = await db
            .select()
            .from(objectDomainAffinities)
            .where(eq(objectDomainAffinities.objectId, serviceId));
        expect(affinities).toHaveLength(1);
        // 두 번째 값으로 업데이트 되어야 함
        const firstAffinity = affinities[0];
        expect(firstAffinity).toBeDefined();
        expect(firstAffinity?.affinity).toBeCloseTo(0.9, 5);
    });

    it('T7: 최초 전이만 domain feedback를 집계해야 한다', async () => {
        const serviceId = await createService(db, 'repeat-service');
        const domainId = await createDomain(db, 'repeat');
        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domainId]: 1 },
            0.91,
            domainId,
        );

        await approveDomainCandidate(db, candidateId, 'APPROVED');
        await approveDomainCandidate(db, candidateId, 'APPROVED');

        const adjustments = await readDomainFeedbackAdjustments(db);
        expect(adjustments[`TRACK_A:${domainId}:HIGH`]).toMatchObject({
            approved: 1,
            rejected: 0,
            total: 1,
            approvalRate: 1,
        });
    });

    it('T8: primaryDomainId가 없으면 feedback 집계는 no-op이어야 한다', async () => {
        const serviceId = await createService(db, 'orphan-service');
        const domainId = await createDomain(db, 'orphan');
        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domainId]: 1 },
            0.88,
        );

        await approveDomainCandidate(db, candidateId, 'APPROVED');

        const adjustments = await readDomainFeedbackAdjustments(db);
        expect(adjustments).toEqual({});
    });

    it('T9: feedback.basePurity가 있으면 보정 전 purity bucket으로 집계해야 한다', async () => {
        const serviceId = await createService(db, 'bucketed-service');
        const domainId = await createDomain(db, 'bucketed');
        const candidateId = await createCandidate(
            db,
            serviceId,
            { [domainId]: 1 },
            0.83,
            domainId,
            {
                feedback: {
                    basePurity: 0.78,
                    adjustedPurity: 0.83,
                },
            },
        );

        await approveDomainCandidate(db, candidateId, 'APPROVED');

        const adjustments = await readDomainFeedbackAdjustments(db);
        expect(adjustments[`TRACK_A:${domainId}:MEDIUM`]).toMatchObject({
            approved: 1,
            rejected: 0,
            total: 1,
        });
        expect(adjustments[`TRACK_A:${domainId}:HIGH`]).toBeUndefined();
    });
});
