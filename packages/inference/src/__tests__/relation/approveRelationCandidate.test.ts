/**
 * approveRelationCandidate 통합 테스트
 * 승인 시 object_relations 생성 + relation_candidate_evidences 승격 검증
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  evidences,
  objectRelations,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  relationEvidences,
  workspaces,
} from '@archi-navi/db';
import { and, eq } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { approveRelationCandidate } from '../../relation/approveRelationCandidate.js';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000030';

async function setupWorkspace(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
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
    path: `/${id}`,
    depth: 0,
    metadata: {},
  });
  return id;
}

async function createCandidate(
  db: TestDb,
  subjectObjectId: string,
  objectId: string,
): Promise<string> {
  const id = generateId();
  await db.insert(relationCandidates).values({
    id,
    workspaceId,
    relationType: 'call',
    subjectObjectId,
    objectId,
    confidence: 0.82,
    metadata: { sourceHint: 'unit-test' },
    status: 'PENDING',
  });
  return id;
}

async function createEvidence(db: TestDb, filePath: string): Promise<string> {
  const id = generateId();
  await db.insert(evidences).values({
    id,
    workspaceId,
    evidenceType: 'FILE',
    filePath,
    lineStart: 10,
    lineEnd: 12,
    excerpt: 'test excerpt',
    metadata: {},
  });
  return id;
}

describe('approveRelationCandidate', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await setupWorkspace(db);
  });

  it('T1: candidate not found → Error throw', async () => {
    await expect(
      approveRelationCandidate(db, '00000000-0000-0000-0000-000000000099', 'APPROVED'),
    ).rejects.toThrow('candidate not found');
  });

  it('T2: REJECTED → 상태만 변경되고 확정 관계/증거는 생성되지 않아야 한다', async () => {
    const subjectId = await createService(db, 'order-service');
    const objectId = await createService(db, 'payment-service');
    const candidateId = await createCandidate(db, subjectId, objectId);

    const result = await approveRelationCandidate(db, candidateId, 'REJECTED');

    expect(result.success).toBe(true);
    expect(result.status).toBe('REJECTED');
    expect(result.promotedEvidenceCount).toBe(0);

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId))
      .limit(1);
    expect(candidate?.status).toBe('REJECTED');
    expect(candidate?.reviewedAt).not.toBeNull();

    const relations = await db
      .select()
      .from(objectRelations)
      .where(eq(objectRelations.workspaceId, workspaceId));
    expect(relations).toHaveLength(0);
  });

  it('T3: APPROVED → object_relations 생성 + relation_evidences 승격', async () => {
    const subjectId = await createService(db, 'order-service');
    const objectId = await createService(db, 'payment-service');
    const candidateId = await createCandidate(db, subjectId, objectId);

    const evidenceA = await createEvidence(db, '/repo/order/service.ts');
    const evidenceB = await createEvidence(db, '/repo/order/client.ts');
    await db.insert(relationCandidateEvidences).values([
      { workspaceId, candidateId, evidenceId: evidenceA },
      { workspaceId, candidateId, evidenceId: evidenceB },
    ]);

    const result = await approveRelationCandidate(db, candidateId, 'APPROVED');

    expect(result.success).toBe(true);
    expect(result.status).toBe('APPROVED');
    expect(result.relationId).toBeDefined();
    expect(result.promotedEvidenceCount).toBe(2);

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId))
      .limit(1);
    expect(candidate?.status).toBe('APPROVED');
    expect(candidate?.reviewedAt).not.toBeNull();

    const [approvedRelation] = await db
      .select()
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.subjectObjectId, subjectId),
          eq(objectRelations.objectId, objectId),
          eq(objectRelations.relationType, 'call'),
          eq(objectRelations.isDerived, false),
        ),
      )
      .limit(1);
    expect(approvedRelation).toBeDefined();
    expect(approvedRelation?.source).toBe('INFERRED');

    const promoted = await db
      .select()
      .from(relationEvidences)
      .where(eq(relationEvidences.relationId, approvedRelation!.id));
    expect(promoted).toHaveLength(2);
  });

  it('T4: 기존 확정 관계가 있어도 중복 없이 부족한 evidence만 승격해야 한다', async () => {
    const subjectId = await createService(db, 'user-service');
    const objectId = await createService(db, 'auth-service');
    const candidateId = await createCandidate(db, subjectId, objectId);

    const existingRelationId = generateId();
    await db.insert(objectRelations).values({
      id: existingRelationId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: subjectId,
      objectId,
      confidence: 0.7,
      status: 'APPROVED',
      source: 'INFERRED',
      metadata: {},
    });

    const evidenceA = await createEvidence(db, '/repo/user/a.ts');
    const evidenceB = await createEvidence(db, '/repo/user/b.ts');
    await db.insert(relationCandidateEvidences).values([
      { workspaceId, candidateId, evidenceId: evidenceA },
      { workspaceId, candidateId, evidenceId: evidenceB },
    ]);
    await db.insert(relationEvidences).values({
      workspaceId,
      relationId: existingRelationId,
      evidenceId: evidenceA,
    });

    const result = await approveRelationCandidate(db, candidateId, 'APPROVED');
    expect(result.relationId).toBe(existingRelationId);
    expect(result.promotedEvidenceCount).toBe(1);

    const relations = await db
      .select()
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.subjectObjectId, subjectId),
          eq(objectRelations.objectId, objectId),
          eq(objectRelations.relationType, 'call'),
          eq(objectRelations.isDerived, false),
        ),
      );
    expect(relations).toHaveLength(1);

    const promoted = await db
      .select()
      .from(relationEvidences)
      .where(eq(relationEvidences.relationId, existingRelationId));
    expect(promoted).toHaveLength(2);
  });
});
