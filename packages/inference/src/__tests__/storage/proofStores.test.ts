import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  codeArtifacts,
  codeCallEdges,
  createTestDb,
  evidences,
  interactionIntents,
  objects,
  proofDependencies,
  proofFrontiers,
  proofPatches,
  proofStates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { createProofExtractionStore, createProofStateStore } from '@/storage';

const workspaceId = '00000000-0000-0000-0000-000000000777';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function insertObject(
  db: TestDb,
  input: {
    id?: string;
    objectType: string;
    name: string;
    parentId?: string | null;
    category?: string;
    granularity?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const id = input.id ?? generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: input.objectType,
    category: input.category ?? 'COMPUTE',
    granularity: input.granularity ?? (input.objectType === 'service' ? 'COMPOUND' : 'ATOMIC'),
    name: input.name,
    parentId: input.parentId ?? null,
    path: `/${id}`,
    depth: input.parentId ? 1 : 0,
    visibility: 'VISIBLE',
    metadata: input.metadata ?? {},
  });
  return id;
}

describe('proof stores', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'proof-stores' });
  });

  it('extraction store는 proof extraction primitives를 한 번에 실행한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot: '/tmp/proof-stores',
      filePath: 'src/gateway.ts',
      ownerObjectId: functionId,
      sha256: 'sha-proof-stores',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      lineStart: 3,
      lineEnd: 3,
      excerpt: "client.get('/api/orders/123')",
      metadata: { kind: 'call', method: 'GET', confidence: 0.9 },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders/123',
      weight: 1,
      evidenceId,
    });

    const store = createProofExtractionStore(db);
    const result = await store.extractAll({
      workspaceId,
      repoRoot: '/tmp/proof-stores',
      runId: 'not-a-uuid',
    });

    expect(result.functionSummaryCount).toBe(1);
    expect(result.interactionIntentCount).toBe(1);

    const intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, functionId)));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.createdRunId).toBeNull();
  });

  it('proof state store는 frontier와 patch를 정렬해서 조회한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      intentHash: 'intent-store-proof',
      anchorHash: 'anchor-store-proof',
    });

    const secondIntentId = generateId();
    await db.insert(interactionIntents).values({
      id: secondIntentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      intentHash: 'intent-store-proof-high',
      anchorHash: 'anchor-store-proof-high',
    });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /orders/{id}',
      parentId: serviceId,
    });

    const lowPriorityProofStateId = generateId();
    const highPriorityProofStateId = generateId();
    const childProofStateId = generateId();
    await db.insert(proofStates).values([
      {
        id: lowPriorityProofStateId,
        workspaceId,
        intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
      {
        id: highPriorityProofStateId,
        workspaceId,
        intentId: secondIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        frontierCode: 'ENDPOINT_MATCH_AMBIGUOUS',
      },
      {
        id: childProofStateId,
        workspaceId,
        intentId,
        originIntentId: intentId,
        parentProofStateId: lowPriorityProofStateId,
        proofType: 'http_gateway_route',
        status: 'CLOSED_ATOMIC',
        consumerServiceId: serviceId,
        targetObjectType: 'api_endpoint',
        targetObjectId: endpointId,
      },
    ]);
    await db.insert(proofFrontiers).values([
      {
        proofStateId: lowPriorityProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        detail: { host: 'orders.internal' },
        retryStrategy: 'agent_patch',
        priority: 20,
      },
      {
        proofStateId: highPriorityProofStateId,
        workspaceId,
        frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
        frontierClass: 'TARGET',
        detail: { endpoint: '/orders/{id}' },
        retryStrategy: 'manual_review',
        priority: 90,
      },
    ]);

    await db.insert(proofPatches).values([
      {
        id: generateId(),
        workspaceId,
        proofStateId: lowPriorityProofStateId,
        patchType: 'alias_binding',
        payload: { aliasKey: 'orders.base-url' },
        sourceKind: 'agent',
        validationStatus: 'PENDING',
      },
      {
        id: generateId(),
        workspaceId,
        proofStateId: lowPriorityProofStateId,
        patchType: 'alias_binding',
        payload: { aliasKey: 'orders.base-url', aliasValue: 'ORDER_API' },
        sourceKind: 'agent',
        validationStatus: 'ACCEPTED',
      },
    ]);
    await db.insert(proofDependencies).values({
      id: generateId(),
      workspaceId,
      proofStateId: lowPriorityProofStateId,
      dependencyKind: 'alias_binding',
      dependencyKey: 'orders.base-url',
      dependencyHash: 'orders.base-url',
    });

    const store = createProofStateStore(db);
    const proofState = await store.getByIntentId(workspaceId, intentId);
    const frontiers = await store.listFrontiers(workspaceId);
    const patches = await store.listPatches(workspaceId, lowPriorityProofStateId);
    const dependencies = await store.listDependencies(workspaceId, lowPriorityProofStateId);

    expect(proofState?.id).toBe(lowPriorityProofStateId);
    expect(frontiers).toHaveLength(2);
    expect(frontiers[0]?.frontier.frontierReason).toBe('ENDPOINT_MATCH_AMBIGUOUS');
    expect(frontiers[0]?.proofState.id).toBe(highPriorityProofStateId);
    expect(patches).toHaveLength(2);
    expect(patches[0]?.validationStatus).toBe('ACCEPTED');
    expect(patches[1]?.validationStatus).toBe('PENDING');
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]?.dependencyKind).toBe('alias_binding');
  });

  it('proof state store는 dependency lookup으로 impacted intent를 선별한다', async () => {
    const primaryServiceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const secondaryServiceId = await insertObject(db, { objectType: 'service', name: 'billing-gateway' });

    const primaryIntentId = generateId();
    const secondaryIntentId = generateId();
    await db.insert(interactionIntents).values([
      {
        id: primaryIntentId,
        workspaceId,
        intentType: 'http_call',
        sourceServiceId: primaryServiceId,
        intentHash: 'intent-store-dependency-primary',
        anchorHash: 'anchor-store-dependency-primary',
      },
      {
        id: secondaryIntentId,
        workspaceId,
        intentType: 'http_call',
        sourceServiceId: secondaryServiceId,
        intentHash: 'intent-store-dependency-secondary',
        anchorHash: 'anchor-store-dependency-secondary',
      },
    ]);

    const primaryProofStateId = generateId();
    const secondaryProofStateId = generateId();
    await db.insert(proofStates).values([
      {
        id: primaryProofStateId,
        workspaceId,
        intentId: primaryIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: primaryServiceId,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
      {
        id: secondaryProofStateId,
        workspaceId,
        intentId: secondaryIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: secondaryServiceId,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
    ]);

    await db.insert(proofDependencies).values([
      {
        id: generateId(),
        workspaceId,
        proofStateId: primaryProofStateId,
        dependencyKind: 'alias_binding',
        dependencyKey: 'client.orders.url',
        dependencyHash: 'client.orders.url',
      },
      {
        id: generateId(),
        workspaceId,
        proofStateId: secondaryProofStateId,
        dependencyKind: 'route_transform_owner_service',
        dependencyKey: secondaryServiceId,
        dependencyHash: secondaryServiceId,
      },
    ]);

    const store = createProofStateStore(db);
    const impactedByAlias = await store.listImpactedIntentIds(workspaceId, {
      aliasBindingKeys: ['client.orders.url'],
    });
    const impactedByRouteOwner = await store.listImpactedIntentIds(workspaceId, {
      routeTransformOwnerServiceIds: [secondaryServiceId],
    });

    expect(impactedByAlias).toEqual([primaryIntentId]);
    expect(impactedByRouteOwner).toEqual([secondaryIntentId]);
  });
});
