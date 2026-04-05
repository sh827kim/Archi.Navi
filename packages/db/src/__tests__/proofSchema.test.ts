import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aliasBindings, createTestDb, functionSummaries, getEmbeddedPostgresTestSupport, interactionIntents, objects, proofDependencies, proofFrontiers, proofPatches, proofStates, routeTransforms, smartProofLlmCalls, workspaces } from '../index';
import { generateId } from '@archi-navi/shared';

const workspaceId = '00000000-0000-0000-0000-000000000888';

describe('proof schema migration', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let serviceId: string;
  let targetId: string;
  let intentId: string;
  let embeddedSupport: Awaited<ReturnType<typeof getEmbeddedPostgresTestSupport>>;

  beforeAll(async () => {
    embeddedSupport = await getEmbeddedPostgresTestSupport();
  });

  beforeEach(async () => {
    if (!embeddedSupport.supported) return;
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'proof-schema' });

    serviceId = generateId();
    targetId = generateId();
    intentId = generateId();

    await db.insert(objects).values([
      {
        id: serviceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'consumer-service',
        path: `/${serviceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: targetId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'INTERFACE',
        granularity: 'ATOMIC',
        name: 'GET /orders/{id}',
        path: `/${targetId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      intentHash: 'intent-proof-schema',
      anchorHash: 'anchor-proof-schema',
    });
  });

  it('CLOSED_ATOMIC proof는 target_object_id 없이 저장되면 안 된다', async () => {
    if (!embeddedSupport.supported) return;
    try {
      await db.insert(proofStates).values({
        id: generateId(),
        workspaceId,
        intentId,
        proofType: 'http_call',
        status: 'CLOSED_ATOMIC',
        consumerServiceId: serviceId,
      });
      throw new Error('expected CLOSED_ATOMIC insert without target to fail');
    } catch (error) {
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
      expect(error).toBeInstanceOf(Error);
      expect(cause?.code).toBe('23514');
    }
  });

  it('CLOSED_ATOMIC proof는 target_object_id가 있으면 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(proofStates).values({
        id: generateId(),
        workspaceId,
        intentId,
        proofType: 'http_call',
        status: 'CLOSED_ATOMIC',
        consumerServiceId: serviceId,
        targetObjectId: targetId,
        targetObjectType: 'api_endpoint',
        closedReason: 'endpoint matched',
      }),
    ).resolves.not.toThrow();
  });

  it('interaction intent는 DB/Message partial evidence slot을 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(interactionIntents).values({
        id: generateId(),
        workspaceId,
        intentType: 'message_publish',
        sourceServiceId: serviceId,
        dbSchemaHint: 'public',
        dbTableHints: ['orders'],
        dbQueryFragmentHash: 'query-hash-1',
        messageBrokerKind: 'kafka',
        messageTopicHints: ['order.created'],
        messageQueueHints: [],
        messageRoutingKeyHints: ['order.created.v1'],
        intentHash: 'intent-proof-schema-partial',
        anchorHash: 'anchor-proof-schema-partial',
      }),
    ).resolves.not.toThrow();
  });

  it('function summary는 v2 provenance/completeness 슬롯을 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    const functionId = generateId();

    await db.insert(objects).values({
      id: functionId,
      workspaceId,
      objectType: 'function',
      category: 'CODE',
      granularity: 'ATOMIC',
      name: 'consumer-service.loadOrders',
      parentId: serviceId,
      path: `/${functionId}`,
      depth: 1,
      visibility: 'VISIBLE',
      metadata: {},
    });

    await expect(
      db.insert(functionSummaries).values({
        id: generateId(),
        workspaceId,
        functionId,
        serviceId,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/api/orders',
          configKeys: ['orders.base-url'],
        },
        signalSources: ['ast'],
        provenanceEvidenceIds: ['evidence-http-1'],
        extractionStrategy: 'ast_primary',
        unresolvedReasons: [],
        summaryCompleteness: 1,
        sourceHash: 'function-summary-v3-proof-schema',
      }),
    ).resolves.not.toThrow();
  });

  it('function summary completeness는 0~1 범위를 벗어나면 저장되면 안 된다', async () => {
    if (!embeddedSupport.supported) return;
    const functionId = generateId();

    await db.insert(objects).values({
      id: functionId,
      workspaceId,
      objectType: 'function',
      category: 'CODE',
      granularity: 'ATOMIC',
      name: 'consumer-service.loadOrders.invalid',
      parentId: serviceId,
      path: `/${functionId}`,
      depth: 1,
      visibility: 'VISIBLE',
      metadata: {},
    });

    await expect(
      db.insert(functionSummaries).values({
        id: generateId(),
        workspaceId,
        functionId,
        serviceId,
        summaryKind: 'http',
        summaryCompleteness: 1.2,
        sourceHash: 'function-summary-v3-proof-schema-invalid',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('http_gateway_route intent는 route family 필수 슬롯을 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(interactionIntents).values({
        id: generateId(),
        workspaceId,
        intentType: 'http_gateway_route',
        sourceServiceId: serviceId,
        gatewayKind: 'zuul',
        routeScopeKind: 'prefix',
        externalRoutePattern: '/api/orders/**',
        providerHint: 'lb://orders',
        targetServiceHint: 'order-service',
        routeTransformRefs: ['route-transform-1'],
        methodConstraint: 'unknown',
        intentHash: 'intent-proof-schema-gateway-route',
        anchorHash: 'anchor-proof-schema-gateway-route',
      }),
    ).resolves.not.toThrow();
  });

  it('http_gateway_route intent는 필수 route family 슬롯이 없으면 저장되면 안 된다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(interactionIntents).values({
        id: generateId(),
        workspaceId,
        intentType: 'http_gateway_route',
        sourceServiceId: serviceId,
        intentHash: 'intent-proof-schema-gateway-route-invalid',
        anchorHash: 'anchor-proof-schema-gateway-route-invalid',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('proof dependency는 workspace/proof/kind/key 조합으로 유일해야 한다', async () => {
    if (!embeddedSupport.supported) return;
    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
    });

    await db.insert(proofDependencies).values({
      id: generateId(),
      workspaceId,
      proofStateId,
      dependencyKind: 'alias_binding',
      dependencyKey: 'clients.order.base-url',
      dependencyHash: 'hash-1',
    });

    await expect(
      db.insert(proofDependencies).values({
        id: generateId(),
        workspaceId,
        proofStateId,
        dependencyKind: 'alias_binding',
        dependencyKey: 'clients.order.base-url',
        dependencyHash: 'hash-2',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('proof state는 lineage와 route-family frontier detail을 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    const rootProofStateId = generateId();
    const childProofStateId = generateId();

    await db.insert(proofStates).values({
      id: rootProofStateId,
      workspaceId,
      intentId,
      originIntentId: intentId,
      proofType: 'http_gateway_route',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
      slotState: {
        routeFamilyState: 'seed_only',
        endpointCandidateSet: {
          objectIds: [targetId],
          count: 1,
          matchBasis: 'route_prefix',
        },
      },
    });

    await db.insert(proofStates).values({
      id: childProofStateId,
      workspaceId,
      intentId,
      originIntentId: intentId,
      parentProofStateId: rootProofStateId,
      proofType: 'http_call',
      status: 'CLOSED_ATOMIC',
      consumerServiceId: serviceId,
      targetObjectId: targetId,
      targetObjectType: 'api_endpoint',
      closedReason: 'route family child proof closed',
    });

    await expect(
      db.insert(proofFrontiers).values({
        proofStateId: rootProofStateId,
        workspaceId,
        frontierReason: 'ENDPOINT_SET_OPEN',
        frontierClass: 'TARGET',
        retryStrategy: 'deterministic',
        detail: {
          routeFamilyState: 'frontier',
          endpointCandidateSet: {
            objectIds: [targetId],
            count: 1,
            matchBasis: 'route_prefix',
          },
        },
      }),
    ).resolves.not.toThrow();
  });

  it('proof state는 confidence breakdown을 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(proofStates).values({
        id: generateId(),
        workspaceId,
        intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        confidence: 0,
        confidenceBreakdown: {
          summaryQuality: 0.82,
          slotCompleteness: 0.6,
          corroboration: 0.1,
          matchSpecificity: 0,
          contradictionPenalty: 0,
          statusCap: 0,
          finalConfidence: 0,
        },
      }),
    ).resolves.not.toThrow();
  });

  it('proof state는 같은 intent 아래 여러 child proof를 허용해야 한다', async () => {
    if (!embeddedSupport.supported) return;
    const rootProofStateId = generateId();

    await db.insert(proofStates).values({
      id: rootProofStateId,
      workspaceId,
      intentId,
      originIntentId: intentId,
      proofType: 'http_gateway_route',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
    });

    await expect(
      db.insert(proofStates).values([
        {
          id: generateId(),
          workspaceId,
          intentId,
          originIntentId: intentId,
          parentProofStateId: rootProofStateId,
          proofType: 'http_call',
          status: 'CLOSED_ATOMIC',
          consumerServiceId: serviceId,
          targetObjectId: targetId,
          targetObjectType: 'api_endpoint',
        },
        {
          id: generateId(),
          workspaceId,
          intentId,
          originIntentId: intentId,
          parentProofStateId: rootProofStateId,
          proofType: 'http_call',
          status: 'FRONTIER',
          consumerServiceId: serviceId,
        },
      ]),
    ).resolves.not.toThrow();
  });

  it('proof patch는 smart_agent source kind를 저장할 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    const proofStateId = generateId();

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
    });

    await expect(
      db.insert(proofPatches).values({
        id: generateId(),
        workspaceId,
        proofStateId,
        patchType: 'alias_binding',
        payload: {
          aliasKey: 'clients.order.base-url',
          resolvedServiceId: targetId,
        },
        sourceKind: 'smart_agent',
        validationStatus: 'PENDING',
      }),
    ).resolves.not.toThrow();
  });

  it('smart proof llm call은 proof patch와 연결되어 저장될 수 있다', async () => {
    if (!embeddedSupport.supported) return;
    const proofStateId = generateId();
    const patchId = generateId();

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
    });

    await db.insert(proofPatches).values({
      id: patchId,
      workspaceId,
      proofStateId,
      patchType: 'alias_binding',
      payload: {
        aliasKey: 'clients.order.base-url',
        resolvedServiceId: targetId,
      },
      sourceKind: 'smart_agent',
      validationStatus: 'PENDING',
    });

    await expect(
      db.insert(smartProofLlmCalls).values({
        id: generateId(),
        workspaceId,
        proofStateId,
        callCategory: 'frontier_resolution',
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        model: 'gpt-5.4',
        inputTokens: 1200,
        outputTokens: 140,
        promptHash: 'prompt-hash-1',
        responseHash: 'response-hash-1',
        promptSnapshot: { prompt: 'resolve host alias' },
        responseSnapshot: { resolved: true },
        confidence: 0.84,
        accepted: true,
        patchId,
        durationMs: 120,
      }),
    ).resolves.not.toThrow();
  });

  it('enum-like proof schema 값은 허용된 집합 밖이면 저장되면 안 된다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(aliasBindings).values({
        id: generateId(),
        workspaceId,
        bindingKind: 'invalid_binding_kind',
        aliasKey: 'client.order.url',
        aliasValue: 'ORDER_API',
        sourceHash: 'invalid-binding-kind',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('route transform은 route family IR 필드를 저장하되 invalid match_mode는 거부해야 한다', async () => {
    if (!embeddedSupport.supported) return;
    await expect(
      db.insert(routeTransforms).values({
        id: generateId(),
        workspaceId,
        gatewayKind: 'zuul',
        ownerServiceId: serviceId,
        matchPath: '/api/orders/**',
        matchMode: 'prefix',
        pathCapturePolicy: 'glob',
        routeMountPrefix: '/api',
        targetServiceHint: 'order-service',
        targetPathBaseHint: '/orders',
        sourceHash: 'route-family-ir-valid',
      }),
    ).resolves.not.toThrow();

    await expect(
      db.insert(routeTransforms).values({
        id: generateId(),
        workspaceId,
        gatewayKind: 'zuul',
        ownerServiceId: serviceId,
        matchPath: '/api/orders/**',
        matchMode: 'invalid_mode',
        sourceHash: 'route-family-ir-invalid',
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
