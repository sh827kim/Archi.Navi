import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDb,
  createTestDb,
  functionSummaries,
  getEmbeddedPostgresTestSupport,
  inferenceRuns,
  interactionIntents,
  objects,
  proofFrontiers,
  proofPatches,
  proofStates,
  smartProofLlmCalls,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  buildEmptyProofEngineSummary,
  buildProofEngineSummaryForRun,
} from '@/orchestration/proofEngineRun';

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const itDb = embeddedSupport.supported ? it : it.skip;

if (!embeddedSupport.supported) {
  console.warn(
    `[inference:test] skipping proofEngineRun DB integration tests: ${
      embeddedSupport.reason ?? 'unsupported test database environment'
    }`,
  );
}

describe('proofEngineRun', () => {
  let db: Awaited<ReturnType<typeof createTestDb>> | undefined;

  beforeEach(async () => {
    if (!embeddedSupport.supported) {
      return;
    }
    db = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
    db = undefined;
  });

  it('proof engine summary 기본값은 Smart 메트릭 블록을 포함해야 한다', () => {
    expect(buildEmptyProofEngineSummary()).toMatchObject({
      engine: 'intent_proof',
      smartMode: {
        enabled: false,
        llmCallCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0,
        frontierResolvedByLlm: 0,
        autoAcceptedCount: 0,
        pendingReviewCount: 0,
        skippedCount: 0,
      },
    });
  });

  itDb('smart summary는 patch 상태 기준으로 accepted/review/skipped를 집계해야 한다', async () => {
    const workspaceId = generateId();
    const runId = generateId();
    const serviceId = generateId();
    const intentId = generateId();
    const proofStateId = generateId();
    const acceptedPatchId = generateId();
    const pendingPatchId = generateId();
    const rejectedPatchId = generateId();

    await db!.insert(workspaces).values({
      id: workspaceId,
      name: 'Smart Summary Test',
    });
    await db!.insert(inferenceRuns).values({
      id: runId,
      workspaceId,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      requestedModes: ['config'],
      requestedIncremental: true,
      sourceSummary: {},
      stats: {
        requestedSmartProof: {
          enabled: true,
        },
      },
      warnings: [],
      errors: [],
    });
    await db!.insert(objects).values({
      id: serviceId,
      workspaceId,
      objectType: 'service',
      name: 'gateway',
      path: 'gateway',
    });
    await db!.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      createdRunId: runId,
      updatedRunId: runId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: null,
      methodHint: 'GET',
      externalPathHint: '/api/orders',
      hostHint: 'ORDER_API',
      configKeys: [],
      intentHash: 'smart-summary-intent',
      anchorHash: 'smart-summary-anchor',
    });
    await db!.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
      sourceFunctionId: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.4,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });
    await db!.insert(proofPatches).values([
      {
        id: acceptedPatchId,
        workspaceId,
        proofStateId,
        patchType: 'alias_binding',
        payload: {},
        sourceKind: 'smart_agent',
        validationStatus: 'ACCEPTED',
        evidenceIds: [],
      },
      {
        id: pendingPatchId,
        workspaceId,
        proofStateId,
        patchType: 'alias_binding',
        payload: {},
        sourceKind: 'smart_agent',
        validationStatus: 'PENDING',
        evidenceIds: [],
      },
      {
        id: rejectedPatchId,
        workspaceId,
        proofStateId,
        patchType: 'alias_binding',
        payload: {},
        sourceKind: 'smart_agent',
        validationStatus: 'REJECTED',
        evidenceIds: [],
      },
    ]);
    await db!.insert(smartProofLlmCalls).values([
      {
        id: generateId(),
        workspaceId,
        runId,
        proofStateId,
        callCategory: 'frontier_resolution',
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        model: 'mock-model',
        inputTokens: 10,
        outputTokens: 3,
        promptHash: 'a',
        responseHash: 'b',
        promptSnapshot: {},
        responseSnapshot: {},
        accepted: true,
        patchId: acceptedPatchId,
      },
      {
        id: generateId(),
        workspaceId,
        runId,
        proofStateId,
        callCategory: 'frontier_resolution',
        frontierReason: 'CONFIG_BINDING_MISSING',
        model: 'mock-model',
        inputTokens: 8,
        outputTokens: 4,
        promptHash: 'c',
        responseHash: 'd',
        promptSnapshot: {},
        responseSnapshot: {},
        accepted: null,
        patchId: pendingPatchId,
      },
      {
        id: generateId(),
        workspaceId,
        runId,
        proofStateId,
        callCategory: 'frontier_resolution',
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        model: 'mock-model',
        inputTokens: 6,
        outputTokens: 2,
        promptHash: 'e',
        responseHash: 'f',
        promptSnapshot: {},
        responseSnapshot: {},
        accepted: false,
        patchId: rejectedPatchId,
      },
    ]);

    const summary = await buildProofEngineSummaryForRun(db!, {
      workspaceId,
      runId,
    });

    expect(summary.smartMode).toMatchObject({
      enabled: true,
      llmCallCount: 3,
      totalInputTokens: 24,
      totalOutputTokens: 9,
      autoAcceptedCount: 1,
      pendingReviewCount: 1,
      skippedCount: 1,
      frontierResolvedByLlm: 1,
    });
    expect(summary.smartMode.resolutionByFrontierReason).toMatchObject({
      HOST_ALIAS_UNRESOLVED: 2,
      CONFIG_BINDING_MISSING: 1,
    });
  });

  itDb('cross_proof_correlation accepted call도 frontierResolvedByLlm로 집계해야 한다', async () => {
    const workspaceId = generateId();
    const runId = generateId();
    const serviceId = generateId();
    const intentId = generateId();
    const proofStateId = generateId();
    const patchId = generateId();

    await db!.insert(workspaces).values({
      id: workspaceId,
      name: 'Smart Correlation Summary Test',
    });
    await db!.insert(inferenceRuns).values({
      id: runId,
      workspaceId,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      requestedModes: ['config'],
      requestedIncremental: true,
      sourceSummary: {},
      stats: {
        requestedSmartProof: {
          enabled: true,
        },
      },
      warnings: [],
      errors: [],
    });
    await db!.insert(objects).values({
      id: serviceId,
      workspaceId,
      objectType: 'service',
      name: 'gateway',
      path: 'gateway',
    });
    await db!.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      createdRunId: runId,
      updatedRunId: runId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      sourceFunctionId: null,
      methodHint: 'GET',
      externalPathHint: '/api/orders',
      hostHint: 'ORDER_API',
      configKeys: ['client.orders.url'],
      intentHash: 'smart-correlation-intent',
      anchorHash: 'smart-correlation-anchor',
    });
    await db!.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
      sourceFunctionId: null,
      routeChain: [],
      slotState: {},
      ambiguityCount: 0,
      contradictionCount: 0,
      confidence: 0.4,
      frontierCode: 'HOST_ALIAS_UNRESOLVED',
    });
    await db!.insert(proofPatches).values({
      id: patchId,
      workspaceId,
      proofStateId,
      patchType: 'alias_binding',
      payload: {},
      sourceKind: 'smart_agent',
      validationStatus: 'ACCEPTED',
      evidenceIds: [],
    });
    await db!.insert(smartProofLlmCalls).values({
      id: generateId(),
      workspaceId,
      runId,
      proofStateId,
      callCategory: 'cross_proof_correlation',
      frontierReason: 'HOST_ALIAS_UNRESOLVED',
      model: 'mock-model',
      inputTokens: 11,
      outputTokens: 5,
      promptHash: 'corr-a',
      responseHash: 'corr-b',
      promptSnapshot: {},
      responseSnapshot: {},
      accepted: true,
      patchId,
    });

    const summary = await buildProofEngineSummaryForRun(db!, {
      workspaceId,
      runId,
    });

    expect(summary.smartMode).toMatchObject({
      enabled: true,
      llmCallCount: 1,
      autoAcceptedCount: 1,
      frontierResolvedByLlm: 1,
    });
    expect(summary.smartMode.resolutionByCategory).toMatchObject({
      cross_proof_correlation: 1,
    });
  });

  itDb('contradiction_detection accepted call은 contradictionsChallenged로 집계해야 한다', async () => {
    const workspaceId = generateId();
    const runId = generateId();
    const serviceId = generateId();
    const intentId = generateId();
    const proofStateId = generateId();
    const patchId = generateId();

    await db!.insert(workspaces).values({
      id: workspaceId,
      name: 'Smart Contradiction Summary Test',
    });
    await db!.insert(inferenceRuns).values({
      id: runId,
      workspaceId,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      requestedModes: ['config'],
      requestedIncremental: true,
      sourceSummary: {},
      stats: {
        requestedSmartProof: {
          enabled: true,
        },
      },
      warnings: [],
      errors: [],
    });
    await db!.insert(objects).values({
      id: serviceId,
      workspaceId,
      objectType: 'service',
      name: 'gateway',
      path: 'gateway',
    });
    await db!.insert(interactionIntents).values({
      id: intentId,
      workspaceId,
      createdRunId: runId,
      updatedRunId: runId,
      intentType: 'http_call',
      sourceServiceId: serviceId,
      intentHash: 'smart-contradiction-intent',
      anchorHash: 'smart-contradiction-anchor',
    });
    await db!.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId,
      proofType: 'http_call',
      status: 'FRONTIER',
      consumerServiceId: serviceId,
    });
    await db!.insert(proofPatches).values({
      id: patchId,
      workspaceId,
      proofStateId,
      patchType: 'contradiction_challenge',
      payload: {
        challengeReasons: ['LOW_CONFIDENCE_FALSE_POSITIVE'],
        expectedAction: 'reopen_frontier',
      },
      sourceKind: 'smart_agent',
      validationStatus: 'ACCEPTED',
      evidenceIds: [],
    });
    await db!.insert(smartProofLlmCalls).values({
      id: generateId(),
      workspaceId,
      runId,
      proofStateId,
      callCategory: 'contradiction_detection',
      frontierReason: 'LOW_CONFIDENCE_CLOSED_ATOMIC',
      model: 'mock-model',
      inputTokens: 8,
      outputTokens: 3,
      promptHash: 'contra-a',
      responseHash: 'contra-b',
      promptSnapshot: {},
      responseSnapshot: {},
      accepted: true,
      patchId,
    });

    const summary = await buildProofEngineSummaryForRun(db!, {
      workspaceId,
      runId,
    });

    expect(summary.smartMode).toMatchObject({
      enabled: true,
      llmCallCount: 1,
      autoAcceptedCount: 1,
      contradictionsChallenged: 1,
      frontierResolvedByLlm: 0,
    });
    expect(summary.smartMode.resolutionByCategory).toMatchObject({
      contradiction_detection: 1,
    });
  });

  itDb('partial HTTP summary와 frontier reason을 함께 사용해 dynamic/path-only intent count를 집계해야 한다', async () => {
    const workspaceId = generateId();
    const runId = generateId();
    const serviceId = generateId();
    const dynamicFunctionId = generateId();
    const pathOnlyFunctionId = generateId();
    const dynamicIntentId = generateId();
    const pathSummaryIntentId = generateId();
    const frontierPathIntentId = generateId();
    const dynamicProofStateId = generateId();
    const pathSummaryProofStateId = generateId();
    const frontierPathProofStateId = generateId();

    await db!.insert(workspaces).values({
      id: workspaceId,
      name: 'Proof Summary Partial HTTP Metrics',
    });
    await db!.insert(inferenceRuns).values({
      id: runId,
      workspaceId,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      requestedModes: ['code'],
      requestedIncremental: true,
      sourceSummary: {},
      stats: {},
      warnings: [],
      errors: [],
    });
    await db!.insert(objects).values([
      {
        id: serviceId,
        workspaceId,
        objectType: 'service',
        name: 'gateway',
        path: 'gateway',
      },
      {
        id: dynamicFunctionId,
        workspaceId,
        objectType: 'function',
        name: 'Gateway.dynamicFetch',
        parentId: serviceId,
        path: 'gateway/dynamicFetch',
      },
      {
        id: pathOnlyFunctionId,
        workspaceId,
        objectType: 'function',
        name: 'Gateway.pathOnlyFetch',
        parentId: serviceId,
        path: 'gateway/pathOnlyFetch',
      },
    ]);
    await db!.insert(functionSummaries).values([
      {
        id: generateId(),
        workspaceId,
        functionId: dynamicFunctionId,
        serviceId,
        updatedRunId: runId,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/api/orders/{id}',
          dynamicPath: true,
        },
        flags: {
          dynamicPath: true,
        },
        extractionStrategy: 'ast_primary',
        sourceHash: 'summary-dynamic-run',
        confidence: 0.91,
      },
      {
        id: generateId(),
        workspaceId,
        functionId: pathOnlyFunctionId,
        serviceId,
        updatedRunId: runId,
        summaryKind: 'http',
        outboundHttp: {
          method: 'GET',
          path: '/api/orders/{id}',
        },
        extractionStrategy: 'ast_primary',
        sourceHash: 'summary-path-only-run',
        confidence: 0.89,
      },
    ]);
    await db!.insert(interactionIntents).values([
      {
        id: dynamicIntentId,
        workspaceId,
        createdRunId: runId,
        updatedRunId: runId,
        intentType: 'http_call',
        sourceServiceId: serviceId,
        sourceFunctionId: dynamicFunctionId,
        methodHint: 'GET',
        externalPathHint: '/api/orders/1',
        intentHash: 'intent-summary-dynamic',
        anchorHash: 'anchor-summary-dynamic',
      },
      {
        id: pathSummaryIntentId,
        workspaceId,
        createdRunId: runId,
        updatedRunId: runId,
        intentType: 'http_call',
        sourceServiceId: serviceId,
        sourceFunctionId: pathOnlyFunctionId,
        methodHint: 'GET',
        externalPathHint: '/api/orders/2',
        intentHash: 'intent-summary-path',
        anchorHash: 'anchor-summary-path',
      },
      {
        id: frontierPathIntentId,
        workspaceId,
        createdRunId: runId,
        updatedRunId: runId,
        intentType: 'http_call',
        sourceServiceId: serviceId,
        methodHint: 'GET',
        externalPathHint: '/api/orders/3',
        intentHash: 'intent-frontier-path',
        anchorHash: 'anchor-frontier-path',
      },
    ]);
    await db!.insert(proofStates).values([
      {
        id: dynamicProofStateId,
        workspaceId,
        intentId: dynamicIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        sourceFunctionId: dynamicFunctionId,
      },
      {
        id: pathSummaryProofStateId,
        workspaceId,
        intentId: pathSummaryIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        sourceFunctionId: pathOnlyFunctionId,
      },
      {
        id: frontierPathProofStateId,
        workspaceId,
        intentId: frontierPathIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
      },
    ]);
    await db!.insert(proofFrontiers).values([
      {
        id: generateId(),
        workspaceId,
        proofStateId: dynamicProofStateId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
      },
      {
        id: generateId(),
        workspaceId,
        proofStateId: pathSummaryProofStateId,
        frontierReason: 'CONFIG_BINDING_MISSING',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
      },
      {
        id: generateId(),
        workspaceId,
        proofStateId: frontierPathProofStateId,
        frontierReason: 'PATH_ONLY_TARGET_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
      },
    ]);

    const summary = await buildProofEngineSummaryForRun(db!, {
      workspaceId,
      runId,
    });

    expect(summary.dynamicUriIntentCount).toBe(1);
    expect(summary.pathOnlyIntentCount).toBe(2);
    expect(summary.frontierReasonBreakdown).toMatchObject({
      HOST_ALIAS_UNRESOLVED: 1,
      CONFIG_BINDING_MISSING: 1,
      PATH_ONLY_TARGET_UNRESOLVED: 1,
    });
  });
});
