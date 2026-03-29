// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  getDbMock,
  executeSmartPipelineMock,
  createInferenceRunMock,
  getInferenceRunDetailMock,
  getSmartInferenceRunDetailMock,
  executeQueuedSmartInferenceRunMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  executeSmartPipelineMock: vi.fn(),
  createInferenceRunMock: vi.fn(),
  getInferenceRunDetailMock: vi.fn(),
  getSmartInferenceRunDetailMock: vi.fn(),
  executeQueuedSmartInferenceRunMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => () => ({ provider: 'openai' })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => () => ({ provider: 'anthropic' })),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => () => ({ provider: 'google' })),
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
    executeSmartPipeline: executeSmartPipelineMock,
    createInferenceRun: createInferenceRunMock,
    getInferenceRunDetail: getInferenceRunDetailMock,
  };
});

vi.mock('@/lib/smart-inference-runs', () => ({
  getSmartInferenceRunDetail: getSmartInferenceRunDetailMock,
  executeQueuedSmartInferenceRun: executeQueuedSmartInferenceRunMock,
}));

import { GET, POST } from '@/app/api/inference/smart/route';

describe('POST /api/inference/smart', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
    delete process.env['AI_PROVIDER'];
  });

  it('선택된 provider 의 API 키가 없으면 LLM_NOT_CONFIGURED 를 반환해야 한다', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-key-only';

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-provider': 'anthropic',
      },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'LLM_NOT_CONFIGURED' },
    });
  });

  it('성공 시 프론트가 바로 사용할 수 있는 summary 필드를 함께 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-route-'));
    process.env['OPENAI_API_KEY'] = 'test-key';
    getDbMock.mockResolvedValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    });
    executeSmartPipelineMock.mockResolvedValue({
      phase1: {
        openApi: { imported: 1, failed: 0, importedServices: ['orders'] },
        bootstrapEndpointCount: 2,
      },
      phase2: {
        analyzedServiceCount: 2,
        compoundDependencyCount: 3,
        consumerServiceIds: ['svc-a'],
        servicePairCount: 3,
      },
      phase3: {
        analysisMode: 'agent_assisted',
        analyzedServiceCount: 4,
        endpointCallCount: 5,
        candidateCount: 6,
        atomicCandidateCount: 4,
        serviceFallbackCount: 2,
        deepInspectionCount: 2,
        agentEscalatedPairCount: 2,
        agentRecoveredAtomicCount: 1,
        agentFailedPairCount: 1,
        agentToolUsageSummary: {
          searchCalls: 3,
          readCalls: 2,
          endpointListCalls: 2,
          totalCalls: 7,
        },
        deepInspectionTrace: {
          attemptedCount: 2,
          failureCount: 1,
          triggerBreakdown: {
            lowConfidence: 1,
            insufficientContext: 1,
          },
          details: [
            {
              consumerServiceName: 'gateway',
              providerServiceName: 'orders',
              trigger: {
                lowConfidence: true,
                insufficientContext: false,
              },
              status: 'succeeded',
              fallbackReasons: ['PATH_NOT_MATCHED'],
              toolUsage: {
                searchCalls: 2,
                readCalls: 1,
                endpointListCalls: 1,
                totalCalls: 4,
              },
              recoveredCalls: [
                {
                  httpMethod: 'GET',
                  path: '/api/orders/{id}',
                },
              ],
            },
          ],
        },
        fallbackReasonBreakdown: {
          NO_ENDPOINT_OBJECTS: 1,
          PATH_NOT_MATCHED: 1,
          METHOD_NOT_MATCHED: 0,
          INSUFFICIENT_CONTEXT: 0,
        },
      },
      totalDurationMs: 123,
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-provider': 'openai',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        useServiceMetadataPaths: false,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        analysisMode: 'agent_assisted',
        bootstrapEndpointCount: 2,
        servicePairCount: 3,
        atomicCandidateCount: 4,
        serviceFallbackCount: 2,
        deepInspectionCount: 2,
        agentEscalatedPairCount: 2,
        agentRecoveredAtomicCount: 1,
        agentFailedPairCount: 1,
        agentToolUsageSummary: {
          searchCalls: 3,
          readCalls: 2,
          endpointListCalls: 2,
          totalCalls: 7,
        },
        deepInspectionTrace: {
          attemptedCount: 2,
          failureCount: 1,
          triggerBreakdown: {
            lowConfidence: 1,
            insufficientContext: 1,
          },
          details: [
            {
              consumerServiceName: 'gateway',
              providerServiceName: 'orders',
              trigger: {
                lowConfidence: true,
                insufficientContext: false,
              },
              status: 'succeeded',
              fallbackReasons: ['PATH_NOT_MATCHED'],
              toolUsage: {
                searchCalls: 2,
                readCalls: 1,
                endpointListCalls: 1,
                totalCalls: 4,
              },
              recoveredCalls: [
                {
                  httpMethod: 'GET',
                  path: '/api/orders/{id}',
                },
              ],
            },
          ],
        },
        fallbackReasonBreakdown: {
          NO_ENDPOINT_OBJECTS: 1,
          PATH_NOT_MATCHED: 1,
          METHOD_NOT_MATCHED: 0,
          INSUFFICIENT_CONTEXT: 0,
        },
        candidatesCreated: 6,
        phase2Count: 2,
        phase3Count: 4,
      },
      data: {
        summary: {
          analysisMode: 'agent_assisted',
          bootstrapEndpointCount: 2,
          servicePairCount: 3,
          atomicCandidateCount: 4,
          serviceFallbackCount: 2,
          deepInspectionCount: 2,
          agentEscalatedPairCount: 2,
          agentRecoveredAtomicCount: 1,
          agentFailedPairCount: 1,
          agentToolUsageSummary: {
            searchCalls: 3,
            readCalls: 2,
            endpointListCalls: 2,
            totalCalls: 7,
          },
          deepInspectionTrace: {
            attemptedCount: 2,
            failureCount: 1,
            triggerBreakdown: {
              lowConfidence: 1,
              insufficientContext: 1,
            },
            details: [
              {
                consumerServiceName: 'gateway',
                providerServiceName: 'orders',
                trigger: {
                  lowConfidence: true,
                  insufficientContext: false,
                },
                status: 'succeeded',
                fallbackReasons: ['PATH_NOT_MATCHED'],
                toolUsage: {
                  searchCalls: 2,
                  readCalls: 1,
                  endpointListCalls: 1,
                  totalCalls: 4,
                },
                recoveredCalls: [
                  {
                    httpMethod: 'GET',
                    path: '/api/orders/{id}',
                  },
                ],
              },
            ],
          },
          fallbackReasonBreakdown: {
            NO_ENDPOINT_OBJECTS: 1,
            PATH_NOT_MATCHED: 1,
            METHOD_NOT_MATCHED: 0,
            INSUFFICIENT_CONTEXT: 0,
          },
          candidatesCreated: 6,
          phase2Count: 2,
          phase3Count: 4,
        },
      },
    });
    expect(executeSmartPipelineMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        atomicAnalysisMode: 'pair_pack',
        generateAgentStep: expect.any(Function),
      }),
    );
  });

  it('새 observability 필드가 없더라도 summary 에 기본값을 안전하게 채워야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-route-defaults-'));
    process.env['OPENAI_API_KEY'] = 'test-key';
    getDbMock.mockResolvedValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    });
    executeSmartPipelineMock.mockResolvedValue({
      phase1: {
        openApi: { imported: 1, failed: 0, importedServices: ['orders'] },
      },
      phase2: {
        analyzedServiceCount: 1,
        compoundDependencyCount: 1,
        consumerServiceIds: ['svc-a'],
      },
      phase3: {
        analyzedServiceCount: 1,
        endpointCallCount: 1,
        candidateCount: 1,
      },
      totalDurationMs: 25,
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-provider': 'openai',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        useServiceMetadataPaths: false,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        analysisMode: 'pair_pack',
        bootstrapEndpointCount: 0,
        servicePairCount: 0,
        atomicCandidateCount: 0,
        serviceFallbackCount: 0,
        deepInspectionCount: 0,
        agentEscalatedPairCount: 0,
        agentRecoveredAtomicCount: 0,
        agentFailedPairCount: 0,
        agentToolUsageSummary: {
          searchCalls: 0,
          readCalls: 0,
          endpointListCalls: 0,
          totalCalls: 0,
        },
        deepInspectionTrace: {
          attemptedCount: 0,
          failureCount: 0,
          triggerBreakdown: {
            lowConfidence: 0,
            insufficientContext: 0,
          },
          details: [],
        },
        fallbackReasonBreakdown: {
          NO_ENDPOINT_OBJECTS: 0,
          PATH_NOT_MATCHED: 0,
          METHOD_NOT_MATCHED: 0,
          INSUFFICIENT_CONTEXT: 0,
        },
        candidatesCreated: 1,
        phase2Count: 1,
        phase3Count: 1,
      },
    });
  });

  it('deepInspectionTrace detail status 의 no_result 를 그대로 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-route-no-result-'));
    process.env['OPENAI_API_KEY'] = 'test-key';
    getDbMock.mockResolvedValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    });
    executeSmartPipelineMock.mockResolvedValue({
      phase1: {
        openApi: { imported: 1, failed: 0, importedServices: ['orders'] },
      },
      phase2: {
        analyzedServiceCount: 1,
        compoundDependencyCount: 1,
        consumerServiceIds: ['svc-a'],
        servicePairCount: 1,
      },
      phase3: {
        analyzedServiceCount: 1,
        endpointCallCount: 0,
        candidateCount: 0,
        deepInspectionCount: 1,
        deepInspectionTrace: {
          attemptedCount: 1,
          failureCount: 0,
          triggerBreakdown: {
            lowConfidence: 1,
            insufficientContext: 0,
          },
          details: [
            {
              consumerServiceName: 'gateway',
              providerServiceName: 'orders',
              trigger: {
                lowConfidence: true,
                insufficientContext: false,
              },
              status: 'no_result',
              fallbackReasons: ['INSUFFICIENT_CONTEXT'],
              toolUsage: {
                searchCalls: 1,
                readCalls: 1,
                endpointListCalls: 1,
                totalCalls: 3,
              },
              recoveredCall: null,
            },
          ],
        },
      },
      totalDurationMs: 40,
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-provider': 'openai',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        useServiceMetadataPaths: false,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        deepInspectionTrace: {
          details: [
            {
              consumerServiceName: 'gateway',
              providerServiceName: 'orders',
              status: 'no_result',
            },
          ],
        },
      },
      data: {
        summary: {
          deepInspectionTrace: {
            details: [
              {
                consumerServiceName: 'gateway',
                providerServiceName: 'orders',
                status: 'no_result',
              },
            ],
          },
        },
      },
    });
  });

  it('async=true 이면 smart run을 큐잉하고 202를 반환해야 한다', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'smart-route-async-'));
    process.env['OPENAI_API_KEY'] = 'test-key';
    getDbMock.mockResolvedValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    });
    createInferenceRunMock.mockResolvedValue({
      id: 'smart-run-1',
      status: 'QUEUED',
    });
    executeQueuedSmartInferenceRunMock.mockResolvedValue(undefined);
    getInferenceRunDetailMock.mockResolvedValue({
      run: {
        id: 'smart-run-1',
        status: 'QUEUED',
      },
      sources: [],
      events: [],
    });

    const response = await POST(new Request('http://localhost/api/inference/smart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-provider': 'openai',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        repoRoots: [repoRoot],
        useServiceMetadataPaths: false,
        async: true,
        analysisMode: 'full_agent',
      }),
    }));

    expect(response.status).toBe(202);
    expect(createInferenceRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        triggerType: 'SMART_PIPELINE',
        modes: ['config', 'code'],
        sources: [{ type: 'local', ref: repoRoot }],
      }),
    );
    expect(executeQueuedSmartInferenceRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        runId: 'smart-run-1',
        repoRoots: [repoRoot],
        analysisMode: 'full_agent',
        generateAgentStep: expect.any(Function),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      queued: true,
      runId: 'smart-run-1',
    });
  });

  it('GET 상태 조회는 smart run summary를 반환해야 한다', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    getDbMock.mockResolvedValue({});
    getSmartInferenceRunDetailMock.mockResolvedValue({
      detail: {
        run: {
          id: 'smart-run-1',
          triggerType: 'SMART_PIPELINE',
          status: 'SUCCEEDED',
          stats: {
            smartSummary: {
              candidatesCreated: 3,
              phase2Count: 1,
              phase3Count: 2,
            },
          },
        },
        sources: [],
        events: [],
      },
      summary: {
        candidatesCreated: 3,
        phase2Count: 1,
        phase3Count: 2,
      },
    });

    const response = await GET(
      new Request('http://localhost/api/inference/smart?workspaceId=ws-1&runId=smart-run-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        candidatesCreated: 3,
        phase2Count: 1,
        phase3Count: 2,
      },
      run: {
        id: 'smart-run-1',
        status: 'SUCCEEDED',
      },
    });
  });
});
