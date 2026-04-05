// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  getDbMock,
  createInferenceRunMock,
  executeInferenceRunMock,
  getInferenceRunDetailMock,
  buildEmptyProofEngineSummaryMock,
  getInferenceModelMock,
  createGenerateSmartResolutionFnMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  createInferenceRunMock: vi.fn(),
  executeInferenceRunMock: vi.fn(),
  getInferenceRunDetailMock: vi.fn(),
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
  getInferenceModelMock: vi.fn(),
  createGenerateSmartResolutionFnMock: vi.fn(() => vi.fn()),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock('@archi-navi/inference', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/inference')>('@archi-navi/inference');
  return {
    ...actual,
    createInferenceRun: createInferenceRunMock,
    executeInferenceRun: executeInferenceRunMock,
    getInferenceRunDetail: getInferenceRunDetailMock,
    buildEmptyProofEngineSummary: buildEmptyProofEngineSummaryMock,
  };
});

vi.mock('@/lib/inference-llm', () => ({
  getInferenceModel: getInferenceModelMock,
  createGenerateSmartResolutionFn: createGenerateSmartResolutionFnMock,
}));

import { GET, POST } from '@/app/api/inference/smart/route';

function createDbMock(serviceScanPaths: string[] = []) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(
          serviceScanPaths.map((scanPath) => ({ metadata: { scanPath } })),
        ),
      })),
    })),
  };
}

