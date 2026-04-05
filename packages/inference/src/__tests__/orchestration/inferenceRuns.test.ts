import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  aliasBindings,
  createTestDb,
  functionSummaries,
  inferenceRunEvents,
  inferenceRuns,
  inferenceRunSources,
  interactionIntents,
  objects,
  proofDependencies,
  proofFrontiers,
  proofSteps,
  proofStates,
  proofPatches,
  relationCandidates,
  routeTransforms,
  smartProofLlmCalls,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import * as codeSignalEngineModule from '@/code/codeSignalEngine';
import * as frontierAgentModule from '@/agent/frontierAgent';
import * as intentProofCutoverReportModule from '@/orchestration/intentProofCutoverReport';
import * as intentProofEngineModule from '@/orchestration/intentProofEngine';
import {
  createInferenceRun,
  executeInferenceRun,
  retryInferenceRun,
} from '@/orchestration/inferenceRuns';

vi.mock('@/code/codeSignalEngine', async () => {
  const actual = await vi.importActual<typeof import('@/code/codeSignalEngine')>('@/code/codeSignalEngine');
  return {
    ...actual,
    extractCodeSignalsWithEngine: vi.fn(actual.extractCodeSignalsWithEngine),
  };
});

vi.mock('@/orchestration/intentProofEngine', async () => {
  const actual = await vi.importActual<typeof import('@/orchestration/intentProofEngine')>('@/orchestration/intentProofEngine');
  return {
    ...actual,
    resolveInteractionIntentProof: vi.fn(actual.resolveInteractionIntentProof),
  };
});

vi.mock('@/agent/frontierAgent', async () => {
  const actual = await vi.importActual<typeof import('@/agent/frontierAgent')>('@/agent/frontierAgent');
  return {
    ...actual,
    runFrontierAgentPass: vi.fn(actual.runFrontierAgentPass),
  };
});

vi.mock('@/orchestration/intentProofCutoverReport', async () => {
  const actual = await vi.importActual<typeof import('@/orchestration/intentProofCutoverReport')>('@/orchestration/intentProofCutoverReport');
  return {
    ...actual,
    buildIntentProofCutoverArtifact: vi.fn(async () => ({
      label: 'test-artifact',
      relations: [],
      failedChecks: [],
    })),
  };
});
const workspaceId = '00000000-0000-0000-0000-000000000020';

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
    category: input.category ?? (input.objectType === 'function' ? 'CODE' : 'COMPUTE'),
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

async function seedProofIntent(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });

  const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
  const sourceFunctionId = await insertObject(db, {
    objectType: 'function',
    name: 'GatewayClient.fetchOrder',
    parentId: consumerServiceId,
  });
  const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-service' });
  const endpointId = await insertObject(db, {
    objectType: 'api_endpoint',
    name: 'GET /internal/orders/{id}',
    parentId: providerServiceId,
    category: 'CHANNEL',
    metadata: { method: 'GET', path: '/internal/orders/{id}' },
  });

  const intentId = generateId();
  await db.insert(interactionIntents).values({
    id: intentId,
    workspaceId,
    intentType: 'http_call',
    sourceServiceId: consumerServiceId,
    sourceFunctionId,
    methodHint: 'GET',
    externalPathHint: '/api/orders/123',
    hostHint: 'ORDER_SERVICE',
    configKeys: ['client.orders.url'],
    summaryRefs: [],
    evidenceIds: [],
    status: 'NEW',
    intentHash: `intent-${intentId}`,
    anchorHash: `anchor-${intentId}`,
  });

  return { consumerServiceId, sourceFunctionId, providerServiceId, endpointId, intentId };
}

function createRetryRaceDb() {
  const run = {
    id: 'retry-run-1',
    workspaceId,
    status: 'FAILED',
    attemptCount: 0,
    maxAttempts: 2,
  };
  let selectCount = 0;
  let appendedEventCount = 0;

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  selectCount += 1;
                  if (selectCount === 1) return [run];
                  return [{ status: 'RUNNING' }];
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                async returning() {
                  return [];
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        async values() {
          appendedEventCount += 1;
          return [];
        },
      };
    },
  };

  return {
    db: db as unknown as TestDb,
    getAppendedEventCount: () => appendedEventCount,
  };
}

