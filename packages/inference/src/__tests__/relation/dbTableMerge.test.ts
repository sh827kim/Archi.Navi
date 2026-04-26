import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb as createEmbeddedTestDb } from '@archi-navi/db';
import {
  objectDomainAffinities,
  objectRelations,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { and, eq } from 'drizzle-orm';
import {
  DbTableMergeError,
  mergeImplicitSchemaDbTableCandidate,
} from '@/relation/dbTableMerge';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

describe('mergeImplicitSchemaDbTableCandidate', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000333';
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-ws-db-table-merge' });
  });

  it('source db_table을 target db_table로 하드 병합한다', async () => {
    const serviceId = generateId();
    const databaseId = generateId();
    const sourceTableId = generateId();
    const targetTableId = generateId();
    const domainId = generateId();
    const mergeCandidateId = generateId();
    const readCandidateId = generateId();

    await db.insert(objects).values([
      {
        id: serviceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'robot-service',
        path: `/${serviceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: databaseId,
        workspaceId,
        objectType: 'database',
        category: 'STORAGE',
        granularity: 'COMPOUND',
        name: 'robot-db',
        path: `/${databaseId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: { databaseKey: 'robot-db' },
      },
      {
        id: sourceTableId,
        workspaceId,
        objectType: 'db_table',
        category: 'STORAGE',
        granularity: 'ATOMIC',
        name: 'robot_instance',
        parentId: databaseId,
        path: `/${databaseId}/${sourceTableId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { table: 'robot_instance', observedByServiceIds: ['svc-a'] },
      },
      {
        id: targetTableId,
        workspaceId,
        objectType: 'db_table',
        category: 'STORAGE',
        granularity: 'ATOMIC',
        name: 'schema_a.robot_instance',
        parentId: databaseId,
        path: `/${databaseId}/${targetTableId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { table: 'robot_instance', schema: 'schema_a', observedByServiceIds: ['svc-b'] },
      },
      {
        id: domainId,
        workspaceId,
        objectType: 'domain',
        category: 'LOGICAL',
        granularity: 'COMPOUND',
        name: 'robot',
        path: `/domains/${domainId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    await db.insert(relationCandidates).values([
      {
        id: mergeCandidateId,
        workspaceId,
        relationType: 'same_db_table',
        subjectObjectId: sourceTableId,
        objectId: targetTableId,
        confidence: 0.65,
        metadata: { reason: 'implicit_schema_match' },
        status: 'PENDING',
      },
      {
        id: readCandidateId,
        workspaceId,
        relationType: 'read',
        subjectObjectId: serviceId,
        objectId: sourceTableId,
        confidence: 0.72,
        metadata: { table: 'robot_instance' },
        status: 'PENDING',
      },
    ]);

    await db.insert(objectRelations).values({
      id: generateId(),
      workspaceId,
      relationType: 'read',
      subjectObjectId: serviceId,
      objectId: sourceTableId,
      confidence: 0.7,
      status: 'APPROVED',
      source: 'INFERRED',
      metadata: {},
    });
    await db.insert(objectDomainAffinities).values([
      {
        id: generateId(),
        workspaceId,
        objectId: sourceTableId,
        domainId,
        affinity: 0.8,
        confidence: 0.7,
        source: 'APPROVED_INFERENCE',
      },
      {
        id: generateId(),
        workspaceId,
        objectId: targetTableId,
        domainId,
        affinity: 0.6,
        confidence: 0.9,
        source: 'APPROVED_INFERENCE',
      },
    ]);

    const result = await mergeImplicitSchemaDbTableCandidate(db, {
      workspaceId,
      candidateId: mergeCandidateId,
    });

    expect(result).toMatchObject({
      success: true,
      sourceObjectId: sourceTableId,
      targetObjectId: targetTableId,
      mergedDomainAffinityCount: 1,
      affectedDomainIds: [domainId],
    });

    const sourceRows = await db
      .select({ id: objects.id })
      .from(objects)
      .where(eq(objects.id, sourceTableId));
    expect(sourceRows).toHaveLength(0);

    const [target] = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(eq(objects.id, targetTableId))
      .limit(1);
    expect(target?.metadata).toMatchObject({
      mergedObjectIds: [sourceTableId],
      implicitTableAliases: ['robot_instance'],
      observedByServiceIds: ['svc-a', 'svc-b'],
    });

    const [readCandidate] = await db
      .select({
        objectId: relationCandidates.objectId,
        status: relationCandidates.status,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, readCandidateId))
      .limit(1);
    expect(readCandidate).toMatchObject({ objectId: targetTableId, status: 'PENDING' });

    const [mergeCandidate] = await db
      .select({
        subjectObjectId: relationCandidates.subjectObjectId,
        objectId: relationCandidates.objectId,
        status: relationCandidates.status,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, mergeCandidateId))
      .limit(1);
    expect(mergeCandidate).toMatchObject({
      subjectObjectId: targetTableId,
      objectId: targetTableId,
      status: 'APPROVED',
    });

    const [relation] = await db
      .select({ objectId: objectRelations.objectId })
      .from(objectRelations)
      .where(and(eq(objectRelations.workspaceId, workspaceId), eq(objectRelations.relationType, 'read')))
      .limit(1);
    expect(relation?.objectId).toBe(targetTableId);

    const [affinity] = await db
      .select({
        objectId: objectDomainAffinities.objectId,
        affinity: objectDomainAffinities.affinity,
        confidence: objectDomainAffinities.confidence,
      })
      .from(objectDomainAffinities)
      .where(
        and(
          eq(objectDomainAffinities.workspaceId, workspaceId),
          eq(objectDomainAffinities.domainId, domainId),
        ),
      )
      .limit(1);
    expect(affinity).toMatchObject({
      objectId: targetTableId,
      affinity: 0.8,
      confidence: 0.9,
    });
  });

  it('source와 target base table명이 다르면 거부한다', async () => {
    const databaseId = generateId();
    const sourceTableId = generateId();
    const targetTableId = generateId();
    const mergeCandidateId = generateId();

    await db.insert(objects).values([
      {
        id: databaseId,
        workspaceId,
        objectType: 'database',
        category: 'STORAGE',
        granularity: 'COMPOUND',
        name: 'robot-db',
        path: `/${databaseId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: sourceTableId,
        workspaceId,
        objectType: 'db_table',
        category: 'STORAGE',
        granularity: 'ATOMIC',
        name: 'robot_instance',
        parentId: databaseId,
        path: `/${databaseId}/${sourceTableId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { table: 'robot_instance' },
      },
      {
        id: targetTableId,
        workspaceId,
        objectType: 'db_table',
        category: 'STORAGE',
        granularity: 'ATOMIC',
        name: 'schema_a.robot_status',
        parentId: databaseId,
        path: `/${databaseId}/${targetTableId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { table: 'robot_status', schema: 'schema_a' },
      },
    ]);
    await db.insert(relationCandidates).values({
      id: mergeCandidateId,
      workspaceId,
      relationType: 'same_db_table',
      subjectObjectId: sourceTableId,
      objectId: targetTableId,
      confidence: 0.65,
      metadata: { reason: 'implicit_schema_match' },
      status: 'PENDING',
    });

    await expect(
      mergeImplicitSchemaDbTableCandidate(db, { workspaceId, candidateId: mergeCandidateId }),
    ).rejects.toMatchObject({
      code: 'MERGE_TABLE_NAME_MISMATCH',
    } satisfies Partial<DbTableMergeError>);
  });
});
