// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  createInferenceRunMock,
  executeInferenceRunMock,
  listInferenceRunsMock,
  buildEmptyProofEngineSummaryMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  createInferenceRunMock: vi.fn(),
  executeInferenceRunMock: vi.fn(),
  listInferenceRunsMock: vi.fn(),
  buildEmptyProofEngineSummaryMock: vi.fn(() => ({
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
    agentFrontierCount: 0,
    agentPatchedFrontierCount: 0,
    frontierBreakdown: {},
    targetBreakdown: {},
    smartMode: {
      enabled: false,
      llmCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      frontierResolvedByLlm: 0,
      summaryEnhancedByLlm: 0,
      contradictionsChallenged: 0,
      autoAcceptedCount: 0,
      pendingReviewCount: 0,
      skippedCount: 0,
      resolutionByCategory: {},
      resolutionByFrontierReason: {},
    },
  })),
}));

function createDbMock() {
  return {
    update: vi.fn(),
  };
}

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock('@archi-navi/inference', async () => {
  return {
    buildEmptyProofEngineSummary: buildEmptyProofEngineSummaryMock,
    createInferenceRun: createInferenceRunMock,
    executeInferenceRun: executeInferenceRunMock,
    listInferenceRuns: listInferenceRunsMock,
    normalizeSmartProofConfig: (value: unknown) => (
      typeof value === 'boolean'
        ? { enabled: value }
        : { enabled: value && typeof value === 'object' && 'enabled' in value ? (value as { enabled?: boolean }).enabled !== false : false }
    ),
    normalizeInferenceRunModes: (modes: string[]) => Array.from(new Set(modes.map((mode) => mode.trim()).filter((mode) => mode.length > 0))),
  };
});

import { POST } from '@/app/api/inference/runs/route';

describe('POST /api/inference/runs', () => {
  afterEach(() => {
    delete process.env['INFERENCE_RUNS_API_TOKEN'];
    vi.clearAllMocks();
  });

  it('새 proof-engine 요청 계약을 run 생성 입력으로 정규화해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);
    executeInferenceRunMock.mockResolvedValue(undefined);
    createInferenceRunMock.mockResolvedValue({
      id: 'run-1',
      status: 'QUEUED',
      requestedModes: ['config', 'code', 'db'],
      sourceSummary: { local: 1 },
    });

    const response = await POST(new Request('http://localhost/api/inference/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        transports: ['http', 'db'],
        sources: [{ type: 'local', path: '/repo/root' }],
        useServiceMetadataPaths: false,
        forceRescan: true,
        enableAgentPatches: true,
        maxAgentFrontiers: 3,
      }),
    }) as never);

    expect(response.status).toBe(202);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      dbMock,
      expect.objectContaining({
        workspaceId: 'ws-1',
        modes: ['config', 'code', 'db'],
        incremental: false,
        triggerType: 'INTENT_PROOF_ENGINE',
        enableAgentPatches: true,
        maxAgentFrontiers: 3,
        sources: [{ type: 'local', ref: '/repo/root' }],
        pipeline: 'reinforced',
        pipelineVersion: 'reinforced-v1',
      }),
    );
    expect(dbMock.update).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      engine: 'intent_proof',
      pipeline: 'reinforced',
      pipelineVersion: 'reinforced-v1',
      runId: 'run-1',
      summary: {
        engine: 'intent_proof',
        pipeline: 'reinforced',
        pipelineVersion: 'reinforced-v1',
        intentCount: 0,
        gatewayRouteSeedCount: 0,
        derivedEndpointProofCount: 0,
        projectedCandidateCount: 0,
        routeFamilyFrontierCount: 0,
        serviceTargetProjectionCount: 0,
        smartMode: {
          enabled: false,
        },
      },
      results: {
        frontierAgent: {
          attemptedFrontierCount: 0,
          skippedReason: 'PENDING_RUN',
        },
        requestedAgentPatches: {
          enabled: true,
          maxFrontiers: 3,
        },
        requestedSmartProof: {
          enabled: false,
        },
      },
    });
  });

  it('invalid pipeline 입력은 400을 반환하고 run을 만들지 않아야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);

    const response = await POST(new Request('http://localhost/api/inference/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        transports: ['http'],
        sources: [{ type: 'local', path: '/repo/root' }],
        useServiceMetadataPaths: false,
        pipeline: 'legacy',
      }),
    }) as never);

    expect(response.status).toBe(400);
    expect(createInferenceRunMock).not.toHaveBeenCalled();
    expect(executeInferenceRunMock).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('redesign + compatDeterministicCandidates=true 이면 400을 반환해야 한다', async () => {
    process.env['INFERENCE_RUNS_API_TOKEN'] = 'secret-token';
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);

    const response = await POST(new Request('http://localhost/api/inference/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        transports: ['http'],
        sources: [{ type: 'local', path: '/repo/root' }],
        useServiceMetadataPaths: false,
        pipeline: 'redesign',
        compatDeterministicCandidates: true,
      }),
    }) as never);

    expect(response.status).toBe(400);
    expect(createInferenceRunMock).not.toHaveBeenCalled();
    expect(executeInferenceRunMock).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
