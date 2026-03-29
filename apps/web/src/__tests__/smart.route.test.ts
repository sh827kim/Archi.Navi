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
      phase1: { openApi: { imported: 1, failed: 0, importedServices: ['orders'] } },
      phase2: {
        analyzedServiceCount: 2,
        compoundDependencyCount: 3,
        consumerServiceIds: ['svc-a'],
      },
      phase3: {
        analyzedServiceCount: 4,
        endpointCallCount: 5,
        candidateCount: 6,
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
        candidatesCreated: 6,
        phase2Count: 2,
        phase3Count: 4,
      },
      data: {
        summary: {
          candidatesCreated: 6,
          phase2Count: 2,
          phase3Count: 4,
        },
      },
    });
  });
});
