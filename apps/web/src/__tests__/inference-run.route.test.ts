// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getDbMock,
  createInferenceRunMock,
  executeInferenceRunMock,
  getInferenceModelMock,
  createGenerateSmartResolutionFnMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  createInferenceRunMock: vi.fn(),
  executeInferenceRunMock: vi.fn(),
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
  };
});

vi.mock('@/lib/inference-llm', () => ({
  getInferenceModel: getInferenceModelMock,
  createGenerateSmartResolutionFn: createGenerateSmartResolutionFnMock,
}));

import { POST } from '@/app/api/inference/run/route';

describe('POST /api/inference/run', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await POST(new NextRequest('http://localhost/api/inference/run', {
      method: 'POST',
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(400);
  });

  it('proof-engine sync run으로 정규화해 실행하고 summary를 반환해야 한다', async () => {
    getDbMock.mockResolvedValue({ db: 'mock' });
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o',
    });
    createInferenceRunMock.mockResolvedValue({
      id: 'run-1',
      status: 'QUEUED',
    });
    executeInferenceRunMock.mockResolvedValue({
      run: {
        id: 'run-1',
        status: 'SUCCEEDED',
        stats: {
          proofSummary: {
            engine: 'intent_proof',
            intentCount: 3,
            gatewayRouteSeedCount: 1,
            derivedEndpointProofCount: 2,
            proofClosedAtomicCount: 2,
            proofFrontierCount: 1,
            routeFamilyFrontierCount: 1,
            proofRejectedCount: 0,
            projectedCandidateCount: 2,
            serviceTargetProjectionCount: 0,
            agentFrontierCount: 1,
            agentPatchedFrontierCount: 0,
            frontierBreakdown: { HOST_ALIAS_UNRESOLVED: 1 },
            targetBreakdown: { api_endpoint: 2 },
          },
          config: { repoCount: 1, aliasBindingCount: 2, routeTransformCount: 1 },
          code: { repoCount: 1, enginesUsed: ['hybrid'], fallbackCount: 0, scanFailures: [] },
          db: null,
          proofResolution: { intentCount: 3, closedAtomicCount: 2, frontierCount: 1, rejectedCount: 0 },
          frontierAgent: {
            attemptedFrontierCount: 1,
            proposedPatchCount: 1,
            appliedPatchCount: 0,
            rejectedPatchCount: 1,
            skippedReason: null,
          },
          requestedAgentPatches: {
            enabled: true,
            maxFrontiers: 7,
          },
        },
        warnings: [],
        errors: [],
      },
      sources: [],
      events: [],
    });

    const response = await POST(new NextRequest('http://localhost/api/inference/run', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        transports: ['http'],
        repoRoots: ['/repo/root'],
        useServiceMetadataPaths: false,
        enableAgentPatches: true,
        maxAgentFrontiers: 7,
        llmBoost: {
          enabled: true,
          codeIntentAnalysis: true,
          generateExplanations: true,
          maxCalls: 5,
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      { db: 'mock' },
      expect.objectContaining({
        workspaceId: 'ws-1',
        modes: ['config', 'code'],
        triggerType: 'INTENT_PROOF_ENGINE',
        enableAgentPatches: true,
        maxAgentFrontiers: 7,
        sources: [{ type: 'local', ref: '/repo/root' }],
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      engine: 'intent_proof',
      runId: 'run-1',
      summary: {
        engine: 'intent_proof',
        intentCount: 3,
        gatewayRouteSeedCount: 1,
        derivedEndpointProofCount: 2,
        smartMode: {
          enabled: false,
        },
        routeFamilyFrontierCount: 1,
        projectedCandidateCount: 2,
        serviceTargetProjectionCount: 0,
      },
      results: {
        code: { enginesUsed: ['hybrid'] },
        proofResolution: { intentCount: 3, frontierCount: 1 },
        frontierAgent: { attemptedFrontierCount: 1, rejectedPatchCount: 1 },
        requestedAgentPatches: { enabled: true, maxFrontiers: 7 },
        requestedSmartProof: { enabled: false },
      },
      llmBoost: {
        skippedReason: 'DISABLED_IN_PROOF_ENGINE',
        codeIntentAnalysis: {
          generatedCount: 0,
        },
      },
    });
    expect(createGenerateSmartResolutionFnMock).not.toHaveBeenCalled();
  });

  it('smartProof=true 이면 모델이 있을 때 smartGenerateFn을 실행 입력으로 전달해야 한다', async () => {
    getDbMock.mockResolvedValue({ db: 'mock' });
    const smartGenerateFn = vi.fn();
    getInferenceModelMock.mockReturnValue({
      model: { provider: 'openai' },
      modelName: 'gpt-4o',
    });
    createGenerateSmartResolutionFnMock.mockReturnValue(smartGenerateFn);
    createInferenceRunMock.mockResolvedValue({
      id: 'run-smart-1',
      status: 'QUEUED',
    });
    executeInferenceRunMock.mockResolvedValue({
      run: {
        id: 'run-smart-1',
        status: 'SUCCEEDED',
        stats: {
          proofSummary: {
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
            smartMode: { enabled: true },
          },
        },
        warnings: [],
        errors: [],
      },
      sources: [],
      events: [],
    });

    const response = await POST(new NextRequest('http://localhost/api/inference/run', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        modes: ['config'],
        repoRoots: ['/repo/root'],
        useServiceMetadataPaths: false,
        smartProof: true,
      }),
    }));

    expect(response.status).toBe(200);
    expect(createGenerateSmartResolutionFnMock).toHaveBeenCalledWith(
      { provider: 'openai' },
      'gpt-4o',
    );
    expect(executeInferenceRunMock).toHaveBeenCalledWith(
      { db: 'mock' },
      expect.objectContaining({
        workspaceId: 'ws-1',
        runId: 'run-smart-1',
        smartGenerateFn,
      }),
    );
  });

  it('nested local repoRoots는 ancestor root만 남기도록 정규화해야 한다', async () => {
    getDbMock.mockResolvedValue({ db: 'mock' });
    createInferenceRunMock.mockResolvedValue({
      id: 'run-2',
      status: 'QUEUED',
    });
    executeInferenceRunMock.mockResolvedValue({
      run: {
        id: 'run-2',
        status: 'SUCCEEDED',
        stats: {
          proofSummary: {
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
          },
          config: { repoCount: 1, fileCount: 1, processedFileCount: 1, skippedFileCount: 0 },
          code: { repoCount: 1, enginesUsed: ['hybrid'], fallbackCount: 0, scanFailures: [] },
          db: null,
          proofResolution: { intentCount: 0, closedAtomicCount: 0, frontierCount: 0, rejectedCount: 0 },
        },
        warnings: [],
        errors: [],
      },
      sources: [],
      events: [],
    });

    const response = await POST(new NextRequest('http://localhost/api/inference/run', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        modes: ['config', 'code'],
        repoRoots: ['/repo/root', '/repo/root/orders-service'],
        useServiceMetadataPaths: false,
      }),
    }));

    expect(response.status).toBe(200);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      { db: 'mock' },
      expect.objectContaining({
        sources: [{ type: 'local', ref: '/repo/root' }],
      }),
    );
  });
});
