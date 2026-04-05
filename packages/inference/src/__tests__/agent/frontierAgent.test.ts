import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  aliasBindings,
  createTestDb,
  interactionIntents,
  objects,
  proofFrontiers,
  proofStates,
  routeTransforms,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  buildFrontierAgentPatchProposal,
  runFrontierAgentPass,
} from '@/agent/frontierAgent';
import { resolveInteractionIntentProof } from '@/orchestration/intentProofEngine';

const workspaceId = '00000000-0000-0000-0000-000000000654';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function insertObject(
  db: TestDb,
  input: {
    id?: string;
    objectType: string;
    name: string;
    parentId?: string | null;
    metadata?: Record<string, unknown>;
    category?: string;
    granularity?: string;
  },
) {
  const id = input.id ?? generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: input.objectType,
    name: input.name,
    parentId: input.parentId ?? null,
    metadata: input.metadata ?? {},
    category: input.category ?? (input.objectType === 'api_endpoint' ? 'CHANNEL' : 'COMPUTE'),
    granularity: input.granularity ?? (input.objectType === 'service' ? 'COMPOUND' : 'ATOMIC'),
    path: `/${id}`,
    depth: input.parentId ? 1 : 0,
    visibility: 'VISIBLE',
  });
  return id;
}

describe('frontier agent', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'frontier-agent-test' });
  });

  it('alias frontier에서 단일 service 힌트가 있으면 alias_binding patch를 제안해야 한다', async () => {
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'gateway-service' });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-api' });
    const proofStateId = generateId();
    const intentId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId: null,
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-frontier-agent-alias',
      anchorHash: 'anchor-frontier-agent-alias',
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      providerServiceId: null,
      sourceFunctionId: null,
      targetObjectType: null,
      targetObjectId: null,
      methodResolved: null,
      externalPathResolved: null,
      internalPathResolved: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0,
      frontierCode: 'CONFIG_BINDING_MISSING',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'CONFIG_BINDING_MISSING',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        hostHints: ['ORDERS_API'],
        configKeys: ['client.orders.url'],
      },
    });

    const proposal = await buildFrontierAgentPatchProposal(db, { workspaceId, proofStateId });

    expect(proposal).toMatchObject({
      patchType: 'alias_binding',
      frontierReason: 'CONFIG_BINDING_MISSING',
      payload: expect.objectContaining({
        ownerServiceId: consumerServiceId,
        aliasKey: 'client.orders.url',
        resolvedServiceId: providerServiceId,
      }),
    });
  });

  it('alias frontier top score가 동점이어도 exact service-name match가 있으면 deterministic winner를 골라야 한다', async () => {
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'gateway-service' });
    const exactNameServiceId = await insertObject(db, {
      objectType: 'service',
      name: 'orders-api',
      metadata: { host: 'orders-api.internal' },
    });
    await insertObject(db, {
      objectType: 'service',
      name: 'legacy-orders',
      metadata: { host: 'orders-api' },
    });
    const proofStateId = generateId();
    const intentId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId: null,
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-frontier-agent-alias-deterministic',
      anchorHash: 'anchor-frontier-agent-alias-deterministic',
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      providerServiceId: null,
      sourceFunctionId: null,
      targetObjectType: null,
      targetObjectId: null,
      methodResolved: null,
      externalPathResolved: null,
      internalPathResolved: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0,
      frontierCode: 'CONFIG_BINDING_MISSING',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'CONFIG_BINDING_MISSING',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        hostHints: ['ORDERS_API'],
        configKeys: ['client.orders.url'],
      },
    });

    const proposal = await buildFrontierAgentPatchProposal(db, { workspaceId, proofStateId });

    expect(proposal).toMatchObject({
      patchType: 'alias_binding',
      payload: expect.objectContaining({
        resolvedServiceId: exactNameServiceId,
      }),
    });
  });

  it('alias frontier exact service-name hint가 있으면 동점이어도 deterministic하게 해당 서비스를 선택해야 한다', async () => {
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'gateway-service' });
    const exactNameServiceId = await insertObject(db, { objectType: 'service', name: 'inventory_api' });
    await insertObject(db, { objectType: 'service', name: 'inventory-api' });
    const proofStateId = generateId();
    const intentId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId: null,
      targetServiceHint: 'inventory_api',
      hostHint: 'INVENTORY_HINT',
      configKeys: ['client.inventory.url'],
      intentHash: 'intent-frontier-agent-alias-exact-service-name',
      anchorHash: 'anchor-frontier-agent-alias-exact-service-name',
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      providerServiceId: null,
      sourceFunctionId: null,
      targetObjectType: null,
      targetObjectId: null,
      methodResolved: null,
      externalPathResolved: null,
      internalPathResolved: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0,
      frontierCode: 'CONFIG_BINDING_MISSING',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'CONFIG_BINDING_MISSING',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        hostHints: ['INVENTORY_HINT'],
        configKeys: ['client.inventory.url'],
      },
    });

    const proposal = await buildFrontierAgentPatchProposal(db, { workspaceId, proofStateId });

    expect(proposal).toMatchObject({
      patchType: 'alias_binding',
      payload: expect.objectContaining({
        resolvedServiceId: exactNameServiceId,
      }),
    });
  });

  it('alias frontier tie-break가 의미 있는 차이를 못 만들면 기존처럼 patch를 만들지 않아야 한다', async () => {
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'gateway-service' });
    await insertObject(db, { objectType: 'service', name: 'orders-api' });
    await insertObject(db, { objectType: 'service', name: 'orders_api' });
    const proofStateId = generateId();
    const intentId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId: null,
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-frontier-agent-alias-still-ambiguous',
      anchorHash: 'anchor-frontier-agent-alias-still-ambiguous',
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      providerServiceId: null,
      sourceFunctionId: null,
      targetObjectType: null,
      targetObjectId: null,
      methodResolved: null,
      externalPathResolved: null,
      internalPathResolved: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0,
      frontierCode: 'CONFIG_BINDING_MISSING',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'CONFIG_BINDING_MISSING',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        hostHints: ['ORDERS_API'],
        configKeys: ['client.orders.url'],
      },
    });

    const proposal = await buildFrontierAgentPatchProposal(db, { workspaceId, proofStateId });

    expect(proposal).toBeNull();
  });


  it('route frontier에서 최소 route_transform patch를 제안해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const proofStateId = generateId();
    const intentId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      gatewayKind: 'zuul',
      routeScopeKind: 'prefix',
      externalRoutePattern: '/api/orders/**',
      providerHint: 'orders-service',
      externalPathHint: '/api/orders/123',
      targetServiceHint: 'orders-service',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'orders-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#orders-route'],
      intentHash: 'intent-frontier-agent-route',
      anchorHash: 'anchor-frontier-agent-route',
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_gateway_route',
      status: 'FRONTIER',
      consumerServiceId: gatewayServiceId,
      providerServiceId: null,
      sourceFunctionId: null,
      targetObjectType: null,
      targetObjectId: null,
      methodResolved: null,
      externalPathResolved: '/api/orders/123',
      internalPathResolved: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0,
      frontierCode: 'ROUTE_FAMILY_DERIVATION_EMPTY',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'ROUTE_FAMILY_DERIVATION_EMPTY',
      frontierClass: 'ROUTE',
      retryStrategy: 'agent_patch',
      priority: 85,
      detail: { endpointCandidateSet: { objectIds: [], count: 0 } },
    });

    const proposal = await buildFrontierAgentPatchProposal(db, { workspaceId, proofStateId });

    expect(proposal).toMatchObject({
      patchType: 'route_transform_patch',
      payload: expect.objectContaining({
        ownerServiceId: gatewayServiceId,
        gatewayKind: 'zuul',
        matchPath: '/api/orders/**',
        targetServiceHint: 'orders-service',
      }),
    });
  });

  it('endpointHintId가 있으면 endpoint_disambiguation patch를 적용해 proof를 닫아야 한다', async () => {
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'gateway-service' });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'shipping-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /shipping/labels/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/shipping/labels/{id}' },
    });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /shipping/labels/{labelId}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/shipping/labels/{labelId}' },
    });

    const intentId = generateId();
    const proofStateId = generateId();
    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: consumerServiceId,
      aliasKey: 'client.shipping.url',
      aliasValue: 'SHIPPING_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'frontier-agent-shipping-alias',
    });
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId: null,
      methodHint: 'GET',
      externalPathHint: '/shipping/labels/123',
      hostHint: 'SHIPPING_API',
      configKeys: ['client.shipping.url'],
      intentHash: 'intent-frontier-agent-endpoint',
      anchorHash: 'anchor-frontier-agent-endpoint',
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      providerServiceId,
      sourceFunctionId: null,
      targetObjectType: null,
      targetObjectId: null,
      methodResolved: 'GET',
      externalPathResolved: '/shipping/labels/123',
      internalPathResolved: '/shipping/labels/{id}',
      routeChain: [],
      slotState: {},
      ambiguityCount: 2,
      contradictionCount: 0,
      confidence: 0,
      frontierCode: 'ENDPOINT_MATCH_AMBIGUOUS',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 95,
      detail: {
        providerServiceId,
        methodResolved: 'GET',
        internalPathResolved: '/shipping/labels/{id}',
        candidateObjectIds: [endpointId],
        endpointHintId: endpointId,
      },
    });

    const result = await runFrontierAgentPass(db, {
      workspaceId,
      proofStateId,
      runId: 'run-frontier-agent-1',
    });

    expect(result.attempted).toBe(true);
    expect(result.validationStatus).toBe('ACCEPTED');
    expect(result.resolution?.status).toBe('CLOSED_ATOMIC');
    expect(result.resolution?.targetObjectId).toBe(endpointId);

    const storedTransforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
    expect(storedTransforms).toHaveLength(0);
  });

  it('실제 ambiguous frontier detail(candidateObjectIds)만으로 endpoint_disambiguation patch를 제안해야 한다', async () => {
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'gateway-service' });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'inventory-api' });
    const endpointA = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /inventory/items/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/inventory/items/{id}' },
    });
    const endpointB = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /inventory/items/{itemId}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/inventory/items/{itemId}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: consumerServiceId,
      aliasKey: 'client.inventory.url',
      aliasValue: 'INVENTORY_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'frontier-agent-inventory-alias',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId: null,
      methodHint: 'GET',
      externalPathHint: '/inventory/items/123',
      hostHint: 'INVENTORY_API',
      configKeys: ['client.inventory.url'],
      intentHash: 'intent-frontier-agent-ambiguous-live',
      anchorHash: 'anchor-frontier-agent-ambiguous-live',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('ENDPOINT_MATCH_AMBIGUOUS');

    const proposal = await buildFrontierAgentPatchProposal(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
    });
    expect(proposal).toMatchObject({
      patchType: 'endpoint_disambiguation',
      payload: {
        endpointId: expect.stringMatching(new RegExp(`^(${endpointA}|${endpointB})$`)),
      },
    });

    const result = await runFrontierAgentPass(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      runId: 'run-frontier-agent-ambiguous-live',
    });
    expect(result.attempted).toBe(true);
    expect(result.validationStatus).toBe('ACCEPTED');
    expect(result.resolution?.status).toBe('CLOSED_ATOMIC');
    expect([endpointA, endpointB]).toContain(result.resolution?.targetObjectId ?? '');
  });
});
