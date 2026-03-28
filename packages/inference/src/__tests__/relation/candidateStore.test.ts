import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import {
  createPgliteClient,
  evidences,
  objectRelations,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { saveRelationCandidate } from '@/relation/candidateStore';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000071';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('saveRelationCandidate', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let subjectObjectId: string;
  let objectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'candidate-store-test' });

    subjectObjectId = generateId();
    objectId = generateId();
    await db.insert(objects).values([
      {
        id: subjectObjectId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${subjectObjectId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: objectId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'orders',
        path: `/orders/${objectId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);
  });

  it('manual relation이 있으면 후보를 만들지 않아야 한다', async () => {
    const evidenceId = generateId();
    await db.insert(objectRelations).values({
      id: generateId(),
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 1,
      status: 'APPROVED',
      source: 'MANUAL',
      metadata: {},
    });
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      excerpt: 'fetch("/orders")',
      metadata: {},
    });

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.7,
        metadata: { source: 'CODE' },
      },
      evidenceId,
    );

    expect(result.created).toBe(false);
    const candidates = await db.select().from(relationCandidates);
    expect(candidates).toHaveLength(0);
  });

  it('pending 후보가 있고 더 높은 raw confidence가 오면 갱신해야 한다', async () => {
    const candidateId = generateId();
    const evidenceId = generateId();
    const nextEvidenceId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.95,
      metadata: {
        source: 'application_yml',
        crossValidation: {
          originalConfidence: 0.5,
          adjustedConfidence: 0.95,
        },
      },
      status: 'PENDING',
    });
    await db.insert(evidences).values([
      {
        id: evidenceId,
        workspaceId,
        evidenceType: 'CONFIG',
        filePath: 'application.yml',
        excerpt: 'orders.url=http://orders',
        metadata: {},
      },
      {
        id: nextEvidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: 'src/gateway.ts',
        excerpt: 'fetch("http://orders")',
        metadata: {},
      },
    ]);
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId,
      evidenceId,
    });

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.8,
        metadata: { source: 'CODE' },
      },
      nextEvidenceId,
    );

    expect(result.created).toBe(false);

    const [candidate] = await db
      .select({
        confidence: relationCandidates.confidence,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    expect(candidate?.confidence).toBe(0.8);
    expect(candidate?.metadata).toEqual({ source: 'CODE' });

    const linkedEvidenceRows = await db
      .select()
      .from(relationCandidateEvidences)
      .where(
        and(
          eq(relationCandidateEvidences.workspaceId, workspaceId),
          eq(relationCandidateEvidences.candidateId, candidateId),
        ),
      );
    expect(linkedEvidenceRows).toHaveLength(2);
  });

  it('approved 후보가 있으면 새 후보를 만들지 않아야 한다', async () => {
    const candidateId = generateId();
    const evidenceId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.9,
      metadata: { source: 'CODE' },
      status: 'APPROVED',
    });
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      excerpt: 'fetch("http://orders")',
      metadata: {},
    });

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.95,
        metadata: { source: 'CONFIG' },
      },
      evidenceId,
    );

    expect(result.created).toBe(false);

    const candidates = await db.select().from(relationCandidates);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(candidateId);

    const linkedEvidenceRows = await db.select().from(relationCandidateEvidences);
    expect(linkedEvidenceRows).toHaveLength(0);
  });

  it('lower confidence라도 stale crossValidation 상태는 원복하고 evidence를 연결해야 한다', async () => {
    const candidateId = generateId();
    const evidenceId = generateId();
    const nextEvidenceId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.95,
      metadata: {
        source: 'application_yml',
        crossValidation: {
          originalConfidence: 0.8,
          adjustedConfidence: 0.95,
        },
      },
      status: 'PENDING',
    });
    await db.insert(evidences).values([
      {
        id: evidenceId,
        workspaceId,
        evidenceType: 'CONFIG',
        filePath: 'application.yml',
        excerpt: 'orders.url=http://orders',
        metadata: {},
      },
      {
        id: nextEvidenceId,
        workspaceId,
        evidenceType: 'CONFIG',
        filePath: 'bootstrap.yml',
        excerpt: 'orders.url=http://orders',
        metadata: {},
      },
    ]);
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId,
      evidenceId,
    });

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.7,
        metadata: { source: 'CONFIG' },
      },
      nextEvidenceId,
    );

    expect(result.created).toBe(false);

    const [candidate] = await db
      .select({
        confidence: relationCandidates.confidence,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    expect(candidate?.confidence).toBe(0.8);
    expect(candidate?.metadata).toEqual({ source: 'CONFIG' });

    const linkedEvidenceRows = await db
      .select()
      .from(relationCandidateEvidences)
      .where(eq(relationCandidateEvidences.candidateId, candidateId));
    expect(linkedEvidenceRows).toHaveLength(2);
  });

  it('기존 후보가 없으면 새 pending 후보와 evidence를 생성해야 한다', async () => {
    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      excerpt: 'fetch("http://orders")',
      metadata: {},
    });

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.85,
        metadata: { source: 'CODE' },
      },
      evidenceId,
    );

    expect(result.created).toBe(true);

    const candidates = await db.select().from(relationCandidates);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe('PENDING');
    expect(candidates[0]?.confidence).toBe(0.85);

    const linkedEvidenceRows = await db.select().from(relationCandidateEvidences);
    expect(linkedEvidenceRows).toHaveLength(1);
    expect(linkedEvidenceRows[0]?.candidateId).toBe(candidates[0]?.id);
  });

  it('lower confidence이고 crossValidation이 없으면 기존 pending 후보를 유지하고 evidence만 연결해야 한다', async () => {
    const candidateId = generateId();
    const evidenceId = generateId();
    const nextEvidenceId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.8,
      metadata: { source: 'CODE' },
      status: 'PENDING',
    });
    await db.insert(evidences).values([
      {
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: 'src/first.ts',
        excerpt: 'fetch("http://orders")',
        metadata: {},
      },
      {
        id: nextEvidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: 'src/second.ts',
        excerpt: 'fetch("http://orders")',
        metadata: {},
      },
    ]);
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId,
      evidenceId,
    });

    const result = await saveRelationCandidate(
      db,
      {
        workspaceId,
        relationType: 'call',
        subjectObjectId,
        objectId,
        confidence: 0.7,
        metadata: { source: 'CONFIG' },
      },
      nextEvidenceId,
    );

    expect(result.created).toBe(false);

    const [candidate] = await db
      .select({
        confidence: relationCandidates.confidence,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    expect(candidate?.confidence).toBe(0.8);
    expect(candidate?.metadata).toEqual({ source: 'CODE' });

    const linkedEvidenceRows = await db
      .select()
      .from(relationCandidateEvidences)
      .where(eq(relationCandidateEvidences.candidateId, candidateId));
    expect(linkedEvidenceRows).toHaveLength(2);
  });
});
