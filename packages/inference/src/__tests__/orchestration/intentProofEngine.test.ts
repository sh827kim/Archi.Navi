import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { inArray } from 'drizzle-orm';
import {
  aliasBindings,
  closeTestDb,
  createTestDb,
  domainInferenceProfiles,
  functionSummaries,
  getEmbeddedPostgresTestSupport,
  interactionIntents,
  objects,
  proofDependencies,
  proofFrontiers,
  proofPatches,
  proofStates,
  proofSteps,
  relationCandidates,
  routeTransforms,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  buildIntentProofResolverContext,
  normalizeIntentResolutionConcurrency,
  resolveWorkspaceInteractionIntents,
  resolveInteractionIntentProof,
  validateAndApplyProofPatch,
} from '@/orchestration/intentProofEngine';

const workspaceId = '00000000-0000-0000-0000-000000000321';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

if (!embeddedSupport.supported) {
  console.warn(
    `[inference:test] skipping intentProofEngine integration tests: ${
      embeddedSupport.reason ?? 'unsupported test database environment'
    }`,
  );
}

async function insertObject(
  db: TestDb,
  input: {
    id?: string;
    objectType: string;
    name: string;
    parentId?: string | null;
    metadata?: Record<string, unknown>;
    granularity?: string;
    category?: string | null;
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

async function insertObjectInWorkspace(
  db: TestDb,
  input: {
    workspaceId: string;
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
    workspaceId: input.workspaceId,
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

async function seedParallelOrderWorkspace(db: TestDb) {
  const workspaceId = generateId();
  await db.insert(workspaces).values({ id: workspaceId, name: 'parallel-order-test' });

  const consumerServiceId = await insertObjectInWorkspace(db, {
    workspaceId,
    objectType: 'service',
    name: 'order-service',
  });
  const sourceFunctionId = await insertObjectInWorkspace(db, {
    workspaceId,
    objectType: 'function',
    name: 'OrderService.fetchOrder',
    parentId: consumerServiceId,
    category: 'CODE',
  });
  const providerServiceId = await insertObjectInWorkspace(db, {
    workspaceId,
    objectType: 'service',
    name: 'order-api',
  });
  const endpointId = await insertObjectInWorkspace(db, {
    workspaceId,
    objectType: 'api_endpoint',
    name: 'GET /internal/orders/{id}',
    parentId: providerServiceId,
    category: 'CHANNEL',
    granularity: 'ATOMIC',
    metadata: { method: 'GET', path: '/internal/orders/{id}' },
  });

  await db.insert(aliasBindings).values({
    id: generateId(),
    workspaceId,
    bindingKind: 'property_alias',
    ownerServiceId: consumerServiceId,
    aliasKey: 'client.order.base-url',
    aliasValue: 'ORDER_API',
    resolvedServiceId: providerServiceId,
    resolvedHost: 'order-api.internal',
    sourceHash: `alias-${generateId()}`,
  });

  await db.insert(routeTransforms).values({
    id: generateId(),
    workspaceId,
    gatewayKind: 'gateway',
    ownerServiceId: consumerServiceId,
    matchPath: '/public/orders/*',
    stripPrefixCount: 1,
    prependPrefix: '/internal',
    targetServiceHint: 'order-api',
    sourceHash: `route-${generateId()}`,
  });

  const summaryId = generateId();
  await db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId,
    functionId: sourceFunctionId,
    serviceId: consumerServiceId,
    summaryKind: 'http',
    outboundHttp: {
      method: 'GET',
      path: '/public/orders/{id}',
      hostAlias: 'ORDER_API',
    },
    aliasHints: ['client.order.base-url'],
    signalSources: ['ast'],
    extractionStrategy: 'ast_primary',
    summaryCompleteness: 1,
    sourceHash: `summary-${generateId()}`,
    confidence: 0.96,
  });

  const firstIntentId = generateId();
  const secondIntentId = generateId();
  await db.insert(interactionIntents).values([
    {
      id: firstIntentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId,
      methodHint: 'GET',
      externalPathHint: '/public/orders/1',
      hostHint: 'ORDER_API',
      configKeys: ['client.order.base-url'],
      summaryRefs: [summaryId],
      evidenceIds: [],
      intentHash: `intent-http-order-1-${generateId()}`,
      anchorHash: `anchor-http-order-1-${generateId()}`,
    },
    {
      id: secondIntentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId,
      methodHint: 'GET',
      externalPathHint: '/public/orders/2',
      hostHint: 'ORDER_API',
      configKeys: ['client.order.base-url'],
      summaryRefs: [summaryId],
      evidenceIds: [],
      intentHash: `intent-http-order-2-${generateId()}`,
      anchorHash: `anchor-http-order-2-${generateId()}`,
    },
  ]);

  return { workspaceId, endpointId, intentIds: [firstIntentId, secondIntentId] };
}

async function summarizeResultProofStates(
  db: TestDb,
  proofResults: Awaited<ReturnType<typeof resolveWorkspaceInteractionIntents>>,
) {
  const stateRows = await db.select().from(proofStates).where(inArray(proofStates.id, proofResults.map((result) => result.proofStateId)));
  const stateMap = new Map(stateRows.map((state) => [state.id, state]));
  const targetObjectIds = [...new Set(proofResults.map((result) => result.targetObjectId).filter((id): id is string => Boolean(id)))];
  const targetObjects = targetObjectIds.length > 0
    ? await db.select({ id: objects.id, name: objects.name }).from(objects).where(inArray(objects.id, targetObjectIds))
    : [];
  const targetObjectNameById = new Map(targetObjects.map((object) => [object.id, object.name]));

  return proofResults.map((result) => {
    const state = stateMap.get(result.proofStateId);
    return {
      intentId: state?.intentId,
      status: result.status,
      relationType: result.relationType,
      frontierReason: result.frontierReason,
      targetObjectId: result.targetObjectId,
      targetObjectName: result.targetObjectId ? targetObjectNameById.get(result.targetObjectId) ?? null : null,
    };
  });
}

async function summarizeWorkspaceCandidates(
  db: TestDb,
  workspaceId: string,
) {
  const candidates = await db
    .select({
      relationType: relationCandidates.relationType,
      status: relationCandidates.status,
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
    })
    .from(relationCandidates)
    .where(eq(relationCandidates.workspaceId, workspaceId));

  const objectIds = [...new Set(candidates.flatMap((candidate) => [candidate.subjectObjectId, candidate.objectId]))];
  const namedObjects = objectIds.length > 0
    ? await db
      .select({ id: objects.id, name: objects.name })
      .from(objects)
      .where(inArray(objects.id, objectIds))
    : [];
  const objectNameById = new Map(namedObjects.map((object) => [object.id, object.name]));

  return candidates
    .map((candidate) => ({
      relationType: candidate.relationType,
      status: candidate.status,
      subjectName: objectNameById.get(candidate.subjectObjectId) ?? null,
      objectName: objectNameById.get(candidate.objectId) ?? null,
    }))
    .sort((left, right) =>
      (left.subjectName ?? '').localeCompare(right.subjectName ?? '')
      || (left.objectName ?? '').localeCompare(right.objectName ?? '')
      || left.relationType.localeCompare(right.relationType)
      || left.status.localeCompare(right.status));
}

describeDb('intent proof engine', () => {
  let db: TestDb | undefined;
  let serviceId: string;
  let functionId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'proof-test' });
    serviceId = await insertObject(db, { objectType: 'service', name: 'order-service' });
    functionId = await insertObject(db, {
      objectType: 'function',
      name: 'OrderService.fetchOrder',
      parentId: serviceId,
      category: 'CODE',
    });
  });

  afterEach(async () => {
    await closeTestDb(db);
    db = undefined;
  });

  it('resolveWorkspaceInteractionIntents는 기본 동작에서 입력 intent 순서를 보존해야 한다', async () => {
    const { workspaceId: ws, intentIds } = await seedParallelOrderWorkspace(db);
    const results = await resolveWorkspaceInteractionIntents(db, { workspaceId: ws });
    const stateSummary = await summarizeResultProofStates(db, results);

    expect(stateSummary.map((entry) => entry.intentId)).toEqual(intentIds);
  });

  it('resolveWorkspaceInteractionIntents는 concurrency=1과 concurrency>1 결과가 동일해야 한다', async () => {
    const base = await seedParallelOrderWorkspace(db);
    const concurrent = await seedParallelOrderWorkspace(db);

    const sequentialResults = await resolveWorkspaceInteractionIntents(db, { workspaceId: base.workspaceId });
    const parallelResults = await resolveWorkspaceInteractionIntents(db, {
      workspaceId: concurrent.workspaceId,
      concurrency: 3,
    });

    const sequentialSummary = await summarizeResultProofStates(db, sequentialResults);
    const parallelSummary = await summarizeResultProofStates(db, parallelResults);
    const sequentialCandidates = await summarizeWorkspaceCandidates(db, base.workspaceId);
    const parallelCandidates = await summarizeWorkspaceCandidates(db, concurrent.workspaceId);

    expect(parallelSummary.map((entry) => ({
      status: entry.status,
      relationType: entry.relationType,
      frontierReason: entry.frontierReason,
      targetObjectName: entry.targetObjectName,
    }))).toEqual(
      sequentialSummary.map((entry) => ({
        status: entry.status,
        relationType: entry.relationType,
        frontierReason: entry.frontierReason,
        targetObjectName: entry.targetObjectName,
      })),
    );
    expect(parallelCandidates).toEqual(sequentialCandidates);
  });

  it('resolveWorkspaceInteractionIntents concurrency는 기본값 1, 최대 8로 clamp해야 한다', () => {
    expect(normalizeIntentResolutionConcurrency(undefined)).toBe(1);
    expect(normalizeIntentResolutionConcurrency(0)).toBe(1);
    expect(normalizeIntentResolutionConcurrency(1)).toBe(1);
    expect(normalizeIntentResolutionConcurrency(3.8)).toBe(3);
    expect(normalizeIntentResolutionConcurrency(8)).toBe(8);
    expect(normalizeIntentResolutionConcurrency(99)).toBe(8);
  });

  it('HTTP intent는 고정 step 순서로 CLOSED_ATOMIC까지 닫고 call candidate를 projection해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    const profileId = generateId();
    const proofConfidenceConfig = {
      name: 'custom-proof-profile',
      version: 'v2',
      weights: {
        summaryQuality: 0.5,
        slotCompleteness: 0.2,
        corroborationPerSignal: 0.04,
        corroborationCap: 0.16,
        contradictionPenaltyPerItem: 0.2,
        contradictionPenaltyCap: 0.6,
      },
      slotWeights: {
        http: {
          method: 0.2,
          externalPath: 0.2,
          internalPath: 0.2,
          providerService: 0.2,
          targetObject: 0.2,
        },
        db: {
          action: 0.25,
          table: 0.25,
          schema: 0.15,
          datasource: 0.1,
          targetObject: 0.25,
        },
        message: {
          channel: 0.4,
          broker: 0.2,
          objectType: 0.15,
          targetObject: 0.25,
        },
      },
    };

    await db.insert(domainInferenceProfiles).values({
      id: profileId,
      workspaceId,
      name: 'default',
      kind: 'NAMED',
      isDefault: true,
    });
    await db.execute(sql`
      update domain_inference_profiles
      set proof_confidence_config = ${JSON.stringify(proofConfidenceConfig)}::jsonb
      where id = ${profileId}
    `);

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.order.base-url',
      aliasValue: 'ORDER_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'order-api.internal',
      sourceHash: 'alias-order-api',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'gateway',
      ownerServiceId: serviceId,
      matchPath: '/public/orders/*',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'order-api',
      sourceHash: 'route-order-api',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'http',
      outboundHttp: {
        method: 'GET',
        path: '/public/orders/123',
        hostAlias: 'ORDER_API',
      },
      aliasHints: ['client.order.base-url'],
      signalSources: ['ast'],
      extractionStrategy: 'ast_primary',
      summaryCompleteness: 1,
      sourceHash: 'summary-http-call',
      confidence: 0.96,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/public/orders/123',
      hostHint: 'ORDER_API',
      configKeys: ['client.order.base-url'],
      summaryRefs: [summaryId],
      intentHash: 'intent-http-call-closed',
      anchorHash: 'anchor-http-call-closed',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);
    expect(result.relationType).toBe('call');

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.providerServiceId).toBe(providerServiceId);
    expect(state?.methodResolved).toBe('GET');
    expect(state?.externalPathResolved).toBe('/public/orders/123');
    expect(state?.internalPathResolved).toBe('/internal/orders/123');
    expect(state?.confidence).toBeGreaterThan(0);
    expect(state?.confidenceBreakdown).toMatchObject({
      confidenceProfileName: 'custom-proof-profile',
      confidenceProfileVersion: 'v2',
      finalConfidence: state?.confidence,
    });

    const steps = await db
      .select()
      .from(proofSteps)
      .where(eq(proofSteps.proofStateId, result.proofStateId));
    expect(steps.map((step) => step.stepType)).toEqual([
      'anchorIntent',
      'hydrateFromFunctionSummary',
      'resolveHostAlias',
      'normalizeMethodAndPath',
      'applyRouteTransforms',
      'matchAtomicTarget',
      'validateContradictionsAndAmbiguity',
      'projectCandidate',
    ]);
    expect(steps.every((step) => step.status === 'APPLIED')).toBe(true);
    const hydrateStep = steps.find((step) => step.stepType === 'hydrateFromFunctionSummary');
    expect(hydrateStep?.outputSnapshot).toMatchObject({
      extractionStrategy: 'ast_primary',
      summaryCompleteness: 1,
      signalSources: ['ast'],
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('call');
    expect(candidates[0]?.objectId).toBe(endpointId);
    expect((candidates[0]?.metadata as Record<string, unknown> | null)?.['confidenceBreakdown']).toMatchObject({
      confidenceProfileName: 'custom-proof-profile',
      confidenceProfileVersion: 'v2',
      finalConfidence: state?.confidence,
    });
  });

  it('재실행 시 proof 기반 APPROVED/REJECTED candidate를 보존하고 새 PENDING으로 덮어쓰지 않아야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.order.base-url',
      aliasValue: 'ORDER_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'order-api.internal',
      sourceHash: 'alias-order-api-rerun',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'gateway',
      ownerServiceId: serviceId,
      matchPath: '/public/orders/*',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'order-api',
      sourceHash: 'route-order-api-rerun',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/public/orders/123',
      hostHint: 'ORDER_API',
      configKeys: ['client.order.base-url'],
      intentHash: 'intent-http-call-rerun-approved',
      anchorHash: 'anchor-http-call-rerun-approved',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('CLOSED_ATOMIC');
    expect(initial.targetObjectId).toBe(endpointId);

    const [projected] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(projected?.status).toBe('PENDING');

    await db
      .update(relationCandidates)
      .set({ status: 'APPROVED' })
      .where(eq(relationCandidates.id, projected!.id));

    const rerun = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(rerun.status).toBe('CLOSED_ATOMIC');
    expect(rerun.proofStateId).toBe(initial.proofStateId);

    const rerunCandidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(rerunCandidates).toHaveLength(1);
    expect(rerunCandidates[0]?.status).toBe('APPROVED');
    expect(rerunCandidates[0]?.objectId).toBe(endpointId);
    expect((rerunCandidates[0]?.metadata as Record<string, unknown> | null)?.['proofStateId']).toBe(
      initial.proofStateId,
    );
  });

  it('preloaded resolver context 경로도 HTTP proof 결과를 동일하게 유지해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.order.base-url',
      aliasValue: 'ORDER_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'order-api.internal',
      sourceHash: 'alias-order-api-indexed',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'gateway',
      ownerServiceId: serviceId,
      matchPath: '/public/orders/*',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'order-api',
      sourceHash: 'route-order-api-indexed',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'http',
      outboundHttp: {
        method: 'GET',
        path: '/public/orders/123',
        hostAlias: 'ORDER_API',
      },
      aliasHints: ['client.order.base-url'],
      sourceHash: 'summary-http-call-indexed',
      confidence: 0.96,
    });

    const baseIntent = {
      workspaceId,
      intentType: 'http_call' as const,
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/public/orders/123',
      hostHint: 'ORDER_API',
      configKeys: ['client.order.base-url'],
      summaryRefs: [summaryId],
      evidenceIds: [],
    };
    const intentIdA = generateId();
    const intentIdB = generateId();
    await db.insert(interactionIntents).values([
      {
        id: intentIdA,
        ...baseIntent,
        intentHash: 'intent-http-call-unindexed',
        anchorHash: 'anchor-http-call-unindexed',
      },
      {
        id: intentIdB,
        ...baseIntent,
        intentHash: 'intent-http-call-indexed',
        anchorHash: 'anchor-http-call-indexed',
      },
    ]);

    const unindexed = await resolveInteractionIntentProof(db, { workspaceId, intentId: intentIdA });
    const resolverContext = await buildIntentProofResolverContext(db, { workspaceId });
    const indexed = await resolveInteractionIntentProof(db, {
      workspaceId,
      intentId: intentIdB,
      resolverContext,
    });

    expect(unindexed).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: endpointId,
      relationType: 'call',
    });
    expect(indexed).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: endpointId,
      relationType: 'call',
    });

    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.proofType, 'http_call')));
    const stateA = states.find((state) => state.intentId === intentIdA);
    const stateB = states.find((state) => state.intentId === intentIdB);
    expect(stateA).toMatchObject({
      providerServiceId,
      methodResolved: 'GET',
      externalPathResolved: '/public/orders/123',
      internalPathResolved: '/internal/orders/123',
    });
    expect(stateB).toMatchObject({
      providerServiceId,
      methodResolved: 'GET',
      externalPathResolved: '/public/orders/123',
      internalPathResolved: '/internal/orders/123',
    });
    expect(stateA?.routeChain).toEqual(stateB?.routeChain);
  });

  it('summaryRefs가 여러 개면 최신 summaryVersion을 우선 선택해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDERS_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'orders-api.internal',
      sourceHash: 'alias-orders-api-summary-refs',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'gateway',
      ownerServiceId: serviceId,
      matchPath: '/api/orders/**',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'orders-api',
      sourceHash: 'route-orders-api-summary-refs',
    });

    const olderSummaryId = generateId();
    const newerSummaryId = generateId();
    await db.insert(functionSummaries).values([
      {
        id: olderSummaryId,
        workspaceId,
        functionId,
        serviceId,
        summaryVersion: 1,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/legacy/orders/123',
          hostAlias: 'LEGACY_API',
        },
        sourceHash: 'summary-http-legacy-v1',
        confidence: 0.81,
      },
      {
        id: newerSummaryId,
        workspaceId,
        functionId,
        serviceId,
        summaryVersion: 2,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/api/orders/123',
          hostAlias: 'ORDERS_API',
        },
        aliasHints: ['client.orders.url'],
        sourceHash: 'summary-http-orders-v2',
        confidence: 0.96,
      },
    ]);

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      summaryRefs: [olderSummaryId, newerSummaryId],
      intentHash: 'intent-summary-refs-latest',
      anchorHash: 'anchor-summary-refs-latest',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: endpointId,
      relationType: 'call',
    });

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state).toMatchObject({
      providerServiceId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      internalPathResolved: '/internal/orders/123',
    });
  });

  it('summaryRefs가 없으면 sourceFunctionId 기준 최신 summaryVersion을 우선 선택해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDERS_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'orders-api.internal',
      sourceHash: 'alias-orders-api-source-function-fallback',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'gateway',
      ownerServiceId: serviceId,
      matchPath: '/api/orders/**',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'orders-api',
      sourceHash: 'route-orders-api-source-function-fallback',
    });

    await db.insert(functionSummaries).values([
      {
        id: generateId(),
        workspaceId,
        functionId,
        serviceId,
        summaryVersion: 1,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/legacy/orders/123',
          hostAlias: 'LEGACY_API',
        },
        sourceHash: 'summary-http-legacy-source-function-v1',
        confidence: 0.81,
      },
      {
        id: generateId(),
        workspaceId,
        functionId,
        serviceId,
        summaryVersion: 2,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/api/orders/123',
          hostAlias: 'ORDERS_API',
        },
        aliasHints: ['client.orders.url'],
        sourceHash: 'summary-http-orders-source-function-v2',
        confidence: 0.96,
      },
    ]);

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      summaryRefs: [],
      intentHash: 'intent-source-function-latest',
      anchorHash: 'anchor-source-function-latest',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: endpointId,
      relationType: 'call',
    });

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state).toMatchObject({
      providerServiceId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      internalPathResolved: '/internal/orders/123',
    });
  });

  it('HTTP route transform chain은 source/provider 소유 transform을 순서대로 적용해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDERS_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'orders-api.internal',
      sourceHash: 'alias-orders-api-chain',
    });

    await db.insert(routeTransforms).values([
      {
        id: generateId(),
        workspaceId,
        gatewayKind: 'gateway',
        ownerServiceId: serviceId,
        matchPath: '/api/orders/*',
        stripPrefixCount: 1,
        targetServiceHint: 'orders-api',
        sourceHash: 'route-orders-strip',
      },
      {
        id: generateId(),
        workspaceId,
        gatewayKind: 'gateway',
        ownerServiceId: providerServiceId,
        matchPath: '/orders/*',
        prependPrefix: '/internal',
        targetServiceHint: 'orders-api',
        sourceHash: 'route-orders-prepend',
      },
    ]);

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/api/orders/123',
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-http-route-chain',
      anchorHash: 'anchor-http-route-chain',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    if (result.status === 'FRONTIER') {
      expect(result.frontierReason).toBe('CLOSED_ATOMIC');
    }

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.internalPathResolved).toBe('/internal/orders/123');
    expect(state?.routeChain).toHaveLength(2);
  });

  it('HTTP regex route transform도 external path를 매치해 atomic endpoint로 닫혀야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-regex-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.orders.regex-url',
      aliasValue: 'ORDERS_REGEX_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'orders-regex-api.internal',
      sourceHash: 'alias-orders-regex-api',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'custom',
      ownerServiceId: serviceId,
      matchPath: '^/gateway/orders/[0-9]+$',
      matchMode: 'regex',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'orders-regex-api',
      sourceHash: 'route-orders-regex-api',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/gateway/orders/123',
      hostHint: 'ORDERS_REGEX_API',
      configKeys: ['client.orders.regex-url'],
      intentHash: 'intent-http-route-regex',
      anchorHash: 'anchor-http-route-regex',
    });

    const result = await resolveInteractionIntentProof(db, {
      workspaceId,
      intentId,
    });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.providerServiceId).toBe(providerServiceId);
    expect(state?.externalPathResolved).toBe('/gateway/orders/123');
    expect(state?.internalPathResolved).toBe('/internal/orders/123');
    expect(state?.routeChain).toHaveLength(1);
  });

  it('HTTP route transform targetServiceHint는 gateway alias binding으로도 provider를 식별해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-backend' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/orders/{id}' },
    });

    await db.insert(aliasBindings).values([
      {
        id: generateId(),
        workspaceId,
        bindingKind: 'property_alias',
        ownerServiceId: serviceId,
        aliasKey: 'client.orders.url',
        aliasValue: 'ORDERS_API',
        resolvedServiceId: providerServiceId,
        resolvedHost: 'orders-backend.internal',
        sourceHash: 'alias-orders-backend-http',
      },
      {
        id: generateId(),
        workspaceId,
        bindingKind: 'gateway_target',
        ownerServiceId: null,
        aliasKey: 'orders-service',
        aliasValue: 'orders-service',
        resolvedServiceId: providerServiceId,
        sourceHash: 'alias-orders-backend-gateway-target',
      },
    ]);

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: null,
      matchPath: '/api/orders/**',
      stripPrefixCount: 1,
      targetServiceHint: 'orders-service',
      sourceHash: 'route-orders-backend-alias',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/api/orders/123',
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-http-route-target-alias',
      anchorHash: 'anchor-http-route-target-alias',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.internalPathResolved).toBe('/orders/123');
    expect(state?.routeChain).toHaveLength(1);
  });

  it('config-only gateway route는 method 없이도 path-only endpoint를 닫아야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/articles' },
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: gatewayServiceId,
      matchPath: '/api/articles',
      stripPrefixCount: 1,
      targetServiceHint: 'article-service',
      sourceHash: 'route-config-only-articles',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      externalPathHint: '/api/articles',
      gatewayKind: 'zuul',
      routeScopeKind: 'exact',
      externalRoutePattern: '/api/articles',
      providerHint: 'article-service',
      targetServiceHint: 'article-service',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'article-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#articles'],
      intentHash: 'intent-config-only-articles',
      anchorHash: 'anchor-config-only-articles',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);
    expect(result.relationType).toBe('call');

    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intentId)));
    expect(states).toHaveLength(2);
    const rootState = states.find((state) => state.parentProofStateId === null);
    const childState = states.find((state) => state.parentProofStateId !== null);

    expect(rootState?.proofType).toBe('http_gateway_route');
    expect(rootState?.providerServiceId).toBe(articleServiceId);
    expect(rootState?.internalPathResolved).toBe('/articles');
    expect(rootState?.targetObjectType).toBeNull();
    expect(rootState?.targetObjectId).toBeNull();
    expect(rootState?.status).toBe('RESOLVING');
    expect(rootState?.slotState).toMatchObject({
      routeFamilyState: 'derived_children',
      endpointCandidateSet: {
        count: 1,
        objectIds: [endpointId],
        matchBasis: 'route_exact',
      },
      derivedChildProofStateIds: [result.proofStateId],
    });

    expect(childState?.id).toBe(result.proofStateId);
    expect(childState?.originIntentId).toBe(intentId);
    expect(childState?.parentProofStateId).toBe(rootState?.id);
    expect(childState?.proofType).toBe('http_gateway_route');
    expect(childState?.providerServiceId).toBe(articleServiceId);
    expect(childState?.internalPathResolved).toBe('/articles');
    expect(childState?.targetObjectType).toBe('api_endpoint');
    expect(childState?.targetObjectId).toBe(endpointId);

    const steps = await db
      .select()
      .from(proofSteps)
      .where(eq(proofSteps.proofStateId, rootState!.id));
    expect(steps.map((step) => step.stepType)).toEqual(
      expect.arrayContaining(['deriveReachableEndpointSet', 'spawnEndpointScopedChildProofs', 'validateChildProofCompleteness']),
    );
    const childSteps = await db
      .select()
      .from(proofSteps)
      .where(eq(proofSteps.proofStateId, childState!.id));
    expect(childSteps.map((step) => step.stepType)).toEqual(
      expect.arrayContaining(['anchorDerivedChildProof', 'validateChildProofCompleteness', 'projectCandidate']),
    );

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates.some((candidate) => candidate.objectId === endpointId)).toBe(true);
    expect(candidates[0]?.metadata).toMatchObject({ proofStateId: childState?.id });
  });

  it('SCG config-only route도 method 없이 path-only endpoint를 닫아야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const orderServiceId = await insertObject(db, { objectType: 'service', name: 'order-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /orders',
      parentId: orderServiceId,
      metadata: { method: 'GET', path: '/orders' },
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'spring_cloud_gateway',
      ownerServiceId: gatewayServiceId,
      matchPath: '/api/orders',
      stripPrefixCount: 1,
      targetServiceHint: 'order-api',
      sourceHash: 'route-config-only-scfg',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      externalPathHint: '/api/orders',
      gatewayKind: 'spring_cloud_gateway',
      routeScopeKind: 'exact',
      externalRoutePattern: '/api/orders',
      providerHint: 'order-api',
      targetServiceHint: 'order-api',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'order-api',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#orders'],
      intentHash: 'intent-config-only-scfg-orders',
      anchorHash: 'anchor-config-only-scfg-orders',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);
    expect(result.relationType).toBe('call');

    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intentId)));
    expect(states).toHaveLength(2);
    const rootState = states.find((state) => state.parentProofStateId === null);
    const childState = states.find((state) => state.parentProofStateId !== null);

    expect(rootState?.proofType).toBe('http_gateway_route');
    expect(rootState?.providerServiceId).toBe(orderServiceId);
    expect(rootState?.internalPathResolved).toBe('/orders');
    expect(rootState?.targetObjectType).toBeNull();
    expect(rootState?.targetObjectId).toBeNull();
    expect(rootState?.status).toBe('RESOLVING');
    expect(rootState?.slotState).toMatchObject({
      routeFamilyState: 'derived_children',
      endpointCandidateSet: {
        count: 1,
        objectIds: [endpointId],
        matchBasis: 'route_exact',
      },
      derivedChildProofStateIds: [result.proofStateId],
    });

    expect(childState?.id).toBe(result.proofStateId);
    expect(childState?.originIntentId).toBe(intentId);
    expect(childState?.parentProofStateId).toBe(rootState?.id);
    expect(childState?.proofType).toBe('http_gateway_route');
    expect(childState?.providerServiceId).toBe(orderServiceId);
    expect(childState?.internalPathResolved).toBe('/orders');
    expect(childState?.targetObjectType).toBe('api_endpoint');
    expect(childState?.targetObjectId).toBe(endpointId);
  });

  it('config-only gateway route에서 endpoint family가 너무 넓게 열리면 service fallback 대신 ROUTE_FAMILY_TOO_BROAD frontier로 남겨야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    const endpointA = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles/{id}',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/articles/{id}' },
    });
    const endpointB = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles/{articleId}',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/articles/{articleId}' },
    });
    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: gatewayServiceId,
      matchPath: '/api/articles/*',
      stripPrefixCount: 1,
      targetServiceHint: 'article-service',
      sourceHash: 'route-config-only-articles-family',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      externalPathHint: '/api/articles',
      gatewayKind: 'zuul',
      routeScopeKind: 'prefix',
      externalRoutePattern: '/api/articles/*',
      providerHint: 'article-service',
      targetServiceHint: 'article-service',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'article-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#articles-family'],
      intentHash: 'intent-config-only-articles-family',
      anchorHash: 'anchor-config-only-articles-family',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('ROUTE_FAMILY_TOO_BROAD');

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.targetObjectType).toBeNull();
    expect(state?.targetObjectId).toBeNull();

    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(eq(proofFrontiers.proofStateId, result.proofStateId));
    expect(frontier?.frontierReason).toBe('ROUTE_FAMILY_TOO_BROAD');
    expect(frontier?.detail).toMatchObject({
      endpointCandidateSet: {
        count: 2,
        objectIds: expect.arrayContaining([endpointA, endpointB]),
        matchBasis: 'route_prefix',
      },
      routeFamilyState: 'frontier',
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });

  it('config-only gateway route가 bounded endpoint family를 만들면 여러 child proof를 생성하고 atomic 후보만 projection해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    const collectionEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/articles' },
    });
    const detailEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles/{id}',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/articles/{id}' },
    });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /health',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/health' },
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: gatewayServiceId,
      matchPath: '/api/articles/**',
      stripPrefixCount: 1,
      targetServiceHint: 'article-service',
      sourceHash: 'route-config-only-articles-bounded-family',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      externalPathHint: '/api/articles',
      gatewayKind: 'zuul',
      routeScopeKind: 'prefix',
      externalRoutePattern: '/api/articles/**',
      providerHint: 'article-service',
      targetServiceHint: 'article-service',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'article-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#articles-bounded-family'],
      intentHash: 'intent-config-only-articles-bounded-family',
      anchorHash: 'anchor-config-only-articles-bounded-family',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');

    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intentId)));
    const rootState = states.find((state) => state.parentProofStateId === null);
    const childStates = states.filter((state) => state.parentProofStateId !== null);

    expect(rootState?.slotState).toMatchObject({
      routeFamilyState: 'derived_children',
      endpointCandidateSet: {
        objectIds: expect.arrayContaining([collectionEndpointId, detailEndpointId]),
        matchBasis: 'route_prefix',
      },
      derivedChildProofStateIds: expect.arrayContaining(childStates.map((state) => state.id)),
    });
    expect(childStates.length).toBeGreaterThanOrEqual(2);
    expect(childStates.map((state) => state.originIntentId)).toEqual(
      expect.arrayContaining([intentId, intentId]),
    );
    expect(childStates.every((state) => state.parentProofStateId === rootState?.id)).toBe(true);
    expect(childStates.every((state) => state.status === 'CLOSED_ATOMIC')).toBe(true);
    expect(childStates.map((state) => state.targetObjectId)).toEqual(
      expect.arrayContaining([collectionEndpointId, detailEndpointId]),
    );

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates.map((candidate) => candidate.objectId)).toEqual(
      expect.arrayContaining([collectionEndpointId, detailEndpointId]),
    );
    expect(
      candidates.every((candidate) => childStates.some(
        (state) => (candidate.metadata as Record<string, unknown> | null)?.['proofStateId'] === state.id,
      )),
    ).toBe(true);
  });

  it('config-only gateway route는 global prefix와 stripped external hint 조합에서도 root-relative endpoint family를 child proof로 닫아야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    const collectionEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/' },
    });
    const detailEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /{id}',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/{id}' },
    });
    const authorEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /author/{authorId}',
      parentId: articleServiceId,
      metadata: { method: 'GET', path: '/author/{authorId}' },
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: gatewayServiceId,
      matchPath: '/articles/**',
      prependPrefix: '/api',
      targetServiceHint: 'article-service',
      sourceHash: 'route-config-only-articles-global-prefix-anchor',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      externalPathHint: '/articles',
      gatewayKind: 'zuul',
      routeScopeKind: 'prefix',
      externalRoutePattern: '/api/articles/**',
      providerHint: 'article-service',
      targetServiceHint: 'article-service',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'article-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#articles-global-prefix-anchor'],
      intentHash: 'intent-config-only-articles-global-prefix-anchor',
      anchorHash: 'anchor-config-only-articles-global-prefix-anchor',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');

    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intentId)));
    expect(states).toHaveLength(4);
    const rootState = states.find((state) => state.parentProofStateId === null);
    const childStates = states.filter((state) => state.parentProofStateId !== null);

    expect(rootState?.slotState).toMatchObject({
      routeFamilyState: 'derived_children',
      endpointCandidateSet: {
        count: 3,
        objectIds: expect.arrayContaining([collectionEndpointId, detailEndpointId, authorEndpointId]),
        matchBasis: 'route_prefix',
      },
      derivedChildProofStateIds: expect.arrayContaining(childStates.map((state) => state.id)),
    });
    expect(childStates).toHaveLength(3);
    expect(childStates.map((state) => state.targetObjectId).sort()).toEqual(
      [collectionEndpointId, detailEndpointId, authorEndpointId].sort(),
    );

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.objectId).sort()).toEqual(
      [collectionEndpointId, detailEndpointId, authorEndpointId].sort(),
    );
  });

  it('config-only gateway route가 exact path로도 provider endpoint를 못 찾으면 ROUTE_FAMILY_DERIVATION_EMPTY frontier여야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const authorServiceId = await insertObject(db, { objectType: 'service', name: 'author-service' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /authors/{id}',
      parentId: authorServiceId,
      metadata: { method: 'GET', path: '/authors/{id}' },
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: gatewayServiceId,
      matchPath: '/api/articles/fixed',
      targetServiceHint: 'author-service',
      sourceHash: 'route-config-only-no-endpoint-match',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      methodHint: null,
      externalPathHint: '/api/articles/fixed',
      gatewayKind: 'zuul',
      routeScopeKind: 'exact',
      externalRoutePattern: '/api/articles/fixed',
      providerHint: 'author-service',
      targetServiceHint: 'author-service',
      routeTransformRefs: [],
      methodConstraint: 'unknown',
      hostHint: 'author-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#articles-exact-no-match'],
      intentHash: 'intent-config-only-no-endpoint-match',
      anchorHash: 'anchor-config-only-no-endpoint-match',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('ROUTE_FAMILY_DERIVATION_EMPTY');

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.providerServiceId).toBe(authorServiceId);
    expect(state?.targetObjectType).toBeNull();
    expect(state?.targetObjectId).toBeNull();

    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(eq(proofFrontiers.proofStateId, result.proofStateId));
    expect(frontier?.frontierReason).toBe('ROUTE_FAMILY_DERIVATION_EMPTY');
    expect(frontier?.detail).toMatchObject({
      endpointCandidateSet: {
        count: 0,
        objectIds: [],
      },
      routeFamilyState: 'frontier',
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });

  it('HTTP host alias를 닫지 못하면 HOST_ALIAS_UNRESOLVED frontier로 유지하고 projection하지 않아야 한다', async () => {
    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'missing-host',
      intentHash: 'intent-http-host-missing',
      anchorHash: 'anchor-http-host-missing',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('HOST_ALIAS_UNRESOLVED');

    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(eq(proofFrontiers.proofStateId, result.proofStateId));
    expect(frontier?.frontierReason).toBe('HOST_ALIAS_UNRESOLVED');

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });

  it('HTTP method contradiction은 REJECTED로 전이되고 candidate를 만들지 않아야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'billing-api' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /billing/invoices/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/billing/invoices/{id}' },
    });
    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.billing.url',
      aliasValue: 'BILLING_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-billing-api',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'http',
      outboundHttp: {
        method: 'POST',
        path: '/billing/invoices/123',
        hostAlias: 'BILLING_API',
      },
      aliasHints: ['client.billing.url'],
      sourceHash: 'summary-http-contradiction',
      confidence: 0.92,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/billing/invoices/123',
      hostHint: 'BILLING_API',
      configKeys: ['client.billing.url'],
      summaryRefs: [summaryId],
      intentHash: 'intent-http-contradiction',
      anchorHash: 'anchor-http-contradiction',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('REJECTED');
    expect(result.targetObjectId).toBeNull();

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, result.proofStateId));
    expect(state?.rejectedReason).toBe('METHOD_CONTRADICTION');

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });

  it('HTTP endpoint fan-out가 남으면 ENDPOINT_MATCH_AMBIGUOUS frontier로 유지해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'inventory-api' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /inventory/items/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/inventory/items/{id}' },
    });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /inventory/items/{itemId}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/inventory/items/{itemId}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.inventory.url',
      aliasValue: 'INVENTORY_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-inventory-api',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/inventory/items/123',
      hostHint: 'INVENTORY_API',
      configKeys: ['client.inventory.url'],
      intentHash: 'intent-http-ambiguous',
      anchorHash: 'anchor-http-ambiguous',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('ENDPOINT_MATCH_AMBIGUOUS');

    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(eq(proofFrontiers.proofStateId, result.proofStateId));
    expect(frontier?.frontierReason).toBe('ENDPOINT_MATCH_AMBIGUOUS');

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });

  it('endpoint_disambiguation patch는 ambiguous frontier를 닫고 target endpoint를 고정해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'shipping-api' });
    const endpointA = await insertObject(db, {
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

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.shipping.url',
      aliasValue: 'SHIPPING_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-shipping-api',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/shipping/labels/123',
      hostHint: 'SHIPPING_API',
      configKeys: ['client.shipping.url'],
      intentHash: 'intent-http-endpoint-patch',
      anchorHash: 'anchor-http-endpoint-patch',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('ENDPOINT_MATCH_AMBIGUOUS');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'endpoint_disambiguation',
      payload: {
        endpointId: endpointA,
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('ACCEPTED');
    expect(patchResult.resolution?.status).toBe('CLOSED_ATOMIC');
    expect(patchResult.resolution?.targetObjectId).toBe(endpointA);
  });

  it('존재하지 않는 endpoint_disambiguation patch는 REJECTED로 남겨야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'returns-api' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /returns/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/returns/{id}' },
    });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /returns/{returnId}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/returns/{returnId}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.returns.url',
      aliasValue: 'RETURNS_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-returns-api',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/returns/123',
      hostHint: 'RETURNS_API',
      configKeys: ['client.returns.url'],
      intentHash: 'intent-http-endpoint-patch-invalid',
      anchorHash: 'anchor-http-endpoint-patch-invalid',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('ENDPOINT_MATCH_AMBIGUOUS');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'endpoint_disambiguation',
      payload: {
        endpointId: generateId(),
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('REJECTED');
    expect(patchResult.errors).toContain('endpointId must reference an existing object');
  });

  it('provider_service_selection patch는 provider ambiguity frontier를 닫고 selected provider를 우선 적용해야 한다', async () => {
    const providerAServiceId = await insertObject(db, { objectType: 'service', name: 'order-api-a' });
    const providerBServiceId = await insertObject(db, { objectType: 'service', name: 'order-api-b' });
    const endpointA = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /orders/{id}',
      parentId: providerAServiceId,
      metadata: { method: 'GET', path: '/orders/{id}' },
    });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /orders/{id}',
      parentId: providerBServiceId,
      metadata: { method: 'GET', path: '/orders/{id}' },
    });
    await db.insert(aliasBindings).values([
      {
        id: generateId(),
        workspaceId,
        bindingKind: 'property_alias',
        ownerServiceId: serviceId,
        aliasKey: 'client.order-a.url',
        aliasValue: 'ORDER_API',
        resolvedServiceId: providerAServiceId,
        sourceHash: 'alias-order-api-a',
      },
      {
        id: generateId(),
        workspaceId,
        bindingKind: 'property_alias',
        ownerServiceId: serviceId,
        aliasKey: 'client.order-b.url',
        aliasValue: 'ORDER_API',
        resolvedServiceId: providerBServiceId,
        sourceHash: 'alias-order-api-b',
      },
    ]);

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDER_API',
      configKeys: [],
      intentHash: 'intent-http-provider-ambiguity-patch',
      anchorHash: 'anchor-http-provider-ambiguity-patch',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('PROVIDER_SERVICE_AMBIGUOUS');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'provider_service_selection',
      payload: {
        selectedServiceId: providerAServiceId,
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('ACCEPTED');
    expect(patchResult.resolution?.status).toBe('CLOSED_ATOMIC');
    expect(patchResult.resolution?.targetObjectId).toBe(endpointA);
  });

  it('contradiction_challenge patch는 low-confidence CLOSED_ATOMIC proof를 frontier로 재분류해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDER_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-order-api-contradiction',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDER_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-http-contradiction-challenge',
      anchorHash: 'anchor-http-contradiction-challenge',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('CLOSED_ATOMIC');
    expect(initial.targetObjectId).toBe(endpointId);

    await db
      .update(proofStates)
      .set({
        confidence: 0.42,
      })
      .where(eq(proofStates.id, initial.proofStateId));

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'contradiction_challenge',
      payload: {
        challengeReasons: ['LOW_CONFIDENCE_FALSE_POSITIVE'],
        expectedAction: 'reopen_frontier',
      },
      sourceKind: 'smart_agent',
    });

    expect(patchResult.validationStatus).toBe('ACCEPTED');
    expect(patchResult.resolution?.status).toBe('FRONTIER');
    expect(patchResult.resolution?.frontierReason).toBe('SMART_CONTRADICTION_CHALLENGED');

    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(eq(proofFrontiers.proofStateId, initial.proofStateId))
      .limit(1);
    expect(frontier?.frontierReason).toBe('SMART_CONTRADICTION_CHALLENGED');
  });

  it('method_path_hint patch는 METHOD_UNKNOWN frontier를 닫고 target endpoint를 고정해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'catalog-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /catalog/items/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/catalog/items/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.catalog.url',
      aliasValue: 'CATALOG_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-catalog-api',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: null,
      externalPathHint: '/catalog/items/123',
      hostHint: 'CATALOG_API',
      configKeys: ['client.catalog.url'],
      intentHash: 'intent-http-method-patch',
      anchorHash: 'anchor-http-method-patch',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('METHOD_UNKNOWN');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'method_path_hint',
      payload: {
        method: 'GET',
        externalPath: '/catalog/items/123',
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('ACCEPTED');
    expect(patchResult.resolution?.status).toBe('CLOSED_ATOMIC');
    expect(patchResult.resolution?.targetObjectId).toBe(endpointId);
  });

  it('필수 필드가 없는 method_path_hint patch는 REJECTED로 남겨야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'billing-api' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'POST /billing/charges',
      parentId: providerServiceId,
      metadata: { method: 'POST', path: '/billing/charges' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.billing.url',
      aliasValue: 'BILLING_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-billing-api',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: null,
      externalPathHint: '/billing/charges',
      hostHint: 'BILLING_API',
      configKeys: ['client.billing.url'],
      intentHash: 'intent-http-method-patch-invalid',
      anchorHash: 'anchor-http-method-patch-invalid',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('METHOD_UNKNOWN');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'method_path_hint',
      payload: {
        externalPath: '/billing/charges',
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('REJECTED');
    expect(patchResult.errors).toContain('method is required');
  });

  it('DB read intent는 단일 db_table로 닫히고 read candidate를 projection해야 한다', async () => {
    const databaseId = await insertObject(db, {
      objectType: 'database',
      name: 'order-db',
      category: 'STORAGE',
      granularity: 'COMPOUND',
    });
    const tableId = await insertObject(db, {
      objectType: 'db_table',
      name: 'orders',
      parentId: databaseId,
      category: 'STORAGE',
      metadata: { schema: 'public' },
    });
    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'db',
      outboundDb: { action: 'SELECT', schema: 'public', table: 'orders' },
      sourceHash: 'summary-db-select',
      confidence: 0.93,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'db_access',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      resourceHint: 'public.orders',
      methodHint: 'SELECT',
      summaryRefs: [summaryId],
      intentHash: 'intent-db-read',
      anchorHash: 'anchor-db-read',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(tableId);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('read');
    expect(candidates[0]?.objectId).toBe(tableId);
  });

  it('DB config key alias binding은 동일 schema/table fan-out을 실제 target database로 좁혀야 한다', async () => {
    const orderDbId = await insertObject(db, {
      objectType: 'database',
      name: 'order-db',
      category: 'STORAGE',
      granularity: 'COMPOUND',
      metadata: { host: 'order-db.internal' },
    });
    const auditDbId = await insertObject(db, {
      objectType: 'database',
      name: 'audit-db',
      category: 'STORAGE',
      granularity: 'COMPOUND',
      metadata: { host: 'audit-db.internal' },
    });
    const targetTableId = await insertObject(db, {
      objectType: 'db_table',
      name: 'orders',
      parentId: orderDbId,
      category: 'STORAGE',
      metadata: { schema: 'public' },
    });
    await insertObject(db, {
      objectType: 'db_table',
      name: 'orders',
      parentId: auditDbId,
      category: 'STORAGE',
      metadata: { schema: 'public' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'spring.datasource.orders',
      aliasValue: 'ORDERS_DS',
      resolvedHost: 'order-db.internal',
      sourceHash: 'alias-db-orders-ds',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'db',
      outboundDb: { action: 'SELECT', schema: 'public', table: 'orders' },
      aliasHints: ['spring.datasource.orders'],
      sourceHash: 'summary-db-config-select',
      confidence: 0.94,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'db_access',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      resourceHint: 'public.orders',
      methodHint: 'SELECT',
      configKeys: ['spring.datasource.orders'],
      summaryRefs: [summaryId],
      intentHash: 'intent-db-config-read',
      anchorHash: 'anchor-db-config-read',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(targetTableId);
  });

  it('preloaded resolver context 경로도 DB proof 결과를 동일하게 유지해야 한다', async () => {
    const databaseId = await insertObject(db, {
      objectType: 'database',
      name: 'order-db',
      category: 'STORAGE',
      granularity: 'COMPOUND',
    });
    const tableId = await insertObject(db, {
      objectType: 'db_table',
      name: 'orders',
      parentId: databaseId,
      category: 'STORAGE',
      metadata: { schema: 'public' },
    });
    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'db',
      outboundDb: { action: 'SELECT', schema: 'public', table: 'orders' },
      sourceHash: 'summary-db-indexed-parity',
      confidence: 0.93,
    });

    const baseIntent = {
      workspaceId,
      intentType: 'db_access' as const,
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      resourceHint: 'public.orders',
      methodHint: 'SELECT',
      summaryRefs: [summaryId],
    };
    const intentIdA = generateId();
    const intentIdB = generateId();
    await db.insert(interactionIntents).values([
      {
        id: intentIdA,
        ...baseIntent,
        intentHash: 'intent-db-unindexed-parity',
        anchorHash: 'anchor-db-unindexed-parity',
      },
      {
        id: intentIdB,
        ...baseIntent,
        intentHash: 'intent-db-indexed-parity',
        anchorHash: 'anchor-db-indexed-parity',
      },
    ]);

    const unindexed = await resolveInteractionIntentProof(db, { workspaceId, intentId: intentIdA });
    const resolverContext = await buildIntentProofResolverContext(db, { workspaceId });
    const indexed = await resolveInteractionIntentProof(db, {
      workspaceId,
      intentId: intentIdB,
      resolverContext,
    });

    expect(unindexed).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: tableId,
      relationType: 'read',
    });
    expect(indexed).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: tableId,
      relationType: 'read',
    });
  });

  it('DB write intent는 write candidate로 projection해야 한다', async () => {
    const databaseId = await insertObject(db, {
      objectType: 'database',
      name: 'billing-db',
      category: 'STORAGE',
      granularity: 'COMPOUND',
    });
    const tableId = await insertObject(db, {
      objectType: 'db_table',
      name: 'payments',
      parentId: databaseId,
      category: 'STORAGE',
      metadata: { schema: 'billing' },
    });
    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'db',
      outboundDb: { action: 'UPDATE', schema: 'billing', table: 'payments' },
      sourceHash: 'summary-db-write',
      confidence: 0.95,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'db_access',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      resourceHint: 'billing.payments',
      methodHint: 'UPDATE',
      summaryRefs: [summaryId],
      intentHash: 'intent-db-write',
      anchorHash: 'anchor-db-write',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(tableId);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('write');
    expect(candidates[0]?.objectId).toBe(tableId);
  });

  it('동일 table명이 여러 schema에 있으면 frontier로 유지하고 후보를 만들지 않아야 한다', async () => {
    const dbA = await insertObject(db, {
      objectType: 'database',
      name: 'order-db-a',
      category: 'STORAGE',
      granularity: 'COMPOUND',
    });
    const dbB = await insertObject(db, {
      objectType: 'database',
      name: 'order-db-b',
      category: 'STORAGE',
      granularity: 'COMPOUND',
    });
    await insertObject(db, {
      objectType: 'db_table',
      name: 'orders',
      parentId: dbA,
      category: 'STORAGE',
      metadata: { schema: 'public' },
    });
    await insertObject(db, {
      objectType: 'db_table',
      name: 'orders',
      parentId: dbB,
      category: 'STORAGE',
      metadata: { schema: 'audit' },
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'db_access',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      resourceHint: 'orders',
      methodHint: 'SELECT',
      intentHash: 'intent-db-ambiguous',
      anchorHash: 'anchor-db-ambiguous',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('DB_SCHEMA_AMBIGUOUS');

    const frontiers = await db.select().from(proofFrontiers).where(eq(proofFrontiers.workspaceId, workspaceId));
    expect(frontiers[0]?.retryStrategy).toBe('manual_review');

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });

  it('message publish intent는 topic으로 닫히고 produce candidate를 projection해야 한다', async () => {
    const topicId = await insertObject(db, {
      objectType: 'topic',
      name: 'orders.created',
      category: 'CHANNEL',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'message',
      outboundMessage: { topic: 'orders.created', channelType: 'topic' },
      sourceHash: 'summary-msg-publish',
      confidence: 0.91,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'message_publish',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      summaryRefs: [summaryId],
      intentHash: 'intent-message-publish',
      anchorHash: 'anchor-message-publish',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(topicId);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('produce');
    expect(candidates[0]?.objectId).toBe(topicId);
  });

  it('preloaded resolver context 경로도 message proof 결과를 동일하게 유지해야 한다', async () => {
    const topicId = await insertObject(db, {
      objectType: 'topic',
      name: 'orders.created',
      category: 'CHANNEL',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'message',
      outboundMessage: { topic: 'orders.created', channelType: 'topic' },
      sourceHash: 'summary-message-indexed-parity',
      confidence: 0.91,
    });

    const baseIntent = {
      workspaceId,
      intentType: 'message_publish' as const,
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      summaryRefs: [summaryId],
    };
    const intentIdA = generateId();
    const intentIdB = generateId();
    await db.insert(interactionIntents).values([
      {
        id: intentIdA,
        ...baseIntent,
        intentHash: 'intent-message-unindexed-parity',
        anchorHash: 'anchor-message-unindexed-parity',
      },
      {
        id: intentIdB,
        ...baseIntent,
        intentHash: 'intent-message-indexed-parity',
        anchorHash: 'anchor-message-indexed-parity',
      },
    ]);

    const unindexed = await resolveInteractionIntentProof(db, { workspaceId, intentId: intentIdA });
    const resolverContext = await buildIntentProofResolverContext(db, { workspaceId });
    const indexed = await resolveInteractionIntentProof(db, {
      workspaceId,
      intentId: intentIdB,
      resolverContext,
    });

    expect(unindexed).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: topicId,
      relationType: 'produce',
    });
    expect(indexed).toMatchObject({
      status: 'CLOSED_ATOMIC',
      targetObjectId: topicId,
      relationType: 'produce',
    });
  });

  it('message broker alias binding은 동일 topic fan-out을 target broker로 좁혀야 한다', async () => {
    await insertObject(db, {
      objectType: 'topic',
      name: 'orders.created',
      category: 'CHANNEL',
      metadata: { bootstrapServers: 'kafka-a:9092' },
    });
    const targetTopicId = await insertObject(db, {
      objectType: 'topic',
      name: 'orders.created',
      category: 'CHANNEL',
      metadata: { bootstrapServers: 'kafka-b:9092' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'spring.kafka.bootstrap-servers',
      aliasValue: 'BROKER_B',
      resolvedHost: 'kafka-b:9092',
      sourceHash: 'alias-message-broker-b',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'message',
      outboundMessage: { topic: 'orders.created', channelType: 'topic' },
      aliasHints: ['spring.kafka.bootstrap-servers'],
      sourceHash: 'summary-msg-broker-config',
      confidence: 0.92,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'message_publish',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      configKeys: ['spring.kafka.bootstrap-servers'],
      summaryRefs: [summaryId],
      intentHash: 'intent-message-broker-config',
      anchorHash: 'anchor-message-broker-config',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(targetTopicId);
  });

  it('유효하지 않은 patch는 REJECTED로 기록되고 frontier 상태를 유지해야 한다', async () => {
    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'message_publish',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      intentHash: 'intent-invalid-patch',
      anchorHash: 'anchor-invalid-patch',
    });

    const resolution = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(resolution.status).toBe('FRONTIER');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: resolution.proofStateId,
      patchType: 'alias_binding',
      payload: { aliasKey: 'orders.topic' },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('REJECTED');
    expect(patchResult.errors).toContain('aliasValue is required');

    const [state] = await db
      .select()
      .from(proofStates)
      .where(eq(proofStates.id, resolution.proofStateId));
    expect(state?.status).toBe('FRONTIER');

    const patches = await db.select().from(proofPatches).where(eq(proofPatches.proofStateId, resolution.proofStateId));
    expect(patches[0]?.validationStatus).toBe('REJECTED');
  });

  it('dynamic URI signal이 있으면 config binding missing보다 DYNAMIC_URI_UNRESOLVED를 우선해야 한다', async () => {
    const intentId = generateId();
    await db.insert(functionSummaries).values({
      id: generateId(),
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'http',
      outboundHttp: {
        method: 'GET',
        path: '/orders/{id}',
        dynamicPath: true,
      },
      flags: {
        dynamicPath: true,
      },
      aliasHints: ['client.orders.url'],
      sourceHash: 'summary-dynamic-uri-frontier',
      confidence: 0.9,
    });
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-dynamic-uri-frontier',
      anchorHash: 'anchor-dynamic-uri-frontier',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('DYNAMIC_URI_UNRESOLVED');
  });

  it('path만 남은 HTTP intent는 PATH_ONLY_TARGET_UNRESOLVED로 분류해야 한다', async () => {
    const intentId = generateId();
    await db.insert(functionSummaries).values({
      id: generateId(),
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'http',
      outboundHttp: {
        method: 'GET',
        path: '/orders/{id}',
      },
      sourceHash: 'summary-path-only-frontier',
      confidence: 0.88,
    });
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      intentHash: 'intent-path-only-frontier',
      anchorHash: 'anchor-path-only-frontier',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });

    expect(result.status).toBe('FRONTIER');
    expect(result.frontierReason).toBe('PATH_ONLY_TARGET_UNRESOLVED');
  });

  it('frontier와 무관한 weak alias patch는 REJECTED여야 한다', async () => {
    const unrelatedServiceId = await insertObject(db, { objectType: 'service', name: 'billing-api' });
    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      intentHash: 'intent-weak-alias-patch',
      anchorHash: 'anchor-weak-alias-patch',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('CONFIG_BINDING_MISSING');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'alias_binding',
      payload: {
        ownerServiceId: serviceId,
        aliasKey: 'client.billing.url',
        aliasValue: 'BILLING_API',
        resolvedServiceId: unrelatedServiceId,
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('REJECTED');
    expect(patchResult.errors).toEqual(expect.arrayContaining([
      'aliasKey must reference a frontier host/config hint',
      'aliasValue must align with the unresolved host alias',
      'resolvedServiceId must align with downstream service hints',
    ]));
  });

  it('smart_agent alias patch는 review 모드일 때 PENDING으로 저장되고 frontier를 유지해야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-service' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      targetServiceHint: 'orders-service',
      intentHash: 'intent-smart-agent-review-patch',
      anchorHash: 'anchor-smart-agent-review-patch',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('CONFIG_BINDING_MISSING');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'alias_binding',
      payload: {
        ownerServiceId: serviceId,
        aliasKey: 'client.orders.url',
        aliasValue: 'ORDERS_API',
        resolvedServiceId: providerServiceId,
      },
      sourceKind: 'smart_agent',
      applyMode: 'defer',
    });

    expect(patchResult.validationStatus).toBe('PENDING');
    const patches = await db.select().from(proofPatches).where(eq(proofPatches.proofStateId, initial.proofStateId));
    expect(patches[0]?.sourceKind).toBe('smart_agent');
    expect(patches[0]?.validationStatus).toBe('PENDING');

    const states = await db.select().from(proofStates).where(eq(proofStates.id, initial.proofStateId));
    expect(states[0]?.status).toBe('FRONTIER');
  });

  it('frontier와 무관한 route_transform patch는 REJECTED여야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-service' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/payments/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/payments/{id}' },
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: serviceId,
      sourceFunctionId: null,
      gatewayKind: 'zuul',
      routeScopeKind: 'prefix',
      externalRoutePattern: '/api/orders/**',
      externalPathHint: '/api/orders/123',
      providerHint: 'orders-service',
      targetServiceHint: 'orders-service',
      methodConstraint: 'unknown',
      hostHint: 'orders-service',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: ['config:application.yml#orders-route-unrelated-patch'],
      intentHash: 'intent-route-patch-unrelated',
      anchorHash: 'anchor-route-patch-unrelated',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');
    expect(initial.frontierReason).toBe('ROUTE_FAMILY_DERIVATION_EMPTY');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'route_transform_patch',
      payload: {
        ownerServiceId: serviceId,
        gatewayKind: 'zuul',
        matchPath: '/api/payments/**',
        targetServiceHint: 'billing-service',
        prependPrefix: '/internal',
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('REJECTED');
    expect(patchResult.errors).toEqual(expect.arrayContaining([
      'matchPath must match the route intent externalRoutePattern',
      'targetServiceHint must align with route frontier hints',
    ]));
  });

  it('서로 다른 route patch 의미는 sourceHash 충돌 없이 별도 저장돼야 한다', async () => {
    const createRouteFrontier = async (intentId: string, proofStateId: string) => {
      await db.insert(interactionIntents).values({
        id: intentId,
        workspaceId,
        intentType: 'http_gateway_route',
        sourceServiceId: serviceId,
        sourceFunctionId: null,
        gatewayKind: 'zuul',
        routeScopeKind: 'prefix',
        externalRoutePattern: '/api/orders/**',
        providerHint: 'orders-service',
        targetServiceHint: 'orders-service',
        methodConstraint: 'unknown',
        hostHint: 'orders-service',
        configKeys: [],
        summaryRefs: [],
        evidenceIds: ['config:application.yml#route-hash-collision'],
        intentHash: `intent-route-hash-${intentId}`,
        anchorHash: `anchor-route-hash-${intentId}`,
      });
      await db.insert(proofStates).values({
        id: proofStateId,
        workspaceId,
        intentId,
        proofType: 'http_gateway_route',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        sourceFunctionId: null,
        providerServiceId: null,
        targetObjectType: null,
        targetObjectId: null,
        methodResolved: null,
        externalPathResolved: '/api/orders/123',
        internalPathResolved: '/api/orders/123',
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
        detail: {
          providerServiceId: null,
          internalPathResolved: '/api/orders/123',
          routeChain: [],
          endpointCandidateSet: { objectIds: [], count: 0, matchBasis: 'route_prefix' },
          compositionPaths: [],
          candidateEndpointPaths: [],
          filteredOutReasons: ['FAMILY_PREFIX_NOT_COMPOSED'],
          routeFamilyState: 'frontier',
          endpointHintId: null,
        },
      });
    };

    const proofStateIdA = generateId();
    const proofStateIdB = generateId();
    await createRouteFrontier(generateId(), proofStateIdA);
    await createRouteFrontier(generateId(), proofStateIdB);

    const patchA = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: proofStateIdA,
      patchType: 'route_transform_patch',
      payload: {
        ownerServiceId: serviceId,
        gatewayKind: 'zuul',
        matchPath: '/api/orders/**',
        targetServiceHint: 'orders-service',
        prependPrefix: '/internal',
      },
      sourceKind: 'agent',
    });
    const patchB = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: proofStateIdB,
      patchType: 'route_transform_patch',
      payload: {
        ownerServiceId: serviceId,
        gatewayKind: 'zuul',
        matchPath: '/api/orders/**',
        targetServiceHint: 'orders-service',
        prependPrefix: '/private',
      },
      sourceKind: 'agent',
    });

    expect(patchA.validationStatus).toBe('ACCEPTED');
    expect(patchB.validationStatus).toBe('ACCEPTED');

    const transforms = await db
      .select()
      .from(routeTransforms)
      .where(eq(routeTransforms.workspaceId, workspaceId));
    expect(transforms).toHaveLength(2);
    expect(new Set(transforms.map((transform) => transform.sourceHash)).size).toBe(2);
  });

  it('허용된 function summary patch는 frontier proof를 재평가해 consume candidate를 만들어야 한다', async () => {
    const queueId = await insertObject(db, {
      objectType: 'queue',
      name: 'email.queue',
      category: 'CHANNEL',
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'message_consume',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      intentHash: 'intent-message-consume',
      anchorHash: 'anchor-message-consume',
    });

    const initial = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(initial.status).toBe('FRONTIER');

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId: initial.proofStateId,
      patchType: 'function_summary_patch',
      payload: {
        functionId,
        serviceId,
        summaryKind: 'message',
        outboundMessage: {
          queue: 'email.queue',
          channelType: 'queue',
        },
        confidence: 0.97,
      },
      sourceKind: 'agent',
    });

    expect(patchResult.validationStatus).toBe('ACCEPTED');
    expect(patchResult.resolution?.status).toBe('CLOSED_ATOMIC');
    expect(patchResult.resolution?.targetObjectId).toBe(queueId);

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(
        and(
          eq(functionSummaries.workspaceId, workspaceId),
          eq(functionSummaries.functionId, functionId),
        ),
      );
    expect(summaries.some((summary) => summary.status === 'ACTIVE' && summary.summaryVersion === 1)).toBe(true);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('consume');
    expect(candidates[0]?.objectId).toBe(queueId);
  });

  it('proof resolution은 selective invalidation용 dependency record를 남겨야 한다', async () => {
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-api' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /internal/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/internal/orders/{id}' },
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: serviceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDERS_API',
      resolvedServiceId: providerServiceId,
      resolvedHost: 'orders-api.internal',
      sourceHash: 'alias-orders-dependency',
    });

    const summaryId = generateId();
    await db.insert(functionSummaries).values({
      id: summaryId,
      workspaceId,
      functionId,
      serviceId,
      summaryKind: 'http',
      outboundHttp: { method: 'GET', path: '/api/orders/123', hostAlias: 'ORDERS_API' },
      aliasHints: ['client.orders.url'],
      sourceHash: 'summary-orders-dependency',
      confidence: 0.9,
    });

    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: functionId,
      methodHint: 'GET',
      externalPathHint: '/api/orders/123',
      hostHint: 'ORDERS_API',
      configKeys: ['client.orders.url'],
      summaryRefs: [summaryId],
      intentHash: 'intent-dependency-record',
      anchorHash: 'anchor-dependency-record',
    });

    await db.insert(routeTransforms).values({
      id: generateId(),
      workspaceId,
      gatewayKind: 'zuul',
      ownerServiceId: serviceId,
      matchPath: '/api/orders/**',
      stripPrefixCount: 1,
      prependPrefix: '/internal',
      targetServiceHint: 'orders-api',
      sourceHash: 'route-orders-dependency',
    });

    const result = await resolveInteractionIntentProof(db, { workspaceId, intentId });
    expect(result.status).toBe('CLOSED_ATOMIC');
    expect(result.targetObjectId).toBe(endpointId);

    const dependencies = await db
      .select()
      .from(proofDependencies)
      .where(eq(proofDependencies.proofStateId, result.proofStateId));
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ dependencyKind: 'alias_binding', dependencyKey: 'client.orders.url' }),
      expect.objectContaining({ dependencyKind: 'function_summary_function', dependencyKey: functionId }),
      expect.objectContaining({ dependencyKind: 'route_transform_owner_service', dependencyKey: serviceId }),
      expect.objectContaining({ dependencyKind: 'route_transform_owner_service', dependencyKey: providerServiceId }),
    ]));
  });
});
