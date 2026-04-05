// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

const { dbHolder, applyRollupChangesMock, createRelationChangeEventMock } = vi.hoisted(() => ({
  dbHolder: { db: null as any },
  applyRollupChangesMock: vi.fn(),
  createRelationChangeEventMock: vi.fn(() => ({ type: 'APPROVED' })),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: async () => dbHolder.db,
  };
});

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createRelationChangeEvent: createRelationChangeEventMock,
}));

import {
  createTestDb as createEmbeddedTestDb,
  domainInferenceProfiles,
  evidences,
  objectRelations,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  relationEvidences,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { POST } from '@/app/api/inference/candidates/[id]/map-endpoints/route';

const workspaceId = '00000000-0000-0000-0000-000000000082';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

describe('POST /api/inference/candidates/:id/map-endpoints', () => {
  beforeEach(async () => {
    dbHolder.db = await createTestDb();
    applyRollupChangesMock.mockReset();
    createRelationChangeEventMock.mockReset();
    createRelationChangeEventMock.mockReturnValue({ type: 'APPROVED' });
    await dbHolder.db.insert(workspaces).values({ id: workspaceId, name: 'map-endpoints-test' });
  });

  async function seedBaseGraph(relationType = 'call') {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const otherServiceId = generateId();
    const candidateId = generateId();

    await dbHolder.db!.insert(objects).values([
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
        id: otherServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'payments',
        path: `/payments/${otherServiceId}`,
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

    await dbHolder.db!.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType,
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.81,
      metadata: {},
      status: 'PENDING',
    });

    const evidenceId = generateId();
    await dbHolder.db!.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'CONFIG',
      excerpt: 'compound relation evidence',
      metadata: {},
    });
    await dbHolder.db!.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId,
      evidenceId,
    });

    return { sourceServiceId, targetServiceId, otherServiceId, endpointId, candidateId };
  }

  it('non-call 후보도 endpoint 매핑을 허용하고 relationType을 유지해야 한다', async () => {
    const { candidateId, endpointId, sourceServiceId } = await seedBaseGraph('depend_on');

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ endpointIds: [endpointId] }),
        headers: { 'Content-Type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: candidateId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      createdRelationCount: 1,
      resolvedRelationCount: 1,
      reusedRelationCount: 0,
    });

    const relations = await dbHolder.db!
      .select()
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.subjectObjectId, sourceServiceId),
          eq(objectRelations.objectId, endpointId),
          eq(objectRelations.relationType, 'depend_on'),
        ),
      );
    expect(relations).toHaveLength(1);
    expect(createRelationChangeEventMock).toHaveBeenCalledTimes(1);
    expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
    expect(applyRollupChangesMock.mock.calls[0]?.[1]).toBe(workspaceId);
    expect(applyRollupChangesMock.mock.calls[0]?.[2]).toHaveLength(1);
  });

  it('여러 endpoint를 한 번에 매핑하면 rollup 변경을 배치로 적용해야 한다', async () => {
    const { candidateId, endpointId, targetServiceId } = await seedBaseGraph('call');
    const secondEndpointId = generateId();

    await dbHolder.db!.insert(objects).values({
      id: secondEndpointId,
      workspaceId,
      objectType: 'api_endpoint',
      category: 'COMPUTE',
      granularity: 'ATOMIC',
      name: 'POST /api/orders',
      parentId: targetServiceId,
      path: `/orders/${targetServiceId}/${secondEndpointId}`,
      depth: 1,
      visibility: 'VISIBLE',
      metadata: { method: 'POST', path: '/api/orders' },
    });

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ endpointIds: [endpointId, secondEndpointId] }),
        headers: { 'Content-Type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: candidateId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      createdRelationCount: 2,
      resolvedRelationCount: 2,
      reusedRelationCount: 0,
    });
    expect(createRelationChangeEventMock).toHaveBeenCalledTimes(2);
    expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
    expect(applyRollupChangesMock.mock.calls[0]?.[2]).toHaveLength(2);
  });

  it('동일 endpoint 후보가 이미 PENDING 이면 이를 승인해 재사용해야 한다', async () => {
    const { sourceServiceId, endpointId, candidateId } = await seedBaseGraph('call');
    const existingEndpointCandidateId = generateId();
    const endpointEvidenceId = generateId();

    await dbHolder.db!.insert(domainInferenceProfiles).values({
      id: generateId(),
      workspaceId,
      name: 'default',
      kind: 'NAMED',
      isDefault: true,
    });

    await dbHolder.db!.insert(relationCandidates).values({
      id: existingEndpointCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: endpointId,
      confidence: 0.9,
      metadata: { source: 'CODE', signalKind: 'call', framework: 'spring-boot', language: 'java' },
      status: 'PENDING',
    });
    await dbHolder.db!.insert(evidences).values({
      id: endpointEvidenceId,
      workspaceId,
      evidenceType: 'CONFIG',
      excerpt: 'endpoint relation evidence',
      metadata: {},
    });
    await dbHolder.db!.insert(relationCandidateEvidences).values({
      workspaceId,
      candidateId: existingEndpointCandidateId,
      evidenceId: endpointEvidenceId,
    });
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ endpointIds: [endpointId] }),
        headers: { 'Content-Type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: candidateId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      createdRelationCount: 0,
      resolvedRelationCount: 1,
      reusedRelationCount: 1,
    });

    const approvedCandidates = await dbHolder.db!
      .select({ id: relationCandidates.id, status: relationCandidates.status })
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(
      approvedCandidates.find((row: { id: string; status: string }) => row.id === candidateId)?.status,
    ).toBe('APPROVED');
    expect(
      approvedCandidates.find(
        (row: { id: string; status: string }) => row.id === existingEndpointCandidateId,
      )?.status,
    ).toBe('APPROVED');

    const relations = await dbHolder.db!
      .select()
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.subjectObjectId, sourceServiceId),
          eq(objectRelations.objectId, endpointId),
        ),
      );
    expect(relations).toHaveLength(1);

    const linkedEvidence = await dbHolder.db!
      .select()
      .from(relationEvidences)
      .where(
        and(
          eq(relationEvidences.workspaceId, workspaceId),
          eq(relationEvidences.relationId, relations[0]!.id),
        ),
      );
    expect(linkedEvidence).toHaveLength(2);
    expect(createRelationChangeEventMock).toHaveBeenCalledTimes(1);
    expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
  });

  it('유효한 endpoint relation을 하나도 만들지 못하면 원본 후보를 PENDING 으로 유지해야 한다', async () => {
    const { candidateId, otherServiceId } = await seedBaseGraph('call');
    const invalidEndpointId = generateId();

    await dbHolder.db!.insert(objects).values({
      id: invalidEndpointId,
      workspaceId,
      objectType: 'api_endpoint',
      category: 'COMPUTE',
      granularity: 'ATOMIC',
      name: 'GET /api/payments',
      parentId: otherServiceId,
      path: `/payments/${otherServiceId}/${invalidEndpointId}`,
      depth: 1,
      visibility: 'VISIBLE',
      metadata: { method: 'GET', path: '/api/payments' },
    });

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ endpointIds: [invalidEndpointId] }),
        headers: { 'Content-Type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: candidateId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      createdRelationCount: 0,
      resolvedRelationCount: 0,
      reusedRelationCount: 0,
    });

    const [originalCandidate] = await dbHolder.db!
      .select({ status: relationCandidates.status })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId))
      .limit(1);
    expect(originalCandidate?.status).toBe('PENDING');
    expect(createRelationChangeEventMock).not.toHaveBeenCalled();
    expect(applyRollupChangesMock).not.toHaveBeenCalled();
  });

  it('이미 확정된 endpoint relation이 있으면 이를 재사용하고 원본 후보를 승인해야 한다', async () => {
    const { sourceServiceId, endpointId, candidateId } = await seedBaseGraph('call');
    const relationId = generateId();

    await dbHolder.db!.insert(objectRelations).values({
      id: relationId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: endpointId,
      confidence: 1,
      status: 'APPROVED',
      source: 'MANUAL',
      metadata: {},
    });

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ endpointIds: [endpointId] }),
        headers: { 'Content-Type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: candidateId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      createdRelationCount: 0,
      resolvedRelationCount: 1,
      reusedRelationCount: 1,
    });

    const [originalCandidate] = await dbHolder.db!
      .select({ status: relationCandidates.status })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId))
      .limit(1);
    expect(originalCandidate?.status).toBe('APPROVED');

    const linkedEvidence = await dbHolder.db!
      .select()
      .from(relationEvidences)
      .where(
        and(
          eq(relationEvidences.workspaceId, workspaceId),
          eq(relationEvidences.relationId, relationId),
        ),
      );
    expect(linkedEvidence).toHaveLength(1);
    expect(createRelationChangeEventMock).not.toHaveBeenCalled();
    expect(applyRollupChangesMock).not.toHaveBeenCalled();
  });

  it('이미 APPROVED 인 endpoint 후보와 base relation이 있으면 rollup 변경을 다시 발행하지 않아야 한다', async () => {
    const { sourceServiceId, endpointId, candidateId } = await seedBaseGraph('call');
    const existingEndpointCandidateId = generateId();
    const relationId = generateId();

    await dbHolder.db!.insert(relationCandidates).values({
      id: existingEndpointCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: endpointId,
      confidence: 0.9,
      metadata: { source: 'config-code-binding' },
      status: 'APPROVED',
    });
    await dbHolder.db!.insert(objectRelations).values({
      id: relationId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: endpointId,
      confidence: 1,
      status: 'APPROVED',
      source: 'INFERRED',
      metadata: {},
    });

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ endpointIds: [endpointId] }),
        headers: { 'Content-Type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: candidateId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      createdRelationCount: 0,
      resolvedRelationCount: 1,
      reusedRelationCount: 1,
    });
    expect(createRelationChangeEventMock).not.toHaveBeenCalled();
    expect(applyRollupChangesMock).not.toHaveBeenCalled();
  });
});
