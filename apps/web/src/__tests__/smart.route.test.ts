// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
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
  return {
    buildEmptyProofEngineSummary: buildEmptyProofEngineSummaryMock,
    createInferenceRun: createInferenceRunMock,
    executeInferenceRun: executeInferenceRunMock,
    getInferenceRunDetail: getInferenceRunDetailMock,
    normalizeSmartProofConfig: (value: unknown) => (
      typeof value === 'boolean'
        ? { enabled: value }
        : { enabled: value && typeof value === 'object' && 'enabled' in value ? (value as { enabled?: boolean }).enabled !== false : false }
    ),
  };
});

vi.mock('@/lib/inference-llm', () => ({
  getInferenceModel: getInferenceModelMock,
  createGenerateSmartResolutionFn: createGenerateSmartResolutionFnMock,
}));

import { GET, POST } from '@/app/api/inference/smart/route';

function createDbMock(serviceScanPaths: string[] = []) {
  return {
    update: vi.fn(),
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

  it('invalid pipeline 입력은 400을 반환하고 run을 만들지 않아야 한다', async () => {
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [mkdtempSync(join(tmpdir(), 'smart-proof-invalid-'))],
        useServiceMetadataPaths: false,
        pipeline: 'legacy',
      }),
    }));

    expect(response.status).toBe(400);
    expect(createInferenceRunMock).not.toHaveBeenCalled();
    expect(executeInferenceRunMock).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('POST는 proof engine run을 생성하고 summary를 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-proof-sync-'));
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);
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
        pipeline: 'redesign',
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
        pipeline: 'redesign',
        pipelineVersion: 'redesign-v1',
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
    expect(dbMock.update).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      pipeline: 'redesign',
      pipelineVersion: 'redesign-v1',
      engine: 'intent_proof',
      runId: 'run-proof-1',
      summary: {
        engine: 'intent_proof',
        pipeline: 'redesign',
        pipelineVersion: 'redesign-v1',
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
    const dbMock = createDbMock([repoRoot]);
    getDbMock.mockResolvedValue(dbMock);
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
        pipeline: 'reinforced',
      }),
    }));

    expect(response.status).toBe(202);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        smartProof: true,
        sources: [{ type: 'local', ref: repoRoot }],
        pipeline: 'reinforced',
        pipelineVersion: 'reinforced-v1',
      }),
    );
    expect(dbMock.update).not.toHaveBeenCalled();
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
      pipeline: 'reinforced',
      pipelineVersion: 'reinforced-v1',
      engine: 'intent_proof',
      queued: true,
      runId: 'run-proof-async',
      summary: {
        engine: 'intent_proof',
        pipeline: 'reinforced',
        pipelineVersion: 'reinforced-v1',
        intentCount: 0,
        smartMode: {
          enabled: true,
        },
      },
    });
  });

  it('service scanPath가 있을 때 broad ancestor repoRoot는 제거하고 서비스 root를 유지해야 한다', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'smart-proof-collapse-'));
    const serviceA = join(workspaceRoot, 'service-a');
    const serviceB = join(workspaceRoot, 'service-b');
    mkdirSync(serviceA, { recursive: true });
    mkdirSync(serviceB, { recursive: true });
    vi.stubGlobal('queueMicrotask', (callback: () => void) => callback());
    const dbMock = createDbMock([serviceA, serviceB]);
    getDbMock.mockResolvedValue(dbMock);
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o',
    });
    createInferenceRunMock.mockResolvedValue({ id: 'run-proof-collapse', status: 'QUEUED' });
    executeInferenceRunMock.mockResolvedValue({
      run: { id: 'run-proof-collapse', status: 'SUCCEEDED', stats: {} },
      sources: [],
      events: [],
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [workspaceRoot, serviceA],
        useServiceMetadataPaths: true,
        pipeline: 'reinforced',
      }),
    }));

    expect(response.status).toBe(200);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sources: [
          { type: 'local', ref: serviceA },
          { type: 'local', ref: serviceB },
        ],
      }),
    );
  });

  it('POST는 유효한 repo root가 없으면 NO_REPO_ROOTS를 반환해야 한다', async () => {
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);

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
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('POST는 smart generator가 없으면 run을 생성하지 않고 BAD_REQUEST를 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-proof-no-model-'));
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);
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
    expect(dbMock.update).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'SMART_MODEL_NOT_CONFIGURED',
      },
    });
  });

  it('GET은 proof summary를 우선 반환해야 한다', async () => {
    const dbMock = createDbMock();
    getDbMock.mockResolvedValue(dbMock);
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
      pipeline: 'reinforced',
      pipelineVersion: 'reinforced-v1',
      summary: {
        engine: 'intent_proof',
        pipeline: 'reinforced',
        pipelineVersion: 'reinforced-v1',
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
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
