// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  proofFrontiersMock,
  proofStatesMock,
  smartProofLlmCallsMock,
  normalizeSmartProofConfigMock,
  createSmartBudgetTrackerMock,
  canAffordSmartBudgetCallMock,
  recordSmartBudgetCallMock,
  resolveSmartAmbiguityMock,
  getInferenceModelMock,
  createGenerateSmartResolutionFnMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  proofFrontiersMock: { proofStateId: 'proof_state_id', workspaceId: 'workspace_id', frontierReason: 'frontier_reason' },
  proofStatesMock: { id: 'id', status: 'status' },
  smartProofLlmCallsMock: {
    id: 'id',
    workspaceId: 'workspace_id',
    proofStateId: 'proof_state_id',
    callCategory: 'call_category',
    accepted: 'accepted',
    patchId: 'patch_id',
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
  },
  normalizeSmartProofConfigMock: vi.fn(),
  createSmartBudgetTrackerMock: vi.fn(),
  canAffordSmartBudgetCallMock: vi.fn(),
  recordSmartBudgetCallMock: vi.fn(),
  resolveSmartAmbiguityMock: vi.fn(),
  getInferenceModelMock: vi.fn(),
  createGenerateSmartResolutionFnMock: vi.fn(),
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  proofFrontiers: proofFrontiersMock,
  proofStates: proofStatesMock,
  smartProofLlmCalls: smartProofLlmCallsMock,
}));

vi.mock('@archi-navi/inference', () => ({
  normalizeSmartProofConfig: normalizeSmartProofConfigMock,
  createSmartBudgetTracker: createSmartBudgetTrackerMock,
  canAffordSmartBudgetCall: canAffordSmartBudgetCallMock,
  recordSmartBudgetCall: recordSmartBudgetCallMock,
  resolveSmartAmbiguity: resolveSmartAmbiguityMock,
}));

vi.mock('@/lib/inference-llm', () => ({
  getInferenceModel: getInferenceModelMock,
  createGenerateSmartResolutionFn: createGenerateSmartResolutionFnMock,
}));

import { POST } from '@/app/api/inference/frontiers/smart-review/route';

function createDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: Record<string, unknown>) => {
        if ('frontierReason' in table) {
          return {
            innerJoin: vi.fn(() => ({
              where: vi.fn()
                .mockResolvedValueOnce([{ proofStateId: 'proof-1' }])
                .mockResolvedValueOnce([{ proofStateId: 'proof-1' }]),
            })),
          };
        }
        if ('callCategory' in table) {
          return {
            where: vi.fn().mockResolvedValue([
              {
                id: 'call-1',
                proofStateId: 'proof-1',
                callCategory: 'ambiguity_resolution',
                accepted: true,
                patchId: 'patch-1',
                inputTokens: 11,
                outputTokens: 7,
              },
            ]),
          };
        }
        throw new Error('unexpected table');
      }),
    })),
  };
}

