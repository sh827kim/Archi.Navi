import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  aliasBindings,
  createTestDb,
  inferenceRunEvents,
  inferenceRuns,
  inferenceRunSources,
  interactionIntents,
  objects,
  proofDependencies,
  proofStates,
  relationCandidates,
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
    db = await createTestDb();
    tempDir = join(tmpdir(), `archi-navi-infrun-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
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
    await seedProofIntent(db);
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId: 'proof-frontier-1',
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

    expect(vi.mocked(frontierAgentModule.runFrontierAgentPass)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(frontierAgentModule.runFrontierAgentPass)).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId,
        proofStateId: 'proof-frontier-1',
        runId: run.id,
      }),
    );

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
    expect(stats['proofResolution']).toMatchObject({
      intentCount: 1,
      closedAtomicCount: 1,
      frontierCount: 0,
      rejectedCount: 0,
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
    await seedProofIntent(db);
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof).mockResolvedValueOnce({
      proofStateId: 'proof-frontier-no-proposal',
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
    writeFileSync(join(tempDir, 'application.yml'), 'spring:\n  application:\n    name: api-gateway\n', 'utf-8');

    vi.mocked(intentProofEngineModule.resolveInteractionIntentProof)
      .mockResolvedValueOnce({
        proofStateId: 'proof-frontier-limit-1',
        status: 'FRONTIER',
        frontierReason: 'CONFIG_BINDING_MISSING',
        targetObjectId: null,
        relationType: null,
      })
      .mockResolvedValueOnce({
        proofStateId: 'proof-frontier-limit-2',
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
