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
  })),
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
    listInferenceRuns: listInferenceRunsMock,
    buildEmptyProofEngineSummary: buildEmptyProofEngineSummaryMock,
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
    getDbMock.mockResolvedValue({ db: 'mock' });
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
      { db: 'mock' },
      expect.objectContaining({
        workspaceId: 'ws-1',
        modes: ['config', 'code', 'db'],
        incremental: false,
        triggerType: 'INTENT_PROOF_ENGINE',
        enableAgentPatches: true,
        maxAgentFrontiers: 3,
        sources: [{ type: 'local', ref: '/repo/root' }],
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      engine: 'intent_proof',
      runId: 'run-1',
      summary: {
        engine: 'intent_proof',
        intentCount: 0,
        gatewayRouteSeedCount: 0,
        derivedEndpointProofCount: 0,
        projectedCandidateCount: 0,
        routeFamilyFrontierCount: 0,
        serviceTargetProjectionCount: 0,
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
      },
    });
  });
});
