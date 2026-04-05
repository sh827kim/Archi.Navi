import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  inferenceRuns,
  interactionIntents,
  objects,
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

describe('proofEngineRun', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    const client = (db as { $client?: { end?: () => Promise<void> } } | undefined)?.$client;
    if (client?.end) {
      await client.end();
    }
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

  it('smart summary는 patch 상태 기준으로 accepted/review/skipped를 집계해야 한다', async () => {
    const workspaceId = generateId();
    const runId = generateId();
    const serviceId = generateId();
    const intentId = generateId();
    const proofStateId = generateId();
    const acceptedPatchId = generateId();
    const pendingPatchId = generateId();
    const rejectedPatchId = generateId();

    await db.insert(workspaces).values({
      id: workspaceId,
      name: 'Smart Summary Test',
    });
    await db.insert(inferenceRuns).values({
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
    await db.insert(objects).values({
      id: serviceId,
      workspaceId,
      objectType: 'service',
      name: 'gateway',
      path: 'gateway',
    });
    await db.insert(interactionIntents).values({
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
    await db.insert(proofStates).values({
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
    await db.insert(proofPatches).values([
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
    await db.insert(smartProofLlmCalls).values([
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

    const summary = await buildProofEngineSummaryForRun(db, {
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
});
