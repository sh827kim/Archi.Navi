// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  getDbMock,
  executeSmartPipelineMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  executeSmartPipelineMock: vi.fn(),
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
  };
});

import { POST } from '@/app/api/inference/smart/route';

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
        analyzedServiceCount: 4,
        endpointCallCount: 5,
        candidateCount: 6,
        atomicCandidateCount: 4,
        serviceFallbackCount: 2,
        deepInspectionCount: 2,
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
              recoveredCall: {
                httpMethod: 'GET',
                path: '/api/orders/{id}',
              },
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
        bootstrapEndpointCount: 2,
        servicePairCount: 3,
        atomicCandidateCount: 4,
        serviceFallbackCount: 2,
        deepInspectionCount: 2,
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
              recoveredCall: {
                httpMethod: 'GET',
                path: '/api/orders/{id}',
              },
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
          bootstrapEndpointCount: 2,
          servicePairCount: 3,
          atomicCandidateCount: 4,
          serviceFallbackCount: 2,
          deepInspectionCount: 2,
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
                recoveredCall: {
                  httpMethod: 'GET',
                  path: '/api/orders/{id}',
                },
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
        bootstrapEndpointCount: 0,
        servicePairCount: 0,
        atomicCandidateCount: 0,
        serviceFallbackCount: 0,
        deepInspectionCount: 0,
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
});