describe('/api/inference/smart', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('POST는 legacy analysisMode 계약을 거부해야 한다', async () => {
    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        analysisMode: 'pair_pack',
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'BAD_REQUEST',
      },
    });
  });

  it('POST는 proof engine run을 생성하고 summary를 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-proof-sync-'));
    getDbMock.mockResolvedValue(createDbMock());
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o',
    });
    createInferenceRunMock.mockResolvedValue({
      id: 'run-proof-1',
      status: 'QUEUED',
    });
    executeInferenceRunMock.mockResolvedValue({
      run: {
        id: 'run-proof-1',
        status: 'SUCCEEDED',
        stats: {
          proofSummary: {
            engine: 'intent_proof',
            intentCount: 5,
            gatewayRouteSeedCount: 0,
            derivedEndpointProofCount: 0,
            proofClosedAtomicCount: 3,
            proofFrontierCount: 1,
            routeFamilyFrontierCount: 0,
            proofRejectedCount: 1,
            projectedCandidateCount: 3,
            serviceTargetProjectionCount: 0,
            agentFrontierCount: 1,
            agentPatchedFrontierCount: 0,
            frontierBreakdown: {
              PATH_NOT_MATCHED: 1,
            },
            targetBreakdown: {
              api_endpoint: 3,
            },
          },
        },
      },
      sources: [{ sourceRef: repoRoot }],
      events: [],
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        useServiceMetadataPaths: false,
        enableAgentPatches: true,
        maxAgentFrontiers: 4,
      }),
    }));

    expect(response.status).toBe(200);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        triggerType: 'INTENT_PROOF_ENGINE',
        modes: ['config', 'code'],
        incremental: true,
        smartProof: true,
        enableAgentPatches: true,
        maxAgentFrontiers: 4,
        sources: [{ type: 'local', ref: repoRoot }],
      }),
    );
    expect(executeInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        runId: 'run-proof-1',
      }),
    );
    expect(createGenerateSmartResolutionFnMock).toHaveBeenCalledWith(
      { provider: 'openai' },
      'gpt-4o',
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      engine: 'intent_proof',
      runId: 'run-proof-1',
      summary: {
        engine: 'intent_proof',
        intentCount: 5,
        gatewayRouteSeedCount: 0,
        derivedEndpointProofCount: 0,
        proofClosedAtomicCount: 3,
        proofFrontierCount: 1,
        routeFamilyFrontierCount: 0,
        proofRejectedCount: 1,
        projectedCandidateCount: 3,
        serviceTargetProjectionCount: 0,
        smartMode: {
          enabled: true,
        },
        frontierBreakdown: {
          PATH_NOT_MATCHED: 1,
        },
        targetBreakdown: {
          api_endpoint: 3,
        },
      },
      data: {
        repoRoots: [repoRoot],
      },
    });
  });

  it('POST async=true는 proof engine run을 큐잉하고 202를 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-proof-async-'));
    getDbMock.mockResolvedValue(createDbMock([repoRoot]));
    const smartGenerateFn = vi.fn();
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o',
    });
    createGenerateSmartResolutionFnMock.mockReturnValue(smartGenerateFn);
    createInferenceRunMock.mockResolvedValue({
      id: 'run-proof-async',
      status: 'QUEUED',
    });
    getInferenceRunDetailMock.mockResolvedValue({
      run: {
        id: 'run-proof-async',
        status: 'QUEUED',
        stats: {},
      },
      sources: [{ sourceRef: repoRoot }],
      events: [],
    });

    vi.stubGlobal('queueMicrotask', (callback: () => void) => {
      callback();
    });
    executeInferenceRunMock.mockResolvedValue({
      run: {
        id: 'run-proof-async',
        status: 'SUCCEEDED',
        stats: {},
      },
      sources: [],
      events: [],
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        useServiceMetadataPaths: true,
        async: true,
      }),
    }));

    expect(response.status).toBe(202);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        smartProof: true,
        sources: [{ type: 'local', ref: repoRoot }],
      }),
    );
    expect(executeInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        runId: 'run-proof-async',
        smartGenerateFn,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      engine: 'intent_proof',
      queued: true,
      runId: 'run-proof-async',
      summary: {
        engine: 'intent_proof',
        intentCount: 0,
        smartMode: {
          enabled: true,
        },
      },
    });
  });

  it('POST는 유효한 repo root가 없으면 NO_REPO_ROOTS를 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: ['/path/does/not/exist'],
        useServiceMetadataPaths: false,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'NO_REPO_ROOTS',
      },
    });
  });

  it('POST는 smart generator가 없으면 run을 생성하지 않고 BAD_REQUEST를 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-proof-no-model-'));
    getDbMock.mockResolvedValue(createDbMock());
    getInferenceModelMock.mockReturnValue(null);

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        useServiceMetadataPaths: false,
        smartProof: true,
      }),
    }));

    expect(response.status).toBe(400);
    expect(createInferenceRunMock).not.toHaveBeenCalled();
    expect(executeInferenceRunMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'SMART_MODEL_NOT_CONFIGURED',
      },
    });
  });

  it('GET은 proof summary를 우선 반환해야 한다', async () => {
    getDbMock.mockResolvedValue({});
    getInferenceRunDetailMock.mockResolvedValue({
      run: {
        id: 'run-proof-1',
        status: 'SUCCEEDED',
        triggerType: 'INTENT_PROOF_ENGINE',
        stats: {
          proofSummary: {
            engine: 'intent_proof',
            intentCount: 4,
            gatewayRouteSeedCount: 0,
            derivedEndpointProofCount: 0,
            proofClosedAtomicCount: 2,
            proofFrontierCount: 2,
            routeFamilyFrontierCount: 0,
            proofRejectedCount: 0,
            projectedCandidateCount: 2,
            serviceTargetProjectionCount: 0,
            agentFrontierCount: 1,
            agentPatchedFrontierCount: 1,
            frontierBreakdown: {
              PATH_NOT_MATCHED: 2,
            },
            targetBreakdown: {
              api_endpoint: 2,
            },
          },
        },
      },
      sources: [],
      events: [],
    });

    const response = await GET(
      new Request('http://localhost/api/inference/smart?workspaceId=ws-1&runId=run-proof-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      engine: 'intent_proof',
      summary: {
        engine: 'intent_proof',
        intentCount: 4,
        gatewayRouteSeedCount: 0,
        derivedEndpointProofCount: 0,
        proofClosedAtomicCount: 2,
        proofFrontierCount: 2,
        routeFamilyFrontierCount: 0,
        projectedCandidateCount: 2,
        serviceTargetProjectionCount: 0,
        smartMode: {
          enabled: true,
        },
      },
      data: {
        summary: {
          frontierBreakdown: {
            PATH_NOT_MATCHED: 2,
          },
        },
      },
    });
  });
});