describe('inference orchestration runs', () => {
  let db: TestDb;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `archi-navi-infrun-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    db = await createTestDb();
    vi.clearAllMocks();
    const actualIntentProofEngine = await vi.importActual<typeof import('@/orchestration/intentProofEngine')>('@/orchestration/intentProofEngine');
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(
      actualIntentProofEngine.resolveInteractionIntentProof,
    );
  });

  afterEach(async () => {
    const client = (db as { $client?: { end?: () => Promise<void> } } | undefined)?.$client;
    if (client?.end) {
      await client.end();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('main run은 실제 proof resolution 결과를 summary에 반영해야 한다', async () => {
    const seeded = await seedProofIntent(db);
    writeFileSync(
      join(tempDir, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    orders:',
        '      path: /api/orders/**',
        '      serviceId: order-service',
      ].join('\n'),
      'utf-8',
    );

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementationOnce(async (dbClient, args) => {
      const rootProofStateId = generateId();
      const childProofStateId = generateId();
      await dbClient.insert(proofStates).values([
        {
          id: rootProofStateId,
          workspaceId,
          intentId: args.intentId,
          proofType: 'http_gateway_route',
          status: 'RESOLVING',
          consumerServiceId: seeded.consumerServiceId,
          sourceFunctionId: seeded.sourceFunctionId,
          providerServiceId: seeded.providerServiceId,
          methodResolved: null,
          externalPathResolved: '/api/orders',
          internalPathResolved: '/internal/orders/123',
          routeChain: ['zuul:/api/orders/**'],
          slotState: {
            routeFamilyState: 'derived_children',
            endpointCandidateSet: {
              objectIds: [seeded.endpointId],
              count: 1,
              matchBasis: 'route_prefix',
            },
            derivedChildProofStateIds: [childProofStateId],
          },
          ambiguityCount: 0,
          contradictionCount: 0,
          confidence: 0,
        },
        {
          id: childProofStateId,
          workspaceId,
          intentId: args.intentId,
          originIntentId: args.intentId,
          parentProofStateId: rootProofStateId,
          proofType: 'http_gateway_route',
          status: 'CLOSED_ATOMIC',
          consumerServiceId: seeded.consumerServiceId,
          sourceFunctionId: seeded.sourceFunctionId,
          providerServiceId: seeded.providerServiceId,
          targetObjectType: 'api_endpoint',
          targetObjectId: seeded.endpointId,
          methodResolved: 'GET',
          externalPathResolved: '/api/orders/123',
          internalPathResolved: '/internal/orders/123',
          routeChain: ['zuul:/api/orders/**'],
          slotState: {},
          ambiguityCount: 0,
          contradictionCount: 0,
          confidence: 0.97,
          closedReason: 'endpoint_matched',
        },
      ]);
      await dbClient.insert(relationCandidates).values({
        id: generateId(),
        workspaceId,
        relationType: 'call',
        subjectObjectId: seeded.sourceFunctionId,
        objectId: seeded.endpointId,
        confidence: 0.97,
        metadata: { proofStateId: childProofStateId },
        status: 'PENDING',
      });
      return {
        proofStateId: childProofStateId,
        status: 'CLOSED_ATOMIC',
        frontierReason: null,
        targetObjectId: seeded.endpointId,
        relationType: 'call',
      };
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(detail.sources[0]?.status).toBe('SUCCEEDED');
    expect(vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workspaceId }),
    );

    const stats = detail.run.stats as Record<string, unknown>;
    expect(stats['proofResolution']).toMatchObject({
      intentCount: 1,
      closedAtomicCount: 1,
      frontierCount: 0,
      rejectedCount: 0,
    });
    expect(stats['proofSummary']).toMatchObject({
      engine: 'intent_proof',
      intentCount: 1,
      gatewayRouteSeedCount: 1,
      derivedEndpointProofCount: 1,
      proofClosedAtomicCount: 1,
      proofFrontierCount: 0,
      routeFamilyFrontierCount: 0,
      proofRejectedCount: 0,
      projectedCandidateCount: 1,
      serviceTargetProjectionCount: 0,
      confidenceProfileName: 'intent-proof-default',
      confidenceProfileVersion: 'v1',
      functionSummaryExtractionBreakdown: {
        ast_primary: 0,
        mixed_signals: 0,
        legacy_edges_fallback: 0,
      },
    });
    expect((stats['summary'] as Record<string, unknown>)['relationCandidatesCreated']).toBe(1);

    const updatedIntents = await db
      .select({ id: interactionIntents.id, updatedRunId: interactionIntents.updatedRunId })
      .from(interactionIntents)
      .where(eq(interactionIntents.workspaceId, workspaceId));
    expect(updatedIntents.some((intent) => intent.updatedRunId === run.id)).toBe(true);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.metadata).toMatchObject({ proofStateId: expect.any(String) });
  });

  it('proof resolution이 실패하면 legacy count로 summary를 위장하지 않아야 한다', async () => {
    await seedProofIntent(db);
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockRejectedValueOnce(
      new Error('proof failed'),
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });
    const stats = detail.run.stats as Record<string, unknown>;

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(detail.run.warnings).toContain('intent proof resolution 실패: proof failed');
    expect(stats['config']).toMatchObject({ repoCount: 1 });
    expect(stats['proofResolution']).toMatchObject({
      intentCount: 0,
      closedAtomicCount: 0,
      frontierCount: 0,
      rejectedCount: 0,
    });
    expect(stats['proofSummary']).toMatchObject({
      engine: 'intent_proof',
      intentCount: 0,
      gatewayRouteSeedCount: 0,
      derivedEndpointProofCount: 0,
      proofClosedAtomicCount: 0,
      proofFrontierCount: 0,
      routeFamilyFrontierCount: 0,
      proofRejectedCount: 0,
      projectedCandidateCount: 0,
      serviceTargetProjectionCount: 0,
      confidenceProfileName: 'intent-proof-default',
      confidenceProfileVersion: 'v1',
      functionSummaryExtractionBreakdown: {
        ast_primary: 0,
        mixed_signals: 0,
        legacy_edges_fallback: 0,
      },
    });
  });

  it('config-only gateway route도 synthetic intent로 승격되어 proof candidate를 생성해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'config-gateway-proof' });
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles',
      parentId: articleServiceId,
      category: 'CHANNEL',
      metadata: { method: 'GET', path: '/articles' },
    });

    writeFileSync(
      join(tempDir, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    articles:',
        '      path: /api/articles/**',
        '      serviceId: article-service',
      ].join('\n'),
      'utf-8',
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });
    const stats = detail.run.stats as Record<string, unknown>;

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(stats['config']).toMatchObject({
      repoCount: 1,
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
      routeTransformCount: 1,
      interactionIntentCount: 1,
      gatewayRouteSeedCount: 1,
    });
    expect(stats['proofSummary']).toMatchObject({
      engine: 'intent_proof',
      intentCount: 1,
      gatewayRouteSeedCount: 1,
      derivedEndpointProofCount: 1,
      proofClosedAtomicCount: 1,
      projectedCandidateCount: 1,
    });

    const intents = await db.select().from(interactionIntents).where(eq(interactionIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.intentType).toBe('http_gateway_route');
    expect(intents[0]?.sourceServiceId).toBe(gatewayServiceId);
    expect(intents[0]?.hostHint).toBe('article-service');

    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intents[0]!.id)));
    expect(states).toHaveLength(2);
    const rootState = states.find((state) => state.parentProofStateId === null);
    const childState = states.find((state) => state.parentProofStateId !== null);
    expect(rootState?.proofType).toBe('http_gateway_route');
    expect(childState?.originIntentId).toBe(intents[0]?.id);
    expect(childState?.proofType).toBe('http_gateway_route');

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relationType).toBe('call');
    expect(candidates[0]?.metadata).toMatchObject({ source: 'intent_proof', proofStateId: childState?.id });
    expect(typeof candidates[0]?.objectId).toBe('string');
  });

  it('bounded route family는 여러 child proof를 생성하고 summary에 실제 child proof 수를 반영해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'config-gateway-proof-family' });
    await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    const collectionEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles',
      parentId: articleServiceId,
      category: 'CHANNEL',
      metadata: { method: 'GET', path: '/articles' },
    });
    const detailEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /articles/{id}',
      parentId: articleServiceId,
      category: 'CHANNEL',
      metadata: { method: 'GET', path: '/articles/{id}' },
    });
    writeFileSync(
      join(tempDir, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    articles:',
        '      path: /api/articles/**',
        '      serviceId: article-service',
      ].join('\n'),
      'utf-8',
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });
    const stats = detail.run.stats as Record<string, unknown>;

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(stats['proofSummary']).toMatchObject({
      engine: 'intent_proof',
      intentCount: 1,
      gatewayRouteSeedCount: 1,
      derivedEndpointProofCount: 2,
      proofClosedAtomicCount: 2,
      projectedCandidateCount: 2,
      serviceTargetProjectionCount: 0,
    });

    const states = await db.select().from(proofStates).where(eq(proofStates.workspaceId, workspaceId));
    const childStates = states.filter((state) => state.parentProofStateId !== null);
    expect(childStates).toHaveLength(2);
    expect(childStates.map((state) => state.targetObjectId).sort()).toEqual(
      [collectionEndpointId, detailEndpointId].sort(),
    );

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.objectId).sort()).toEqual(
      [collectionEndpointId, detailEndpointId].sort(),
    );
  });

  it('global prefix + stripped external hint 조합도 실제 sample처럼 root-relative endpoint family를 닫아야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'config-gateway-proof-sample-like' });
    await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const articleServiceId = await insertObject(db, { objectType: 'service', name: 'article-service' });
    const collectionEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /',
      parentId: articleServiceId,
      category: 'CHANNEL',
      metadata: { method: 'GET', path: '/' },
    });
    const detailEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /{id}',
      parentId: articleServiceId,
      category: 'CHANNEL',
      metadata: { method: 'GET', path: '/{id}' },
    });
    const authorEndpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /author/{authorId}',
      parentId: articleServiceId,
      category: 'CHANNEL',
      metadata: { method: 'GET', path: '/author/{authorId}' },
    });

    writeFileSync(
      join(tempDir, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  prefix: /api',
        '  routes:',
        '    articles:',
        '      path: /articles/**',
        '      serviceId: article-service',
      ].join('\n'),
      'utf-8',
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });
    const stats = detail.run.stats as Record<string, unknown>;

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(stats['proofSummary']).toMatchObject({
      engine: 'intent_proof',
      intentCount: 1,
      gatewayRouteSeedCount: 1,
      derivedEndpointProofCount: 3,
      proofClosedAtomicCount: 3,
      projectedCandidateCount: 3,
      serviceTargetProjectionCount: 0,
    });

    const states = await db.select().from(proofStates).where(eq(proofStates.workspaceId, workspaceId));
    const childStates = states.filter((state) => state.parentProofStateId !== null);
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

  it('incremental run은 changed dependency와 연결된 intent만 selective re-resolution 해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'incremental-selective' });
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const sourceFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: consumerServiceId,
    });
    const otherFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchPayment',
      parentId: consumerServiceId,
    });

    const impactedIntentId = generateId();
    const untouchedIntentId = generateId();
    await db.insert(interactionIntents).values([
      {
        id: impactedIntentId,
        workspaceId,
        intentType: 'http_call',
        sourceServiceId: consumerServiceId,
        sourceFunctionId,
        hostHint: 'ORDERS_API',
        configKeys: ['client.orders.url'],
        intentHash: 'intent-impacted',
        anchorHash: 'anchor-impacted',
      },
      {
        id: untouchedIntentId,
        workspaceId,
        intentType: 'http_call',
        sourceServiceId: consumerServiceId,
        sourceFunctionId: otherFunctionId,
        hostHint: 'PAYMENTS_API',
        configKeys: ['client.payments.url'],
        intentHash: 'intent-untouched',
        anchorHash: 'anchor-untouched',
      },
    ]);

    const impactedProofStateId = generateId();
    const untouchedProofStateId = generateId();
    await db.insert(proofStates).values([
      {
        id: impactedProofStateId,
        workspaceId,
        intentId: impactedIntentId,
        proofType: 'http_call',
        status: 'NEW',
        consumerServiceId,
        sourceFunctionId,
      },
      {
        id: untouchedProofStateId,
        workspaceId,
        intentId: untouchedIntentId,
        proofType: 'http_call',
        status: 'NEW',
        consumerServiceId,
        sourceFunctionId: otherFunctionId,
      },
    ]);

    await db.insert(proofDependencies).values([
      {
        id: generateId(),
        workspaceId,
        proofStateId: impactedProofStateId,
        dependencyKind: 'alias_binding',
        dependencyKey: 'client.orders.url',
      },
      {
        id: generateId(),
        workspaceId,
        proofStateId: untouchedProofStateId,
        dependencyKind: 'alias_binding',
        dependencyKey: 'client.payments.url',
      },
    ]);

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      incremental: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      createdRunId: run.id,
      updatedRunId: run.id,
      bindingKind: 'base_url',
      aliasKey: 'client.orders.url',
      aliasValue: 'http://orders-api.internal',
      resolvedHost: 'orders-api.internal',
      sourceHash: 'binding-updated-by-run',
    });

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (_dbClient, args) => ({
      proofStateId: args.intentId === impactedIntentId ? impactedProofStateId : untouchedProofStateId,
      status: 'FRONTIER',
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    }));

    await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
    });

    expect(vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workspaceId, intentId: impactedIntentId }),
    );
  });

  it('code 추출이 실패하면 run/source를 FAILED로 기록해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });
    writeFileSync(join(tempDir, 'index.ts'), 'export const orderService = true;\n', 'utf-8');

    vi.mocked(codeSignalEngineModule.extractCodeSignalsWithEngine).mockRejectedValueOnce(
      new Error('parser failed'),
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['code'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.run.status).toBe('FAILED');
    expect(detail.run.errorMessage).toBe('parser failed');
    expect(detail.sources[0]?.status).toBe('FAILED');
    expect(detail.events.some((event) => event.eventType === 'RUN_COMPLETED')).toBe(true);

    const runRows = await db
      .select()
      .from(inferenceRuns)
      .where(and(eq(inferenceRuns.workspaceId, workspaceId), eq(inferenceRuns.id, run.id)));
    expect(runRows[0]?.status).toBe('FAILED');

    const sourceRows = await db
      .select()
      .from(inferenceRunSources)
      .where(and(eq(inferenceRunSources.workspaceId, workspaceId), eq(inferenceRunSources.runId, run.id)));
    expect(sourceRows[0]?.status).toBe('FAILED');

    const eventRows = await db
      .select()
      .from(inferenceRunEvents)
      .where(and(eq(inferenceRunEvents.workspaceId, workspaceId), eq(inferenceRunEvents.runId, run.id)));
    expect(eventRows.length).toBeGreaterThan(0);
  });

  it('retry race condition이면 이벤트를 추가하지 않고 현재 상태를 반환해야 한다', async () => {
    const { db: raceDb, getAppendedEventCount } = createRetryRaceDb();

    const result = await retryInferenceRun(raceDb, {
      workspaceId,
      runId: 'retry-run-1',
    });

    expect(result).toEqual({
      retried: false,
      status: 'RUNNING',
      reason: '상태가 변경되어 재시도 예약에 실패했습니다.',
    });
    expect(getAppendedEventCount()).toBe(0);
  });

  it('agent patch가 활성화되면 frontier proof에 대해 patch pass를 수행하고 최종 상태를 summary에 반영해야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'CONFIG_BINDING_MISSING',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'CONFIG_BINDING_MISSING',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      detail: {
        configKeys: ['client.orders.url'],
        hostHints: ['ORDER_SERVICE'],
      },
    });

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'CONFIG_BINDING_MISSING',
      targetObjectId: null,
      relationType: null,
    });
    vi.mocked(frontierAgentModule.runFrontierAgentPass).mockResolvedValueOnce({
      proofStateId: 'proof-frontier-1',
      frontierReason: 'CONFIG_BINDING_MISSING',
      attempted: true,
      proposal: {
        proofStateId: 'proof-frontier-1',
        frontierReason: 'CONFIG_BINDING_MISSING',
        frontierClass: 'ALIAS',
        patchType: 'alias_binding',
        payload: {
          aliasKey: 'client.orders.url',
          resolvedServiceId: 'provider-1',
        },
        rationale: 'single service match',
      },
      patchId: 'patch-1',
      validationStatus: 'ACCEPTED',
      errors: [],
      resolution: {
        proofStateId: 'proof-frontier-1',
        status: 'CLOSED_ATOMIC',
        frontierReason: null,
        targetObjectId: 'endpoint-1',
        relationType: 'call',
      },
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      enableAgentPatches: true,
      maxAgentFrontiers: 2,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    const stats = detail.run.stats as Record<string, unknown>;
    expect(stats['requestedAgentPatches']).toMatchObject({
      enabled: true,
      maxFrontiers: 2,
    });
    expect(stats['frontierAgent']).toMatchObject({
      enabled: true,
      attemptedFrontierCount: 1,
      proposalCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      noProposalCount: 0,
      skippedCount: 0,
    });
    expect(detail.events.some((event) => event.eventType === 'FRONTIER_AGENT_PATCH')).toBe(true);
  });

  it('agent disabled 상태의 frontier도 skip event로 남겨야 한다', async () => {
    await seedProofIntent(db);
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId: 'proof-frontier-disabled',
      status: 'FRONTIER',
      frontierReason: 'CONFIG_BINDING_MISSING',
      targetObjectId: null,
      relationType: null,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      enableAgentPatches: false,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(vi.mocked(frontierAgentModule.runFrontierAgentPass)).not.toHaveBeenCalled();
    expect(detail.events.some((event) =>
      event.eventType === 'FRONTIER_AGENT_PATCH'
      && (event.payload as Record<string, unknown>)['outcome'] === 'disabled')).toBe(true);
  });

  it('agent proposal이 없으면 no_proposal event를 남겨야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'ENDPOINT_MATCH_AMBIGUOUS',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      detail: {},
    });

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    });
    vi.mocked(frontierAgentModule.runFrontierAgentPass).mockResolvedValueOnce({
      proofStateId: 'proof-frontier-no-proposal',
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      attempted: false,
      proposal: null,
      patchId: null,
      validationStatus: null,
      errors: [],
      resolution: null,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      enableAgentPatches: true,
      maxAgentFrontiers: 2,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.events.some((event) =>
      event.eventType === 'FRONTIER_AGENT_PATCH'
      && (event.payload as Record<string, unknown>)['outcome'] === 'no_proposal')).toBe(true);
  });

  it('frontier limit 초과도 skip event로 남겨야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const secondIntentId = generateId();
    const firstProofStateId = generateId();
    const secondProofStateId = generateId();
    await db.insert(interactionIntents).values({
      id: secondIntentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: seeded.consumerServiceId,
      sourceFunctionId: null,
      methodHint: 'GET',
      externalPathHint: '/api/second',
      hostHint: 'SECOND_API',
      intentHash: 'intent-frontier-limit-second',
      anchorHash: 'anchor-frontier-limit-second',
    });
    await db.insert(proofStates).values([
      {
        id: firstProofStateId,
        workspaceId,
        intentId: seeded.intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: seeded.consumerServiceId,
        sourceFunctionId: seeded.sourceFunctionId,
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'CONFIG_BINDING_MISSING',
      },
      {
        id: secondProofStateId,
        workspaceId,
        intentId: secondIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: seeded.consumerServiceId,
        sourceFunctionId: null,
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
    ]);
    await db.insert(proofFrontiers).values([
      {
        proofStateId: firstProofStateId,
        workspaceId,
        frontierReason: 'CONFIG_BINDING_MISSING',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {
          configKeys: ['client.orders.url'],
          hostHints: ['ORDER_SERVICE'],
        },
      },
      {
        proofStateId: secondProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {
          hostHints: ['SECOND_API'],
        },
      },
    ]);

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)
      .mockResolvedValueOnce({
        proofStateId: firstProofStateId,
        status: 'FRONTIER',
        frontierReason: 'CONFIG_BINDING_MISSING',
        targetObjectId: null,
        relationType: null,
      })
      .mockResolvedValueOnce({
        proofStateId: secondProofStateId,
        status: 'FRONTIER',
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        targetObjectId: null,
        relationType: null,
      });
    vi.mocked(frontierAgentModule.runFrontierAgentPass).mockResolvedValueOnce({
      proofStateId: 'proof-frontier-limit-1',
      frontierReason: 'CONFIG_BINDING_MISSING',
      attempted: false,
      proposal: null,
      patchId: null,
      validationStatus: null,
      errors: [],
      resolution: null,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      enableAgentPatches: true,
      maxAgentFrontiers: 1,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.events.some((event) =>
      event.eventType === 'FRONTIER_AGENT_PATCH'
      && (event.payload as Record<string, unknown>)['outcome'] === 'limit_exceeded')).toBe(true);
  });

  it('smartProof=true 이고 frontier가 없으면 smart proof pass no_frontiers 이벤트를 남겨야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    const stats = detail.run.stats as Record<string, unknown>;
    expect(stats['requestedSmartProof']).toMatchObject({
      enabled: true,
      categories: {
        frontierResolution: true,
      },
    });
    expect(stats['smartProof']).toMatchObject({
      enabled: true,
      attempted: true,
      attemptedFrontierCount: 0,
      skippedReason: 'NO_FRONTIERS',
      budget: {
        callsUsed: 0,
        tokensUsed: 0,
      },
    });
    expect(detail.events.some((event) =>
      event.eventType === 'SMART_PROOF_PASS'
      && (event.payload as Record<string, unknown>)['outcome'] === 'no_frontiers')).toBe(true);
  });

  it('smartProof=true 이고 frontier가 남아 있으면 scaffolding not_implemented 이벤트를 남겨야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      detail: {
        configKeys: ['client.orders.url'],
        hostHints: ['ORDER_SERVICE'],
      },
    });

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      enableAgentPatches: false,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    const stats = detail.run.stats as Record<string, unknown>;
    expect(stats['smartProof']).toMatchObject({
      enabled: true,
      attempted: true,
      attemptedFrontierCount: 1,
      skippedReason: 'NO_GENERATOR_CONFIGURED',
    });
    expect((stats['proofSummary'] as Record<string, unknown>)['smartMode']).toMatchObject({
      enabled: true,
      llmCallCount: 0,
    });
    expect(detail.events.some((event) =>
      event.eventType === 'SMART_PROOF_PASS'
      && (event.payload as Record<string, unknown>)['outcome'] === 'no_generator')).toBe(true);
  });

  it('smartProof=false 일 때 smart 실행이 동작하지 않아 legacy 동작과 동일해야 한다', async () => {
    await seedProofIntent(db);
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId: 'proof-smart-off-atomic',
      status: 'CLOSED_ATOMIC',
      frontierReason: null,
      targetObjectId: 'endpoint-1',
      relationType: null,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: false,
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    const stats = detail.run.stats as Record<string, unknown>;
    expect(stats['smartProof']).toMatchObject({
      enabled: false,
      attempted: false,
      skippedReason: 'DISABLED',
    });
    const smartMode = (stats['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode['enabled']).toBe(false);
    expect(smartMode['llmCallCount']).toBe(0);
    const smartCalls = await db.select().from(smartProofLlmCalls).where(eq(smartProofLlmCalls.workspaceId, workspaceId));
    expect(smartCalls).toHaveLength(0);
    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.sourceKind, 'smart_agent')));
    expect(smartPatches).toHaveLength(0);
    expect(detail.events.some((event) => event.eventType === 'SMART_PROOF_PASS' && (event.payload as Record<string, unknown>)['outcome'] === 'disabled')).toBe(true);
  });

  it('ambiguityResolution=true 이면 PROVIDER_SERVICE_AMBIGUOUS frontier에 smart ambiguity resolver를 적용해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });

    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const sourceFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: consumerServiceId,
    });
    const providerAServiceId = await insertObject(db, { objectType: 'service', name: 'order-api-a' });
    const providerBServiceId = await insertObject(db, { objectType: 'service', name: 'order-api-b' });
    const intentId = generateId();
    const proofStateId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId,
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDER_API',
      configKeys: [],
      summaryRefs: [],
      evidenceIds: [],
      status: 'NEW',
      intentHash: `intent-${intentId}`,
      anchorHash: `anchor-${intentId}`,
    });
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      sourceFunctionId,
      methodResolved: 'GET',
      externalPathResolved: '/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 2,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'PROVIDER_SERVICE_AMBIGUOUS',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      frontierClass: 'ALIAS',
      retryStrategy: 'manual_review',
      detail: {
        candidateProviderIds: [providerAServiceId, providerBServiceId],
        hostHints: ['ORDER_API'],
      },
    });

    let resolutionCallCount = 0;
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (dbClient, input) => {
      if (input.intentId !== intentId) {
        return {
          proofStateId: generateId(),
          status: 'CLOSED_ATOMIC',
          frontierReason: null,
          targetObjectId: null,
          relationType: null,
        };
      }

      resolutionCallCount += 1;
      if (resolutionCallCount === 1) {
        return {
          proofStateId,
          status: 'FRONTIER',
          frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
          targetObjectId: null,
          relationType: null,
        };
      }

      await dbClient
        .update(proofStates)
        .set({
          status: 'CLOSED_ATOMIC',
          frontierCode: 'CLOSED_ATOMIC',
          providerServiceId: providerAServiceId,
          targetObjectType: 'service',
          targetObjectId: providerAServiceId,
        })
        .where(eq(proofStates.id, proofStateId));
      await dbClient
        .delete(proofFrontiers)
        .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)));

      return {
        proofStateId,
        status: 'CLOSED_ATOMIC',
        frontierReason: null,
        targetObjectId: providerAServiceId,
        relationType: 'call',
      };
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: {
        enabled: true,
        categories: {
          preResolutionEnhancement: false,
          frontierResolution: false,
          ambiguityResolution: true,
          crossProofCorrelation: false,
          contradictionDetection: false,
        },
        budget: {
          maxLlmCallsPerRun: 5,
          maxLlmCallsPerIntent: 2,
          maxInputTokensPerCall: 200,
          maxTotalTokensPerRun: 2_000,
        },
        thresholds: {
          autoAcceptConfidence: 0.8,
          reviewConfidence: 0.5,
          skipConfidence: 0.3,
        },
      },
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 22,
        completionTokens: 6,
        object: {
          patchType: 'provider_service_selection',
          resolved: true,
          selectedServiceId: providerAServiceId,
          selectedServiceName: 'order-api-a',
          confidence: 0.91,
          reasoning: 'host hint aligns more strongly with order-api-a',
          ranking: null,
        },
      }),
    });

    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(
        and(
          eq(proofPatches.workspaceId, workspaceId),
          eq(proofPatches.proofStateId, proofStateId),
          eq(proofPatches.sourceKind, 'smart_agent'),
        ),
    );
    expect(smartPatches[0]?.patchType).toBe('provider_service_selection');
    expect(smartPatches[0]?.validationStatus).toBe('ACCEPTED');
    expect(resolutionCallCount).toBeGreaterThanOrEqual(1);

    const smartMode = ((detail.run.stats as Record<string, unknown>)['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode).toMatchObject({
      enabled: true,
      autoAcceptedCount: 1,
      frontierResolvedByLlm: 1,
      llmCallCount: 1,
    });
  });

  it('ambiguityResolution=false 이면 PROVIDER_SERVICE_AMBIGUOUS frontier를 smart가 건드리지 않아야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 2,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'PROVIDER_SERVICE_AMBIGUOUS',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      frontierClass: 'ALIAS',
      retryStrategy: 'manual_review',
      detail: {
        candidateProviderIds: ['svc-a', 'svc-b'],
        hostHints: ['ORDER_API'],
      },
    });
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: {
        enabled: true,
        categories: {
          preResolutionEnhancement: false,
          frontierResolution: false,
          ambiguityResolution: false,
          crossProofCorrelation: false,
          contradictionDetection: false,
        },
        budget: {
          maxLlmCallsPerRun: 5,
          maxLlmCallsPerIntent: 2,
          maxInputTokensPerCall: 200,
          maxTotalTokensPerRun: 2_000,
        },
        thresholds: {
          autoAcceptConfidence: 0.8,
          reviewConfidence: 0.5,
          skipConfidence: 0.3,
        },
      },
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 22,
        completionTokens: 6,
        object: {
          patchType: 'provider_service_selection',
          resolved: true,
          selectedServiceId: 'svc-a',
          selectedServiceName: 'svc-a',
          confidence: 0.91,
          reasoning: 'should not be called',
          ranking: null,
        },
      }),
    });

    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.sourceKind, 'smart_agent')));
    expect(smartPatches).toHaveLength(0);
    expect(((detail.run.stats as Record<string, unknown>)['proofSummary'] as Record<string, unknown>)['smartMode']).toMatchObject({
      enabled: true,
      llmCallCount: 0,
    });
  });

  it('preResolutionEnhancement는 조건 충족 summary만 선별 실행하고 accepted patch 후 summaryVersion을 증가시켜야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });

    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-service' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /api/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/api/orders/{id}' },
    });
    const sourceFilePath = join(tempDir, 'gateway-client.ts');
    writeFileSync(
      sourceFilePath,
      [
        'export async function fetchOrder() {',
        "  return fetch('/api/orders/123');",
        '}',
      ].join('\n'),
      'utf-8',
    );
    const sourceFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: consumerServiceId,
      metadata: { sourceFilePath, startLine: 1, endLine: 3 },
    });

    const intentId = generateId();
    const proofStateId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId,
      sourceFilePath,
      methodHint: 'GET',
      externalPathHint: '/api/orders/123',
      hostHint: 'ORDER_SERVICE',
      configKeys: ['client.orders.url'],
      summaryRefs: [],
      evidenceIds: [],
      status: 'NEW',
      intentHash: `intent-${intentId}`,
      anchorHash: `anchor-${intentId}`,
    });
    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: consumerServiceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDER_SERVICE',
      resolvedServiceId: providerServiceId,
      sourceHash: 'alias-orders-summary-enhancement',
    });

    await db.insert(functionSummaries).values({
      id: generateId(),
      workspaceId,
      functionId: sourceFunctionId,
      serviceId: consumerServiceId,
      summaryVersion: 1,
      summaryKind: 'http',
      outboundHttp: null,
      outboundDb: null,
      outboundMessage: null,
      callChainHints: [],
      aliasHints: [],
      signalSources: ['legacy_edges'],
      provenanceEvidenceIds: [],
      extractionStrategy: 'legacy_edges_fallback',
      unresolvedReasons: ['HOST_ALIAS_UNRESOLVED'],
      summaryCompleteness: 0.2,
      flags: { truncated: true },
      confidence: 0.35,
      sourceHash: 'summary-fetch-order-v1',
      status: 'ACTIVE',
    });

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      sourceFunctionId,
      providerServiceId: null,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      detail: {
        configKeys: ['client.orders.url'],
        hostHints: ['ORDER_SERVICE'],
      },
    });
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    });

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: {
        enabled: true,
        categories: {
          preResolutionEnhancement: true,
          frontierResolution: true,
          ambiguityResolution: false,
          crossProofCorrelation: false,
          contradictionDetection: false,
        },
        budget: {
          maxLlmCallsPerRun: 5,
          maxLlmCallsPerIntent: 2,
          maxInputTokensPerCall: 400,
          maxTotalTokensPerRun: 4_000,
        },
        thresholds: {
          autoAcceptConfidence: 0.8,
          reviewConfidence: 0.5,
          skipConfidence: 0.3,
        },
      },
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 30,
        completionTokens: 8,
        object: {
          patchType: 'function_summary_patch',
          resolved: true,
          functionId: sourceFunctionId,
          confidence: 0.93,
          reasoning: 'snippet and hints indicate outbound http call',
          summaryKind: 'http',
          outboundHttp: {
            method: 'GET',
            path: '/api/orders/{id}',
            hostAlias: 'ORDER_SERVICE',
          },
          signalSources: ['smart_summary_enhancer'],
          summaryCompleteness: 0.92,
          flags: { truncated: false },
        },
      }),
    });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, sourceFunctionId)));
    const activeSummary = summaries.find((summary) => summary.status === 'ACTIVE');
    const supersededSummary = summaries.find((summary) => summary.status === 'SUPERSEDED');
    expect(summaries).toHaveLength(2);
    expect(activeSummary?.summaryVersion).toBe(2);
    expect(activeSummary?.summaryCompleteness).toBe(0.92);
    expect(supersededSummary?.summaryVersion).toBe(1);

    const remainingFrontiers = await db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)));
    expect(remainingFrontiers).toHaveLength(0);
    const [updatedState] = await db.select().from(proofStates).where(eq(proofStates.id, proofStateId));
    expect(updatedState?.status).not.toBe('FRONTIER');
    const summaryPatches = await db
      .select()
      .from(proofPatches)
      .where(
        and(
          eq(proofPatches.workspaceId, workspaceId),
          eq(proofPatches.proofStateId, proofStateId),
          eq(proofPatches.patchType, 'function_summary_patch'),
          eq(proofPatches.validationStatus, 'ACCEPTED'),
        ),
      );
    expect(summaryPatches).toHaveLength(1);

    const stats = detail.run.stats as Record<string, unknown>;
    expect(stats['smartProof']).toMatchObject({
      attemptedSummaryCandidateCount: 1,
      acceptedSummaryEnhancementCount: 1,
    });
    const smartMode = (stats['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode).toMatchObject({
      llmCallCount: 1,
      summaryEnhancedByLlm: 1,
      frontierResolvedByLlm: 0,
      autoAcceptedCount: 1,
    });
    expect(detail.events.some((event) =>
      event.eventType === 'SMART_PROOF_PASS'
      && (event.payload as Record<string, unknown>)['attemptedSummaryCandidateCount'] === 1
      && (event.payload as Record<string, unknown>)['acceptedSummaryEnhancementCount'] === 1)).toBe(true);
  });

  it('smartProof가 ACCEPTED 결정을 내리면 patch를 적용하고 proof 상태를 재평가해야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });

    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      detail: {
        configKeys: ['client.orders.url'],
        hostHints: ['ORDER_SERVICE'],
      },
    });

    let resolutionCallCount = 0;
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (dbClient, input) => {
      if (input.intentId !== seeded.intentId) {
        return {
          proofStateId: generateId(),
          status: 'CLOSED_ATOMIC',
          frontierReason: null,
          targetObjectId: null,
          relationType: null,
        };
      }

      resolutionCallCount += 1;
      if (resolutionCallCount === 1) {
        return {
          proofStateId,
          status: 'FRONTIER',
          frontierReason: 'HOST_ALIAS_UNRESOLVED',
          targetObjectId: null,
          relationType: null,
        };
      }

      await dbClient
        .update(proofStates)
        .set({
          status: 'CLOSED_ATOMIC',
          frontierCode: 'CLOSED_ATOMIC',
          targetObjectType: 'service',
          targetObjectId: seeded.providerServiceId,
        })
        .where(eq(proofStates.id, proofStateId));
      await dbClient
        .delete(proofFrontiers)
        .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)));

      return {
        proofStateId,
        status: 'CLOSED_ATOMIC',
        frontierReason: null,
        targetObjectId: seeded.providerServiceId,
        relationType: 'call',
      };
    });

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 20,
        completionTokens: 5,
        object: {
          patchType: 'alias_binding',
          resolved: true,
          selectedServiceId: seeded.providerServiceId,
          selectedServiceName: 'order-service',
          confidence: 0.92,
          reasoning: 'resolved from host alias',
          aliasBinding: {
            aliasKey: 'client.orders.url',
            aliasValue: 'ORDER_SERVICE',
            bindingKind: 'property_alias',
          },
        },
      }),
    });

    const summary = detail.run.stats as Record<string, unknown>;
    const smartMode = (summary['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode).toMatchObject({
      enabled: true,
      autoAcceptedCount: 1,
      frontierResolvedByLlm: 1,
      llmCallCount: 1,
    });
    const smartCalls = await db
      .select()
      .from(smartProofLlmCalls)
      .where(and(eq(smartProofLlmCalls.workspaceId, workspaceId), eq(smartProofLlmCalls.runId, run.id)));
    expect(smartCalls).toHaveLength(1);
    expect(smartCalls[0]?.accepted).toBe(true);

    const patches = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.sourceKind, 'smart_agent')));
    expect(patches[0]?.validationStatus).toBe('ACCEPTED');
    const bindings = await db
      .select()
      .from(aliasBindings)
      .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.ownerServiceId, seeded.consumerServiceId)));
    expect(bindings.some((binding) =>
      binding.aliasKey === 'client.orders.url'
      && binding.aliasValue === 'ORDER_SERVICE'
      && binding.resolvedServiceId === seeded.providerServiceId)).toBe(true);
    const steps = await db
      .select()
      .from(proofSteps)
      .where(eq(proofSteps.proofStateId, proofStateId));
    expect(steps.some((step) => step.stepType === 'apply_patch' && step.status === 'APPLIED')).toBe(true);
  });

  it('smart route_transform patch가 ACCEPTED 되면 route frontier를 갱신하고 transform을 저장해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });

    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'orders-service' });
    const intentId = generateId();
    const proofStateId = generateId();

    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
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
      evidenceIds: [],
      status: 'NEW',
      intentHash: `intent-${intentId}`,
      anchorHash: `anchor-${intentId}`,
    });

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_gateway_route',
      status: 'FRONTIER',
      consumerServiceId: gatewayServiceId,
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
      confidence: 0.2,
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

    let resolutionCallCount = 0;
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (dbClient, input) => {
      if (input.intentId !== intentId) {
        return {
          proofStateId: generateId(),
          status: 'CLOSED_ATOMIC',
          frontierReason: null,
          targetObjectId: null,
          relationType: null,
        };
      }

      resolutionCallCount += 1;
      if (resolutionCallCount === 1) {
        return {
          proofStateId,
          status: 'FRONTIER',
          frontierReason: 'ROUTE_FAMILY_DERIVATION_EMPTY',
          targetObjectId: null,
          relationType: null,
        };
      }

      await dbClient
        .update(proofStates)
        .set({
          status: 'CLOSED_ATOMIC',
          frontierCode: 'CLOSED_ATOMIC',
          targetObjectType: 'service',
          targetObjectId: providerServiceId,
        })
        .where(eq(proofStates.id, proofStateId));
      await dbClient
        .delete(proofFrontiers)
        .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)));

      return {
        proofStateId,
        status: 'CLOSED_ATOMIC',
        frontierReason: null,
        targetObjectId: providerServiceId,
        relationType: 'call',
      };
    });

    writeFileSync(join(tempDir, 'application.yml'), 'zuul:\n  routes: {}\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 18,
        completionTokens: 7,
        object: {
          patchType: 'route_transform_patch',
          resolved: true,
          confidence: 0.91,
          reasoning: 'route should forward to orders-service',
          routeTransform: {
            gatewayKind: 'zuul',
            matchPath: '/api/orders/**',
            targetServiceHint: 'orders-service',
            targetHostAlias: 'orders-service',
            priority: 120,
          },
        },
      }),
    });

    const proofSummary = detail.run.stats as Record<string, unknown>;
    expect((proofSummary['proofResolution'] as Record<string, number>)['frontierCount']).toBe(1);

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, proofStateId));
    expect(state?.status).toBe('FRONTIER');

    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.sourceKind, 'smart_agent')));
    expect(smartPatches[0]?.patchType).toBe('route_transform_patch');
    expect(smartPatches[0]?.validationStatus).toBe('ACCEPTED');

    const transforms = await db
      .select()
      .from(routeTransforms)
      .where(and(eq(routeTransforms.workspaceId, workspaceId), eq(routeTransforms.ownerServiceId, gatewayServiceId)));
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toMatchObject({
      gatewayKind: 'zuul',
      matchPath: '/api/orders/**',
      targetServiceHint: 'orders-service',
    });
    const steps = await db
      .select()
      .from(proofSteps)
      .where(eq(proofSteps.proofStateId, proofStateId));
    expect(steps.some((step) => step.stepType === 'apply_patch' && step.status === 'APPLIED')).toBe(true);

    const smartMode = ((detail.run.stats as Record<string, unknown>)['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode).toMatchObject({
      enabled: true,
      autoAcceptedCount: 1,
      frontierResolvedByLlm: 1,
      llmCallCount: 1,
    });
  });

  it('smart endpoint_disambiguation patch가 ACCEPTED 되면 ambiguous endpoint frontier를 닫아야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const sourceFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: consumerServiceId,
    });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'order-service' });
    const endpointId = await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /api/orders/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/api/orders/{id}' },
    });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /api/orders/{orderId}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/api/orders/{orderId}' },
    });
    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: consumerServiceId,
      aliasKey: 'client.orders.url',
      aliasValue: 'ORDER_SERVICE',
      resolvedServiceId: providerServiceId,
      sourceHash: 'source-hash-orders',
    });
    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId,
      methodHint: 'GET',
      externalPathHint: '/api/orders/123',
      hostHint: 'ORDER_SERVICE',
      configKeys: ['client.orders.url'],
      summaryRefs: [],
      evidenceIds: [],
      status: 'NEW',
      intentHash: `intent-${intentId}`,
      anchorHash: `anchor-${intentId}`,
    });
    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      sourceFunctionId,
      providerServiceId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 2,
      contradictionCount: 0,
      confidence: 0.42,
      frontierCode: 'ENDPOINT_MATCH_AMBIGUOUS',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      detail: {
        candidateObjectIds: [endpointId],
      },
    });
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    });

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 16,
        completionTokens: 6,
        object: {
          patchType: 'endpoint_disambiguation',
          resolved: true,
          confidence: 0.91,
          reasoning: 'single best endpoint from candidate set',
          endpointSelection: {
            endpointId,
            method: 'GET',
            path: '/api/orders/{id}',
          },
        },
      }),
    });

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, proofStateId));
    expect(state?.status).toBe('CLOSED_ATOMIC');

    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(
        and(
          eq(proofPatches.workspaceId, workspaceId),
          eq(proofPatches.sourceKind, 'smart_agent'),
          eq(proofPatches.proofStateId, state?.id),
        ),
      );
    const frontiers = await db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, state?.id)));
    expect(smartPatches[0]?.patchType).toBe('endpoint_disambiguation');
    expect(smartPatches[0]?.validationStatus).toBe('ACCEPTED');
    expect(frontiers).toHaveLength(0);
    const steps = await db
      .select()
      .from(proofSteps)
      .where(and(eq(proofSteps.proofStateId, state?.id), eq(proofSteps.stepType, 'apply_patch')));
    expect(steps.length).toBeGreaterThan(0);

    const smartMode = ((detail.run.stats as Record<string, unknown>)['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode).toMatchObject({
      enabled: true,
      autoAcceptedCount: 1,
      frontierResolvedByLlm: 1,
      llmCallCount: 1,
    });
  });

  it('smart method_path_hint patch가 ACCEPTED 되면 METHOD_UNKNOWN frontier를 닫아야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });
    const consumerServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const sourceFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'CatalogClient.getItem',
      parentId: consumerServiceId,
    });
    const providerServiceId = await insertObject(db, { objectType: 'service', name: 'catalog-service' });
    await insertObject(db, {
      objectType: 'api_endpoint',
      name: 'GET /catalog/items/{id}',
      parentId: providerServiceId,
      metadata: { method: 'GET', path: '/catalog/items/{id}' },
    });
    await db.insert(aliasBindings).values({
      id: generateId(),
      workspaceId,
      bindingKind: 'property_alias',
      ownerServiceId: consumerServiceId,
      aliasKey: 'client.catalog.url',
      aliasValue: 'CATALOG_API',
      resolvedServiceId: providerServiceId,
      sourceHash: 'source-hash-catalog',
    });
    const intentId = generateId();
    await db.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: consumerServiceId,
      sourceFunctionId,
      methodHint: null,
      externalPathHint: '/catalog/items/123',
      hostHint: 'CATALOG_API',
      configKeys: ['client.catalog.url'],
      summaryRefs: [],
      evidenceIds: [],
      status: 'NEW',
      intentHash: `intent-${intentId}`,
      anchorHash: `anchor-${intentId}`,
    });
    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId,
      sourceFunctionId,
      providerServiceId,
      methodResolved: null,
      externalPathResolved: '/catalog/items/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.41,
      frontierCode: 'METHOD_UNKNOWN',
    });
    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'METHOD_UNKNOWN',
      frontierClass: 'METHOD_PATH',
      retryStrategy: 'agent_patch',
      detail: {},
    });
    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'METHOD_UNKNOWN',
      targetObjectId: null,
      relationType: null,
    });

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 15,
        completionTokens: 5,
        object: {
          patchType: 'method_path_hint',
          resolved: true,
          confidence: 0.88,
          reasoning: 'route and provider endpoint strongly indicate GET',
          methodPathHint: {
            method: 'GET',
            externalPath: '/catalog/items/123',
          },
        },
      }),
    });

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, proofStateId));
    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(
        and(
          eq(proofPatches.workspaceId, workspaceId),
          eq(proofPatches.sourceKind, 'smart_agent'),
          eq(proofPatches.proofStateId, state?.id),
        ),
      );
    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, state?.id)));

    const smartMode = ((detail.run.stats as Record<string, unknown>)['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode).toMatchObject({
      enabled: true,
      autoAcceptedCount: 1,
      frontierResolvedByLlm: 1,
      llmCallCount: 1,
    });

    expect(smartPatches[0]?.patchType).toBe('method_path_hint');
    expect(smartPatches[0]?.validationStatus).toBe('ACCEPTED');
    expect(frontier).toBeUndefined();
    expect(state?.methodResolved).toBe('GET');
    const steps = await db
      .select()
      .from(proofSteps)
      .where(and(eq(proofSteps.proofStateId, state?.id), eq(proofSteps.stepType, 'apply_patch')));
    expect(steps.length).toBeGreaterThan(0);
  });

  it('smart frontier patch가 review threshold에 걸리면 PENDING으로 저장하고 frontier를 유지해야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });

    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      detail: {
        configKeys: ['client.orders.url'],
        hostHints: ['ORDER_SERVICE'],
      },
    });

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (_dbClient, input) =>
      input.intentId === seeded.intentId
        ? {
          proofStateId,
          status: 'FRONTIER',
          frontierReason: 'HOST_ALIAS_UNRESOLVED',
          targetObjectId: null,
          relationType: null,
        }
        : {
          proofStateId: generateId(),
          status: 'CLOSED_ATOMIC',
          frontierReason: null,
          targetObjectId: null,
          relationType: null,
        },
    );

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 14,
        completionTokens: 6,
        object: {
          patchType: 'alias_binding',
          resolved: true,
          selectedServiceId: seeded.providerServiceId,
          selectedServiceName: 'order-service',
          confidence: 0.63,
          reasoning: 'likely order service but needs review',
          aliasBinding: {
            aliasKey: 'client.orders.url',
            aliasValue: 'ORDER_SERVICE',
            bindingKind: 'property_alias',
          },
        },
      }),
    });

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, proofStateId));
    expect(state?.status).toBe('FRONTIER');

    const smartPatches = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.sourceKind, 'smart_agent')));
    expect(smartPatches).toHaveLength(1);
    expect(smartPatches[0]?.validationStatus).toBe('PENDING');

    const smartCalls = await db
      .select()
      .from(smartProofLlmCalls)
      .where(and(eq(smartProofLlmCalls.workspaceId, workspaceId), eq(smartProofLlmCalls.runId, run.id)));
    expect(smartCalls[0]?.accepted).toBeNull();

    const summary = detail.run.stats as Record<string, unknown>;
    const smartMode = (summary['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode['pendingReviewCount']).toBe(1);
    expect(vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)).toHaveBeenCalledTimes(1);
  });

  it('smart frontier patch가 validator에서 reject 되면 frontier 상태를 유지하고 reject 요약을 남겨야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const proofStateId = generateId();

    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: seeded.intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: seeded.consumerServiceId,
      sourceFunctionId: seeded.sourceFunctionId,
      methodResolved: 'GET',
      externalPathResolved: '/api/orders/123',
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.3,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });

    await db.insert(proofFrontiers).values({
      proofStateId,
      workspaceId,
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      detail: {},
    });

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (_dbClient, input) =>
      input.intentId === seeded.intentId
        ? {
          proofStateId,
          status: 'FRONTIER',
          frontierReason: 'HOST_ALIAS_UNRESOLVED',
          targetObjectId: null,
          relationType: null,
        }
        : {
          proofStateId: generateId(),
          status: 'CLOSED_ATOMIC',
          frontierReason: null,
          targetObjectId: null,
          relationType: null,
        },
    );

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: true,
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 10,
        completionTokens: 4,
        object: {
          patchType: 'alias_binding',
          resolved: true,
          selectedServiceId: generateId(),
          selectedServiceName: 'unknown-service',
          confidence: 0.93,
          reasoning: 'invalid target service',
          aliasBinding: {
            aliasKey: 'client.orders.url',
            aliasValue: 'ORDER_SERVICE',
            bindingKind: 'property_alias',
          },
        },
      }),
    });

    const [state] = await db.select().from(proofStates).where(eq(proofStates.id, proofStateId));
    expect(state?.status).toBe('FRONTIER');

    const patches = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.sourceKind, 'smart_agent')));
    expect(patches[0]?.validationStatus).toBe('REJECTED');

    const summary = detail.run.stats as Record<string, unknown>;
    const smartMode = (summary['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode['skippedCount']).toBeGreaterThan(0);
    expect(vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)).toHaveBeenCalledTimes(1);

    const events = detail.events.filter((event) => event.eventType === 'SMART_PROOF_PASS');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => (event.payload as Record<string, unknown>)['attemptedResolverCount'] === 1)).toBe(true);
  });

  it('intent 단위 smart cap에 걸리면 같은 intent의 추가 frontier는 건너뛰어야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const firstProofStateId = generateId();
    const secondProofStateId = generateId();

    await db.insert(proofStates).values([
      {
        id: firstProofStateId,
        workspaceId,
        intentId: seeded.intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: seeded.consumerServiceId,
        sourceFunctionId: seeded.sourceFunctionId,
        methodResolved: 'GET',
        externalPathResolved: '/api/orders/123',
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
      {
        id: secondProofStateId,
        workspaceId,
        intentId: seeded.intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: seeded.consumerServiceId,
        sourceFunctionId: seeded.sourceFunctionId,
        methodResolved: 'GET',
        externalPathResolved: '/api/orders/456',
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
    ]);

    await db.insert(proofFrontiers).values([
      {
        proofStateId: firstProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {
          configKeys: ['client.orders.url'],
          hostHints: ['ORDER_SERVICE'],
        },
      },
      {
        proofStateId: secondProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {
          configKeys: ['client.orders.url'],
          hostHints: ['ORDER_SERVICE'],
        },
      },
    ]);

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId: firstProofStateId,
      status: 'FRONTIER',
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    });

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: {
        enabled: true,
        categories: {
          preResolutionEnhancement: false,
          frontierResolution: true,
          ambiguityResolution: false,
          crossProofCorrelation: false,
          contradictionDetection: false,
        },
        budget: {
          maxLlmCallsPerRun: 5,
          maxLlmCallsPerIntent: 1,
          maxInputTokensPerCall: 100,
          maxTotalTokensPerRun: 1_000,
        },
        thresholds: {
          autoAcceptConfidence: 0.8,
          reviewConfidence: 0.5,
          skipConfidence: 0.3,
        },
      },
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 10,
        completionTokens: 4,
        object: {
          patchType: 'alias_binding',
          resolved: true,
          selectedServiceId: seeded.providerServiceId,
          selectedServiceName: 'order-service',
          confidence: 0.91,
          reasoning: 'intent cap test',
          aliasBinding: {
            aliasKey: 'client.orders.url',
            aliasValue: 'ORDER_SERVICE',
            bindingKind: 'property_alias',
          },
        },
      }),
    });

    const runStats = detail.run.stats as Record<string, unknown>;
    expect(runStats['smartProof']).toMatchObject({
      attempted: true,
      attemptedFrontierCount: 1,
      skippedReason: null,
    });
    const smartMode = (runStats['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode['llmCallCount']).toBe(1);
    const events = detail.events.filter((event) => event.eventType === 'SMART_PROOF_PASS');
    expect(events.some((event) => (event.payload as Record<string, unknown>)['attemptedResolverCount'] === 1)).toBe(true);
  });

  it('run budget이 소진되면 BUDGET_EXHAUSTED로 종료하고 summary에 1회 호출만 반영해야 한다', async () => {
    const seeded = await seedProofIntent(db);
    const secondIntentId = generateId();
    const secondServiceId = await insertObject(db, {
      objectType: 'service',
      name: 'order-service-2',
    });
    const firstProofStateId = generateId();
    const secondProofStateId = generateId();

    await db.insert(interactionIntents).values({
      id: secondIntentId,
      workspaceId,
      intentType: 'http_call',
      sourceServiceId: secondServiceId,
      sourceFunctionId: null,
      methodHint: 'GET',
      externalPathHint: '/api/billing',
      hostHint: 'BILLING_SERVICE',
      configKeys: ['billing.url'],
      intentHash: 'intent-smart-budget-second',
      anchorHash: 'anchor-smart-budget-second',
    });

    await db.insert(proofStates).values([
      {
        id: firstProofStateId,
        workspaceId,
        intentId: seeded.intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: seeded.consumerServiceId,
        sourceFunctionId: seeded.sourceFunctionId,
        methodResolved: 'GET',
        externalPathResolved: '/api/orders/123',
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
      {
        id: secondProofStateId,
        workspaceId,
        intentId: secondIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: secondServiceId,
        methodResolved: 'GET',
        externalPathResolved: '/api/billing',
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
    ]);

    await db.insert(proofFrontiers).values([
      {
        proofStateId: firstProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {
          configKeys: ['client.orders.url'],
          hostHints: ['ORDER_SERVICE'],
        },
      },
      {
        proofStateId: secondProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {
          configKeys: ['billing.url'],
          hostHints: ['BILLING_SERVICE'],
        },
      },
    ]);

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementation(async (_dbClient, input) => {
      if (input.intentId === seeded.intentId) {
        return {
          proofStateId: firstProofStateId,
          status: 'FRONTIER',
          frontierReason: 'HOST_ALIAS_UNRESOLVED',
          targetObjectId: null,
          relationType: null,
        };
      }

      if (input.intentId === secondIntentId) {
        return {
          proofStateId: secondProofStateId,
          status: 'FRONTIER',
          frontierReason: 'HOST_ALIAS_UNRESOLVED',
          targetObjectId: null,
          relationType: null,
        };
      }

      return {
        proofStateId: generateId(),
        status: 'CLOSED_ATOMIC',
        frontierReason: null,
        targetObjectId: null,
        relationType: null,
      };
    });

    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      smartProof: {
        enabled: true,
        categories: {
          preResolutionEnhancement: false,
          frontierResolution: true,
          ambiguityResolution: false,
          crossProofCorrelation: false,
          contradictionDetection: false,
        },
        budget: {
          maxLlmCallsPerRun: 1,
          maxLlmCallsPerIntent: 5,
          maxInputTokensPerCall: 20,
          maxTotalTokensPerRun: 20,
        },
        thresholds: {
          autoAcceptConfidence: 0.8,
          reviewConfidence: 0.5,
          skipConfidence: 0.2,
        },
      },
      sources: [{ type: 'local', ref: tempDir }],
    });

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      smartGenerateFn: async () => ({
        model: 'mock-smart-model',
        promptTokens: 20,
        completionTokens: 1,
        object: {
          patchType: 'alias_binding',
          resolved: true,
          selectedServiceId: seeded.providerServiceId,
          selectedServiceName: 'order-service',
          confidence: 0.9,
          reasoning: 'budget test',
          aliasBinding: {
            aliasKey: 'client.orders.url',
            aliasValue: 'ORDER_SERVICE',
            bindingKind: 'property_alias',
          },
        },
      }),
    });

    const runStats = detail.run.stats as Record<string, unknown>;
    expect(runStats['smartProof']).toMatchObject({
      skippedReason: 'BUDGET_EXHAUSTED',
      attempted: true,
      attemptedFrontierCount: 2,
    });
    const smartMode = (runStats['proofSummary'] as Record<string, unknown>)['smartMode'] as Record<string, unknown>;
    expect(smartMode['llmCallCount']).toBe(1);
    const events = detail.events.filter((event) => event.eventType === 'SMART_PROOF_PASS');
    expect(events.some((event) => (event.payload as Record<string, unknown>)['outcome'] === 'budget_exhausted')).toBe(true);
  });

  it('cutover artifact 실패는 warning으로만 남기고 run은 계속 완료해야 한다', async () => {
    const seeded = await seedProofIntent(db);
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockImplementationOnce(async (dbClient) => {
      const proofStateId = generateId();
      await dbClient.insert(proofStates).values({
        id: proofStateId,
        workspaceId,
        intentId: seeded.intentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: seeded.consumerServiceId,
        sourceFunctionId: seeded.sourceFunctionId,
        providerServiceId: seeded.providerServiceId,
        targetObjectType: null,
        targetObjectId: null,
        methodResolved: 'GET',
        externalPathResolved: '/api/orders/123',
        internalPathResolved: null,
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      });
      return {
        proofStateId,
        status: 'FRONTIER',
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        targetObjectId: null,
        relationType: null,
      };
    });
    vi.mocked(intentProofCutoverReportModule.buildIntentProofCutoverArtifact).mockRejectedValueOnce(
      new Error('artifact failed'),
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(detail.run.warnings).toContain('cutover artifact 생성 실패: artifact failed');
    expect((detail.run.stats as Record<string, unknown>)['proofSummary']).toMatchObject({
      gatewayRouteSeedCount: 0,
      proofFrontierCount: 1,
      projectedCandidateCount: 0,
      serviceTargetProjectionCount: 0,
    });
  });
});