describe('POST /api/inference/frontiers/smart-review', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('proofStateId 대상 ambiguity frontier를 Smart 재검토하고 결과/요약을 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());
    normalizeSmartProofConfigMock
      .mockReturnValueOnce({
        enabled: true,
        categories: { ambiguityResolution: true },
        budget: {
          maxLlmCallsPerRun: 2,
          maxInputTokensPerCall: 200,
          maxTotalTokensPerRun: 1000,
        },
      })
      .mockReturnValueOnce({
        enabled: true,
        categories: { ambiguityResolution: true },
        budget: {
          maxLlmCallsPerRun: 2,
          maxInputTokensPerCall: 200,
          maxTotalTokensPerRun: 1000,
        },
      });
    getInferenceModelMock.mockReturnValue({ model: { provider: 'openai' }, modelName: 'gpt-4o' });
    createGenerateSmartResolutionFnMock.mockReturnValue(vi.fn());
    createSmartBudgetTrackerMock.mockReturnValue({ callsUsed: 0, tokensUsed: 0 });
    canAffordSmartBudgetCallMock.mockReturnValue(true);
    recordSmartBudgetCallMock.mockReturnValue({ callsUsed: 1, tokensUsed: 18 });
    resolveSmartAmbiguityMock.mockResolvedValue({
      proofStateId: 'proof-1',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      attempted: true,
      resolved: true,
      confidence: 0.9,
      reasoning: 'resolved',
      decision: 'ACCEPTED',
      patch: {
        patchType: 'provider_service_selection',
        payload: { selectedServiceId: 'svc-1' },
        sourceKind: 'smart_agent',
      },
      validationStatus: 'ACCEPTED',
      errors: [],
      resolution: { status: 'CLOSED_ATOMIC' },
      llmCallId: 'call-1',
      tokensUsed: { input: 11, output: 7 },
    });

    const response = await POST(new Request('http://localhost/api/inference/frontiers/smart-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', proofStateId: 'proof-1' }),
    }));

    expect(response.status).toBe(200);
    expect(resolveSmartAmbiguityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        proofStateId: 'proof-1',
      }),
    );

    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: true,
      requestedSmartProof: expect.objectContaining({
        categories: expect.objectContaining({ ambiguityResolution: true }),
      }),
      summary: expect.objectContaining({
        targetCount: 1,
        attemptedCount: 1,
        reclassifiedCount: 1,
        promotedCount: 1,
        reclassificationCounts: {
          provider_service_selection: 1,
        },
      }),
      results: [expect.objectContaining({ proofStateId: 'proof-1', validationStatus: 'ACCEPTED' })],
      smartCallRecords: [expect.objectContaining({ id: 'call-1', patchId: 'patch-1' })],
      remainingProofStateIds: ['proof-1'],
    }));
  });

  it('모델이 없으면 400 SMART_MODEL_NOT_CONFIGURED를 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());
    normalizeSmartProofConfigMock.mockReturnValue({
      enabled: true,
      categories: { ambiguityResolution: true },
      budget: {
        maxLlmCallsPerRun: 2,
        maxInputTokensPerCall: 200,
        maxTotalTokensPerRun: 1000,
      },
    });
    getInferenceModelMock.mockReturnValue(null);

    const response = await POST(new Request('http://localhost/api/inference/frontiers/smart-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', proofStateId: 'proof-1' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'SMART_MODEL_NOT_CONFIGURED' }),
    }));
  });

  it('proofStateIds 배열이 전달되면 inArray 필터 기반으로 선택 실행해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());
    normalizeSmartProofConfigMock.mockReturnValue({
      enabled: true,
      categories: { ambiguityResolution: true },
      budget: {
        maxLlmCallsPerRun: 2,
        maxInputTokensPerCall: 200,
        maxTotalTokensPerRun: 1000,
      },
    });
    getInferenceModelMock.mockReturnValue({ model: { provider: 'openai' }, modelName: 'gpt-4o' });
    createGenerateSmartResolutionFnMock.mockReturnValue(vi.fn());
    createSmartBudgetTrackerMock.mockReturnValue({ callsUsed: 0, tokensUsed: 0 });
    canAffordSmartBudgetCallMock.mockReturnValue(true);
    recordSmartBudgetCallMock.mockReturnValue({ callsUsed: 1, tokensUsed: 18 });
    resolveSmartAmbiguityMock.mockResolvedValue({
      proofStateId: 'proof-1',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      attempted: true,
      resolved: true,
      confidence: 0.9,
      reasoning: 'resolved',
      decision: 'ACCEPTED',
      patch: null,
      validationStatus: 'ACCEPTED',
      errors: [],
      resolution: null,
      llmCallId: null,
      tokensUsed: { input: 11, output: 7 },
    });

    const response = await POST(new Request('http://localhost/api/inference/frontiers/smart-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', proofStateIds: ['proof-1', 'proof-2'] }),
    }));

    expect(response.status).toBe(200);
    expect(resolveSmartAmbiguityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ proofStateId: 'proof-1' }),
    );
  });

  it('ACCEPTED 결과에 patch metadata가 없어도 재분류 집계에 포함해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());
    normalizeSmartProofConfigMock.mockReturnValue({
      enabled: true,
      categories: { ambiguityResolution: true },
      budget: {
        maxLlmCallsPerRun: 2,
        maxInputTokensPerCall: 200,
        maxTotalTokensPerRun: 1000,
      },
    });
    getInferenceModelMock.mockReturnValue({ model: { provider: 'openai' }, modelName: 'gpt-4o' });
    createGenerateSmartResolutionFnMock.mockReturnValue(vi.fn());
    createSmartBudgetTrackerMock.mockReturnValue({ callsUsed: 0, tokensUsed: 0 });
    canAffordSmartBudgetCallMock.mockReturnValue(true);
    recordSmartBudgetCallMock.mockReturnValue({ callsUsed: 1, tokensUsed: 18 });
    resolveSmartAmbiguityMock.mockResolvedValue({
      proofStateId: 'proof-1',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      attempted: true,
      resolved: true,
      confidence: 0.9,
      reasoning: 'resolved without patch metadata',
      decision: 'ACCEPTED',
      patch: null,
      validationStatus: 'ACCEPTED',
      errors: [],
      resolution: null,
      llmCallId: null,
      tokensUsed: { input: 11, output: 7 },
    });

    const response = await POST(new Request('http://localhost/api/inference/frontiers/smart-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', proofStateId: 'proof-1' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        acceptedCount: 1,
        reclassifiedCount: 1,
        reclassificationCounts: {},
      }),
    }));
  });
});
