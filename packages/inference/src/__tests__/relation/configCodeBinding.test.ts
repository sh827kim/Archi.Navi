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
import { bindConfigToCodeEndpoints } from '@/relation/configCodeBinding';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000041';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('bindConfigToCodeEndpoints', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'binding-test' });
  });

  it('이미 확정된 endpoint relation이 있으면 크로스 바인딩 후보를 생성하지 않아야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const configEvidenceId = generateId();
    const repoRoot = '/tmp/repo-a';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: { source: 'application_yml', repoRoot },
      status: 'PENDING',
    });
    await db.insert(evidences).values({
      id: configEvidenceId,
      workspaceId,
      evidenceType: 'CONFIG',
      filePath: `${repoRoot}/application.yml`,
      excerpt: 'zuul.routes.order.serviceId=orders',
      metadata: {},
    });
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId: compoundCandidateId,
      evidenceId: configEvidenceId,
    });

    await db.insert(objectRelations).values({
      id: generateId(),
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: endpointId,
      confidence: 1,
      status: 'APPROVED',
      source: 'MANUAL',
      metadata: {},
    });

    const result = await bindConfigToCodeEndpoints(db, { workspaceId });

    expect(result.compoundCandidateCount).toBe(1);
    expect(result.createdEndpointCandidateCount).toBe(0);

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );

    expect(endpointCandidates).toHaveLength(0);
  });

  it('stale crossValidation 상태를 endpoint 후보로 복제하지 않아야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const evidenceId = generateId();
    const repoRoot = '/tmp/repo-a';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot, source: 'CODE' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.95,
      metadata: {
        source: 'application_yml',
        crossValidation: {
          validated: true,
          supportingSources: ['config', 'code'],
          originalConfidence: 0.7,
          adjustedConfidence: 0.95,
        },
      },
      status: 'PENDING',
    });
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'CONFIG',
      filePath: `${repoRoot}/application.yml`,
      excerpt: 'zuul.routes.order.serviceId=orders',
      metadata: {},
    });
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId: compoundCandidateId,
      evidenceId,
    });

    const result = await bindConfigToCodeEndpoints(db, { workspaceId, repoRoots: [repoRoot] });

    expect(result.createdEndpointCandidateCount).toBe(1);

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );

    expect(endpointCandidates).toHaveLength(1);
    expect(endpointCandidates[0]?.confidence).toBeCloseTo(0.595);
    expect(
      ((endpointCandidates[0]?.metadata ?? {}) as Record<string, unknown>)['crossValidation'],
    ).toBeUndefined();
  });

  it('crossBound endpoint 후보는 부모 후보의 code evidence를 상속하지 않아야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const configEvidenceId = generateId();
    const codeEvidenceId = generateId();
    const repoRoot = '/tmp/repo-a';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot, source: 'CODE' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: { source: 'application_yml' },
      status: 'PENDING',
    });
    await db.insert(evidences).values([
      {
        id: configEvidenceId,
        workspaceId,
        evidenceType: 'CONFIG',
        filePath: `${repoRoot}/application.yml`,
        excerpt: 'zuul.routes.order.serviceId=orders',
        metadata: {},
      },
      {
        id: codeEvidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: `${repoRoot}/src/gateway.ts`,
        excerpt: 'client.get("/orders")',
        metadata: {},
      },
    ]);
    await db.insert(relationCandidateEvidences).values([
      { workspaceId, candidateId: compoundCandidateId, evidenceId: configEvidenceId },
      { workspaceId, candidateId: compoundCandidateId, evidenceId: codeEvidenceId },
    ]);

    const result = await bindConfigToCodeEndpoints(db, { workspaceId, repoRoots: [repoRoot] });

    expect(result.createdEndpointCandidateCount).toBe(1);

    const [endpointCandidate] = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );
    const linkedEvidences = await db
      .select({
        evidenceId: relationCandidateEvidences.evidenceId,
        evidenceType: evidences.evidenceType,
      })
      .from(relationCandidateEvidences)
      .innerJoin(evidences, eq(relationCandidateEvidences.evidenceId, evidences.id))
      .where(eq(relationCandidateEvidences.candidateId, endpointCandidate!.id));

    expect(endpointCandidate).toBeTruthy();
    expect(linkedEvidences).toEqual([
      { evidenceId: configEvidenceId, evidenceType: 'CONFIG' },
    ]);
  });

  it('LLM_CONFIG evidence도 crossBound endpoint 후보에 config evidence로만 복사해야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const llmConfigEvidenceId = generateId();
    const codeEvidenceId = generateId();
    const repoRoot = '/tmp/repo-a';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot, source: 'CODE' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: { source: 'LLM_CONFIG' },
      status: 'PENDING',
    });
    await db.insert(evidences).values([
      {
        id: llmConfigEvidenceId,
        workspaceId,
        evidenceType: 'LLM_CONFIG',
        filePath: `${repoRoot}/application.yml`,
        excerpt: 'gateway routes to orders',
        metadata: {},
      },
      {
        id: codeEvidenceId,
        workspaceId,
        evidenceType: 'LLM_CODE',
        filePath: `${repoRoot}/src/gateway.ts`,
        excerpt: 'client.get(\"/orders\")',
        metadata: {},
      },
    ]);
    await db.insert(relationCandidateEvidences).values([
      { workspaceId, candidateId: compoundCandidateId, evidenceId: llmConfigEvidenceId },
      { workspaceId, candidateId: compoundCandidateId, evidenceId: codeEvidenceId },
    ]);

    await bindConfigToCodeEndpoints(db, { workspaceId, repoRoots: [repoRoot] });

    const [endpointCandidate] = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );
    const linkedEvidences = await db
      .select({
        evidenceId: relationCandidateEvidences.evidenceId,
        evidenceType: evidences.evidenceType,
      })
      .from(relationCandidateEvidences)
      .innerJoin(evidences, eq(relationCandidateEvidences.evidenceId, evidences.id))
      .where(eq(relationCandidateEvidences.candidateId, endpointCandidate!.id));

    expect(linkedEvidences).toEqual([
      { evidenceId: llmConfigEvidenceId, evidenceType: 'LLM_CONFIG' },
    ]);
  });

  it('repo-scoped binding에서도 다른 repo root 서비스의 endpoint 후보를 생성해야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const configEvidenceId = generateId();
    const callerRepoRoot = '/tmp/repo-a';
    const calleeRepoRoot = '/tmp/repo-b';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot: calleeRepoRoot, source: 'CODE' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: { source: 'application_yml', repoRoot: callerRepoRoot },
      status: 'PENDING',
    });
    await db.insert(evidences).values({
      id: configEvidenceId,
      workspaceId,
      evidenceType: 'CONFIG',
      filePath: `${callerRepoRoot}/application.yml`,
      excerpt: 'zuul.routes.order.serviceId=orders',
      metadata: {},
    });
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId: compoundCandidateId,
      evidenceId: configEvidenceId,
    });

    const result = await bindConfigToCodeEndpoints(db, { workspaceId, repoRoots: [callerRepoRoot] });

    expect(result.compoundCandidateCount).toBe(1);
    expect(result.createdEndpointCandidateCount).toBe(1);

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );

    expect(endpointCandidates).toHaveLength(1);
  });

  it('repo-scoped binding은 config provenance가 선택 repo에 있을 때만 부모 후보를 분해해야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const configEvidenceId = generateId();
    const codeEvidenceId = generateId();
    const selectedRepoRoot = '/tmp/repo-a';
    const staleConfigRepoRoot = '/tmp/repo-b';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot: staleConfigRepoRoot, source: 'CODE' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: { source: 'application_yml' },
      status: 'PENDING',
    });
    await db.insert(evidences).values([
      {
        id: configEvidenceId,
        workspaceId,
        evidenceType: 'CONFIG',
        filePath: `${staleConfigRepoRoot}/application.yml`,
        excerpt: 'zuul.routes.order.serviceId=orders',
        metadata: {},
      },
      {
        id: codeEvidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: `${selectedRepoRoot}/src/gateway.ts`,
        excerpt: 'client.get(\"/orders\")',
        metadata: {},
      },
    ]);
    await db.insert(relationCandidateEvidences).values([
      { workspaceId, candidateId: compoundCandidateId, evidenceId: configEvidenceId },
      { workspaceId, candidateId: compoundCandidateId, evidenceId: codeEvidenceId },
    ]);

    const result = await bindConfigToCodeEndpoints(db, { workspaceId, repoRoots: [selectedRepoRoot] });

    expect(result.compoundCandidateCount).toBe(0);
    expect(result.createdEndpointCandidateCount).toBe(0);

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );

    expect(endpointCandidates).toHaveLength(0);
  });

  it('config evidence가 없는 code-only service 후보는 crossBound endpoint 후보를 생성하지 않아야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();
    const codeEvidenceId = generateId();
    const repoRoot = '/tmp/repo-a';

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
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
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot, source: 'CODE' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: { source: 'CODE', repoRoot },
      status: 'PENDING',
    });
    await db.insert(evidences).values({
      id: codeEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: `${repoRoot}/src/gateway.ts`,
      excerpt: 'client.get(\"/orders\")',
      metadata: {},
    });
    await db.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId: compoundCandidateId,
      evidenceId: codeEvidenceId,
    });

    const result = await bindConfigToCodeEndpoints(db, { workspaceId, repoRoots: [repoRoot] });

    expect(result.compoundCandidateCount).toBe(0);
    expect(result.createdEndpointCandidateCount).toBe(0);

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );

    expect(endpointCandidates).toHaveLength(0);
  });
});
