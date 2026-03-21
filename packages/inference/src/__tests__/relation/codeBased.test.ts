import { describe, it, expect, beforeEach } from 'vitest';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { join } from 'path';
import {
  codeArtifacts,
  codeCallEdges,
  evidences,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { eq, and } from 'drizzle-orm';
import { inferRelationsFromCodeSignals } from '@/relation/codeBased';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('inferRelationsFromCodeSignals', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000222';
  const repoRoot = '/tmp/repo';

  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-ws-codebased' });
  });

  it('call(kind=call, URL host)로 서비스 간 후보를 생성해야 한다', async () => {
    const aId = generateId();
    const bId = generateId();
    await db.insert(objects).values([
      {
        id: aId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'api-gateway',
        path: `/${aId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: bId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'user-service',
        path: `/${bId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/A.java',
      ownerObjectId: aId,
      sha256: 'x',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/A.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'restTemplate.getForObject("http://user-service/api/users", String.class);',
      metadata: { kind: 'call', confidence: 0.9 },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'http://user-service/api/users',
      weight: 1,
      evidenceId,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.candidateCount).toBe(1);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('call');
    expect(candidates[0]?.subjectObjectId).toBe(aId);
    expect(candidates[0]?.objectId).toBe(bId);

    const links = await db
      .select()
      .from(relationCandidateEvidences)
      .where(eq(relationCandidateEvidences.workspaceId, workspaceId));
    expect(links).toHaveLength(1);
    expect(links[0]?.evidenceId).toBe(evidenceId);
  });

  it('crossValidation 보정 confidence보다 낮아도 원본 confidence보다 높으면 code 후보를 갱신해야 한다', async () => {
    const aId = generateId();
    const bId = generateId();
    await db.insert(objects).values([
      {
        id: aId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'api-gateway',
        path: `/${aId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: bId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'user-service',
        path: `/${bId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    const candidateId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: aId,
      objectId: bId,
      confidence: 0.95,
      status: 'PENDING',
      metadata: {
        source: 'old',
        crossValidation: {
          validated: true,
          supportingSources: ['config', 'code'],
          originalConfidence: 0.6,
          adjustedConfidence: 0.95,
        },
      },
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/A.java',
      ownerObjectId: aId,
      sha256: 'x',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/A.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'restTemplate.getForObject("http://user-service/api/users", String.class);',
      metadata: { kind: 'call', confidence: 0.9 },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'http://user-service/api/users',
      weight: 1,
      evidenceId,
    });

    await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));

    expect(candidate?.confidence).toBeCloseTo(0.9);
    expect((candidate?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('expose + call(URL host+path) 조합이면 service -> api_endpoint 후보를 생성해야 한다', async () => {
    const callerId = generateId();
    const targetServiceId = generateId();
    await db.insert(objects).values([
      {
        id: callerId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'review-service',
        path: `/${callerId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: targetServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'user-service',
        path: `/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    // target service expose endpoint
    const targetArtifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: targetArtifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/UserController.java',
      ownerObjectId: targetServiceId,
      sha256: 't',
    });
    const exposeEvidenceId = generateId();
    await db.insert(evidences).values({
      id: exposeEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/UserController.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: '@GetMapping(\"/api/users/:id\")',
      metadata: { kind: 'expose', confidence: 0.95, method: 'GET' },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: targetArtifactId,
      calleeSymbol: '/api/users/:id',
      weight: 1,
      evidenceId: exposeEvidenceId,
    });

    // caller calls full URL
    const callerArtifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: callerArtifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/ReviewClient.java',
      ownerObjectId: callerId,
      sha256: 'c',
    });
    const callEvidenceId = generateId();
    await db.insert(evidences).values({
      id: callEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/ReviewClient.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'restTemplate.getForObject(\"http://user-service/api/users/:id\", String.class);',
      metadata: { kind: 'call', confidence: 0.9 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: callerArtifactId,
      calleeSymbol: 'http://user-service/api/users/:id',
      weight: 1,
      evidenceId: callEvidenceId,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.createdEndpointCount).toBe(1);
    expect(result.candidateCount).toBe(1);

    const endpoint = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'api_endpoint')))
      .limit(1);
    expect(endpoint[0]?.id).toBeTruthy();

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('call');
    expect(candidates[0]?.subjectObjectId).toBe(callerId);
    expect(candidates[0]?.objectId).toBe(endpoint[0]?.id);
  });

  it('produce/consume는 topic Object를 생성하고 후보를 생성해야 한다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'order-service',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/B.java',
      ownerObjectId: svcId,
      sha256: 'y',
    });

    const evProduce = generateId();
    await db.insert(evidences).values({
      id: evProduce,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/B.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'kafkaTemplate.send("orders.created", payload)',
      metadata: { kind: 'produce', confidence: 0.8 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'orders.created',
      weight: 1,
      evidenceId: evProduce,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.candidateCount).toBe(1);
    expect(result.createdTopicCount).toBe(1);

    const topic = await db
      .select()
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'topic')))
      .limit(1);
    expect(topic[0]?.name).toBe('orders.created');
  });

  it('produce/consume(channelType=queue)는 queue Object를 생성하고 후보를 생성해야 한다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'notification-service',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/Q.java',
      ownerObjectId: svcId,
      sha256: 'q',
    });

    const evProduce = generateId();
    await db.insert(evidences).values({
      id: evProduce,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/Q.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'rabbitTemplate.convertAndSend(\"email.queue\", payload)',
      metadata: { kind: 'produce', confidence: 0.8, channelType: 'queue', broker: 'rabbitmq' },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'email.queue',
      weight: 1,
      evidenceId: evProduce,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.candidateCount).toBe(1);
    expect(result.createdQueueCount).toBe(1);

    const queue = await db
      .select()
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'queue')))
      .limit(1);
    expect(queue[0]?.name).toBe('email.queue');
  });

  it('db_read/db_write는 db_table(부모=database)을 생성하고 read/write 후보를 생성해야 한다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'order-service',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/Db.java',
      ownerObjectId: svcId,
      sha256: 'db',
    });

    const evRead = generateId();
    await db.insert(evidences).values({
      id: evRead,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/Db.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: '<select>SELECT * FROM orders</select>',
      metadata: { kind: 'db_read', confidence: 0.8 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'orders',
      weight: 1,
      evidenceId: evRead,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.createdDatabaseCount).toBe(1);
    expect(result.createdDbTableCount).toBe(1);
    expect(result.candidateCount).toBe(1);

    const databaseRows = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'database')));
    expect(databaseRows).toHaveLength(1);

    const tableRows = await db
      .select({ id: objects.id, parentId: objects.parentId, name: objects.name })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'db_table')));
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]?.name).toBe('orders');
    expect(tableRows[0]?.parentId).toBe(databaseRows[0]?.id);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('read');
    expect(candidates[0]?.subjectObjectId).toBe(svcId);
    expect(candidates[0]?.objectId).toBe(tableRows[0]?.id);
  });

  it('expose는 후보를 생성하지 않아야 한다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'svc',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/C.java',
      ownerObjectId: svcId,
      sha256: 'z',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/C.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: '@GetMapping("/api/health")',
      metadata: { kind: 'expose', confidence: 0.95 },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/health',
      weight: 1,
      evidenceId,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.candidateCount).toBe(0);
  });
});
