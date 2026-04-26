import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb as createEmbeddedTestDb } from '@archi-navi/db';
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

async function createTestDb() {
  return await createEmbeddedTestDb();
}

describe('inferRelationsFromCodeSignals', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000222';
  const repoRoot = '/tmp/repo';

  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-ws-codebased' });
  });

  it('endpoint 매칭이 없는 call(kind=call, URL host+path)은 service fallback 없이 스킵해야 한다', async () => {
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
    expect(result.candidateCount).toBe(0);
    expect(result.processedEdgeCount).toBe(0);
    expect(result.skippedEdgeCount).toBe(1);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);

    const links = await db
      .select()
      .from(relationCandidateEvidences)
      .where(eq(relationCandidateEvidences.workspaceId, workspaceId));
    expect(links).toHaveLength(0);
  });

  it('function owner artifact도 legacy code 후보에서는 service subject로 정규화해야 한다', async () => {
    const aId = generateId();
    const aFunctionId = generateId();
    const bId = generateId();
    const endpointId = generateId();
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
        id: aFunctionId,
        workspaceId,
        objectType: 'function',
        category: 'CODE',
        granularity: 'ATOMIC',
        name: 'GatewayClient.fetchUsers',
        parentId: aId,
        path: `/${aFunctionId}`,
        depth: 1,
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
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/users',
        displayName: 'GET /api/users',
        parentId: bId,
        path: `/user-service/get-api-users`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/users', repoRoot, source: 'CODE' },
      },
    ]);

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/GatewayClient.ts',
      ownerObjectId: aFunctionId,
      sha256: 'function-owner-artifact',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/GatewayClient.ts',
      lineStart: 3,
      lineEnd: 3,
      excerpt: "return axios.get('http://user-service/api/users');",
      metadata: {
        kind: 'call',
        confidence: 0.92,
        ownerFunctionId: aFunctionId,
      },
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
    expect(result.processedEdgeCount).toBe(1);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subjectObjectId).toBe(aId);
    expect(candidates[0]?.objectId).toBe(endpointId);
  });

  it('stale ownerFunctionId가 있어도 artifact owner service로 fallback 해야 한다', async () => {
    const aId = generateId();
    const bId = generateId();
    const endpointId = generateId();
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
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/users',
        displayName: 'GET /api/users',
        parentId: bId,
        path: `/user-service/get-api-users-fallback`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/users', repoRoot, source: 'CODE' },
      },
    ]);

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/GatewayClientFallback.ts',
      ownerObjectId: aId,
      sha256: 'stale-owner-fallback-artifact',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/GatewayClientFallback.ts',
      lineStart: 3,
      lineEnd: 3,
      excerpt: "return axios.get('http://user-service/api/users');",
      metadata: {
        kind: 'call',
        confidence: 0.92,
        ownerFunctionId: generateId(),
      },
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
    expect(candidates[0]?.subjectObjectId).toBe(aId);
    expect(candidates[0]?.objectId).toBe(endpointId);
  });

  it('crossValidation 보정 confidence보다 낮아도 원본 confidence보다 높으면 code 후보를 갱신해야 한다', async () => {
    const aId = generateId();
    const bId = generateId();
    const endpointId = generateId();
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
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/users',
        displayName: 'GET /api/users',
        parentId: bId,
        path: `/user-service/get-api-users`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/users', repoRoot, source: 'CODE' },
      },
    ]);

    const candidateId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: aId,
      objectId: endpointId,
      confidence: 0.95,
      status: 'PENDING',
      metadata: {
        source: 'old',
        targetType: 'api_endpoint',
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

  it('동일 raw confidence로 재사용되는 pending code 후보도 기존 crossValidation 상태를 제거해야 한다', async () => {
    const aId = generateId();
    const bId = generateId();
    const endpointId = generateId();
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
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/users',
        displayName: 'GET /api/users',
        parentId: bId,
        path: `/user-service/get-api-users`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/users', repoRoot, source: 'CODE' },
      },
    ]);

    const candidateId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: aId,
      objectId: endpointId,
      confidence: 0.95,
      status: 'PENDING',
      metadata: {
        source: 'old',
        targetType: 'api_endpoint',
        crossValidation: {
          validated: true,
          supportingSources: ['config', 'code'],
          originalConfidence: 0.9,
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
      excerpt: 'restTemplate.getForObject(\"http://user-service/api/users\", String.class);',
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

  it('동일 raw confidence로 재사용되는 pending code 후보도 최신 repoRoot provenance로 갱신해야 한다', async () => {
    const aId = generateId();
    const bId = generateId();
    const endpointId = generateId();
    const newRepoRoot = '/tmp/repo-next';
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
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/users',
        displayName: 'GET /api/users',
        parentId: bId,
        path: `/user-service/get-api-users`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/users', repoRoot: newRepoRoot, source: 'CODE' },
      },
    ]);

    const candidateId = generateId();
    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: aId,
      objectId: endpointId,
      confidence: 0.95,
      status: 'PENDING',
      metadata: {
        source: 'old',
        repoRoot: '/tmp/repo-old',
        targetType: 'api_endpoint',
        crossValidation: {
          validated: true,
          supportingSources: ['config', 'code'],
          originalConfidence: 0.9,
          adjustedConfidence: 0.95,
        },
      },
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot: newRepoRoot,
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
      excerpt: 'restTemplate.getForObject(\"http://user-service/api/users\", String.class);',
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

    await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot: newRepoRoot });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const metadata = candidate?.metadata as Record<string, unknown>;

    expect(candidate?.confidence).toBeCloseTo(0.9);
    expect(metadata['repoRoot']).toBe(newRepoRoot);
    expect(metadata['source']).toBe('CODE');
    expect(metadata['crossValidation']).toBeUndefined();
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

  it('calleeSymbol만으로는 못 찾는 call도 hostHint/pathHint metadata로 endpoint 후보를 찾아야 한다', async () => {
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
        name: 'orders-service',
        path: `/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: generateId(),
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        displayName: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders-service/get-api-orders`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders', repoRoot, source: 'CODE' },
      },
    ]);

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/ReviewClient.java',
      ownerObjectId: callerId,
      sha256: 'partial-http-signal',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/ReviewClient.java',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'requestBuilder.invoke();',
      metadata: {
        kind: 'call',
        confidence: 0.91,
        hostHint: 'orders-service',
        pathHint: '/api/orders',
        configKeys: ['client.orders.base-url'],
        dynamicHost: true,
        dynamicPath: true,
      },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'requestBuilder.invoke',
      weight: 1,
      evidenceId,
    });

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.candidateCount).toBe(1);
    expect(result.processedEdgeCount).toBe(1);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subjectObjectId).toBe(callerId);
    expect(candidates[0]?.objectId).toBeTruthy();

    const metadata = candidates[0]?.metadata as Record<string, unknown>;
    expect(metadata['hostHint']).toBe('orders-service');
    expect(metadata['pathHint']).toBe('/api/orders');
    expect(metadata['configKeys']).toEqual(['client.orders.base-url']);
    expect(metadata['dynamicHost']).toBe(true);
    expect(metadata['dynamicPath']).toBe(true);
    expect(metadata['resolvedVia']).toBe('hostHint+pathHint');
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

  it('테이블명과 같은 SQL alias는 실제 테이블 참조로 유지해야 한다', async () => {
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
      filePath: 'src/OrderMapper.xml',
      ownerObjectId: svcId,
      sha256: 'db-self-alias',
    });

    const evRead = generateId();
    await db.insert(evidences).values({
      id: evRead,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/OrderMapper.xml',
      lineStart: 1,
      lineEnd: 1,
      excerpt: '<select>SELECT * FROM orders orders</select>',
      metadata: {
        kind: 'db_read',
        confidence: 0.82,
        parser: 'tokenizer',
        tables: ['orders'],
        aliases: { orders: 'orders' },
      },
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
    expect(result.createdDbTableCount).toBe(1);
    expect(result.candidateCount).toBe(1);

    const tableRows = await db
      .select({ id: objects.id, name: objects.name })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'db_table')));
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]?.name).toBe('orders');

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('read');
    expect(candidates[0]?.objectId).toBe(tableRows[0]?.id);
  });

  it('같은 JDBC canonical key를 쓰는 여러 서비스는 database/db_table을 공유해야 한다', async () => {
    const svcA = generateId();
    const svcB = generateId();
    await db.insert(objects).values([
      {
        id: svcA,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'order-service',
        path: `/${svcA}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: svcB,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'billing-service',
        path: `/${svcB}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    for (const [serviceId, filePath, kind] of [
      [svcA, 'src/OrderDb.java', 'db_read'],
      [svcB, 'src/BillingDb.java', 'db_write'],
    ] as const) {
      const artifactId = generateId();
      await db.insert(codeArtifacts).values({
        id: artifactId,
        workspaceId,
        language: 'java',
        repoRoot,
        filePath,
        ownerObjectId: serviceId,
        sha256: filePath,
      });
      const evidenceId = generateId();
      await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath,
        lineStart: 1,
        lineEnd: 1,
        excerpt: 'SELECT * FROM orders',
        metadata: {
          kind,
          confidence: 0.82,
          datasourceUrl: 'jdbc:postgresql://shared-db:5432/core',
          tables: ['orders'],
          parser: 'tokenizer',
        },
      });
      await db.insert(codeCallEdges).values({
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: 'orders',
        weight: 1,
        evidenceId,
      });
    }

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.createdDatabaseCount).toBe(1);
    expect(result.createdDbTableCount).toBe(1);
    expect(result.sharedDbTableCount).toBeGreaterThanOrEqual(1);

    const databaseRows = await db
      .select({ id: objects.id, metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'database')));
    expect(databaseRows).toHaveLength(1);
    expect(databaseRows[0]?.metadata).toMatchObject({
      sharingModel: 'SHARED',
      observedByServiceIds: expect.arrayContaining([svcA, svcB]),
    });

    const tableRows = await db
      .select({ id: objects.id, parentId: objects.parentId, metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'db_table')));
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]?.parentId).toBe(databaseRows[0]?.id);
    expect(tableRows[0]?.metadata).toMatchObject({
      sharingModel: 'SHARED',
      observedByServiceIds: expect.arrayContaining([svcA, svcB]),
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.metadata as Record<string, unknown>)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dbAccessRole: 'shared_user', sharingModel: 'SHARED' }),
        expect.objectContaining({ dbAccessRole: 'owner_candidate', sharingModel: 'SHARED' }),
      ]),
    );
  });

  it('config 없는 동일 테이블 다중 서비스 접근은 자동 병합하지 않고 suspected shared로 표시해야 한다', async () => {
    const svcA = generateId();
    const svcB = generateId();
    await db.insert(objects).values([
      {
        id: svcA,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'alpha-service',
        path: `/${svcA}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: svcB,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'beta-service',
        path: `/${svcB}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    for (const [serviceId, filePath] of [
      [svcA, 'src/AlphaDb.java'],
      [svcB, 'src/BetaDb.java'],
    ] as const) {
      const artifactId = generateId();
      await db.insert(codeArtifacts).values({
        id: artifactId,
        workspaceId,
        language: 'java',
        repoRoot,
        filePath,
        ownerObjectId: serviceId,
        sha256: filePath,
      });
      const evidenceId = generateId();
      await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath,
        lineStart: 1,
        lineEnd: 1,
        excerpt: 'SELECT * FROM robot_instance',
        metadata: { kind: 'db_read', confidence: 0.82, tables: ['robot_instance'], parser: 'tokenizer' },
      });
      await db.insert(codeCallEdges).values({
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: 'robot_instance',
        weight: 1,
        evidenceId,
      });
    }

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.createdDatabaseCount).toBe(2);
    expect(result.createdDbTableCount).toBe(2);
    expect(result.suspectedSharedDatabaseCount).toBeGreaterThanOrEqual(1);

    const databaseRows = await db
      .select()
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'database')));
    expect(databaseRows).toHaveLength(2);

    const tableRows = await db
      .select({ id: objects.id, metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'db_table')));
    expect(tableRows).toHaveLength(2);
    expect(tableRows.every((row) => (row.metadata as Record<string, unknown>)['sharingModel'] === 'SUSPECTED_SHARED')).toBe(true);

    const readCandidates = await db
      .select({ metadata: relationCandidates.metadata })
      .from(relationCandidates)
      .where(and(eq(relationCandidates.workspaceId, workspaceId), eq(relationCandidates.relationType, 'read')));
    expect(readCandidates).toHaveLength(2);
    expect(readCandidates.every((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      return metadata['sharingModel'] === 'SUSPECTED_SHARED'
        && metadata['dbAccessRole'] === 'shared_user'
        && metadata['dbTopologyConfidence'] === 0.55;
    })).toBe(true);
  });

  it('suspected shared 표시는 fallback databaseKey 테이블에만 적용해야 한다', async () => {
    const canonicalDbId = generateId();
    const canonicalTableId = generateId();
    const svcA = generateId();
    const svcB = generateId();
    await db.insert(objects).values([
      {
        id: canonicalDbId,
        workspaceId,
        objectType: 'database',
        category: 'STORAGE',
        granularity: 'COMPOUND',
        name: 'canonical-db',
        path: `/${canonicalDbId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: { databaseKey: 'postgres:db.example.com:5432:app', sharingModel: 'PRIVATE' },
      },
      {
        id: canonicalTableId,
        workspaceId,
        objectType: 'db_table',
        category: 'STORAGE',
        granularity: 'ATOMIC',
        name: 'users',
        parentId: canonicalDbId,
        path: `/${canonicalDbId}/${canonicalTableId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: {
          databaseKey: 'postgres:db.example.com:5432:app',
          table: 'users',
          sharingModel: 'PRIVATE',
        },
      },
      {
        id: svcA,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'alpha-service',
        path: `/${svcA}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: svcB,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'beta-service',
        path: `/${svcB}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    for (const [serviceId, filePath] of [
      [svcA, 'src/AlphaUsers.java'],
      [svcB, 'src/BetaUsers.java'],
    ] as const) {
      const artifactId = generateId();
      await db.insert(codeArtifacts).values({
        id: artifactId,
        workspaceId,
        language: 'java',
        repoRoot,
        filePath,
        ownerObjectId: serviceId,
        sha256: filePath,
      });
      const evidenceId = generateId();
      await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath,
        lineStart: 1,
        lineEnd: 1,
        excerpt: 'SELECT * FROM users',
        metadata: { kind: 'db_read', confidence: 0.82, tables: ['users'], parser: 'tokenizer' },
      });
      await db.insert(codeCallEdges).values({
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: 'users',
        weight: 1,
        evidenceId,
      });
    }

    await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });

    const [canonicalTable] = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(eq(objects.id, canonicalTableId))
      .limit(1);
    expect(canonicalTable?.metadata).toMatchObject({
      databaseKey: 'postgres:db.example.com:5432:app',
      sharingModel: 'PRIVATE',
    });

    const fallbackTables = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'db_table'), eq(objects.name, 'users')));
    const fallbackMetas = fallbackTables
      .map((row) => row.metadata as Record<string, unknown>)
      .filter((metadata) => typeof metadata.databaseKey === 'string' && metadata.databaseKey.endsWith(':default'));
    expect(fallbackMetas).toHaveLength(2);
    expect(fallbackMetas.every((metadata) => metadata.sharingModel === 'SUSPECTED_SHARED')).toBe(true);
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

  it('같은 database 아래 schema-qualified table과 unqualified table이면 same_db_table 후보를 만든다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'robot-service',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    for (const tableName of ['robot_instance', 'schema_a.robot_instance']) {
      const artifactId = generateId();
      await db.insert(codeArtifacts).values({
        id: artifactId,
        workspaceId,
        language: 'java',
        repoRoot,
        filePath: `src/${tableName}.java`,
        ownerObjectId: svcId,
        sha256: tableName,
      });
      const evidenceId = generateId();
      await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: `src/${tableName}.java`,
        lineStart: 1,
        lineEnd: 1,
        excerpt: `SELECT * FROM ${tableName}`,
        metadata: {
          kind: 'db_read',
          confidence: 0.8,
          databaseKey: 'robot-db',
          tables: [tableName],
          parser: 'tokenizer',
        },
      });
      await db.insert(codeCallEdges).values({
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: tableName,
        weight: 1,
        evidenceId,
      });
    }

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.implicitSchemaTableCandidateCount).toBe(1);

    const rows = await db
      .select({
        relationType: relationCandidates.relationType,
        confidence: relationCandidates.confidence,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.relationType, 'same_db_table'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relationType: 'same_db_table',
      confidence: 0.65,
    });
    expect(rows[0]?.metadata).toMatchObject({
      reason: 'implicit_schema_match',
      unqualifiedName: 'robot_instance',
      qualifiedName: 'schema_a.robot_instance',
    });
  });

  it('다른 databaseKey의 schema-qualified/unqualified table은 same_db_table 후보를 만들지 않는다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'robot-service',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    for (const [tableName, databaseKey] of [
      ['robot_instance', 'robot-db-a'],
      ['schema_a.robot_instance', 'robot-db-b'],
    ] as const) {
      const artifactId = generateId();
      await db.insert(codeArtifacts).values({
        id: artifactId,
        workspaceId,
        language: 'java',
        repoRoot,
        filePath: `src/${databaseKey}.java`,
        ownerObjectId: svcId,
        sha256: databaseKey,
      });
      const evidenceId = generateId();
      await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: `src/${databaseKey}.java`,
        lineStart: 1,
        lineEnd: 1,
        excerpt: `SELECT * FROM ${tableName}`,
        metadata: {
          kind: 'db_read',
          confidence: 0.8,
          databaseKey,
          tables: [tableName],
          parser: 'tokenizer',
        },
      });
      await db.insert(codeCallEdges).values({
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: tableName,
        weight: 1,
        evidenceId,
      });
    }

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.implicitSchemaTableCandidateCount).toBe(0);

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.relationType, 'same_db_table'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('다중 schema-qualified target이면 same_db_table 후보 confidence를 낮춘다', async () => {
    const svcId = generateId();
    await db.insert(objects).values({
      id: svcId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'robot-service',
      path: `/${svcId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    for (const tableName of ['robot_instance', 'schema_a.robot_instance', 'schema_b.robot_instance']) {
      const artifactId = generateId();
      await db.insert(codeArtifacts).values({
        id: artifactId,
        workspaceId,
        language: 'java',
        repoRoot,
        filePath: `src/${tableName}.java`,
        ownerObjectId: svcId,
        sha256: tableName,
      });
      const evidenceId = generateId();
      await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: `src/${tableName}.java`,
        lineStart: 1,
        lineEnd: 1,
        excerpt: `SELECT * FROM ${tableName}`,
        metadata: {
          kind: 'db_read',
          confidence: 0.8,
          databaseKey: 'robot-db',
          tables: [tableName],
          parser: 'tokenizer',
        },
      });
      await db.insert(codeCallEdges).values({
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: tableName,
        weight: 1,
        evidenceId,
      });
    }

    const result = await inferRelationsFromCodeSignals(db, { workspaceId, repoRoot });
    expect(result.implicitSchemaTableCandidateCount).toBe(2);

    const rows = await db
      .select({
        confidence: relationCandidates.confidence,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.relationType, 'same_db_table'),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.confidence === 0.4)).toBe(true);
    expect(rows.every((row) => (row.metadata as Record<string, unknown>)['ambiguity'] === 'multiple_schema_candidates')).toBe(true);
  });
});
