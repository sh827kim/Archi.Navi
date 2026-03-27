// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  filterCandidatesMock,
  generateCandidateExplanationsMock,
  generateObjectMock,
  createOpenAIMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  filterCandidatesMock: vi.fn(),
  generateCandidateExplanationsMock: vi.fn(),
  generateObjectMock: vi.fn(),
  createOpenAIMock: vi.fn(() => vi.fn(() => ({ provider: 'openai-model' }))),
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@archi-navi/inference', () => ({
  filterCandidates: filterCandidatesMock,
  generateCandidateExplanations: generateCandidateExplanationsMock,
}));

vi.mock('ai', () => ({
  generateObject: generateObjectMock,
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((modelName: string) => ({ provider: 'openai', modelName })),
  createOpenAI: createOpenAIMock,
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((modelName: string) => ({ provider: 'anthropic', modelName })),
  createAnthropic: vi.fn(() => vi.fn((modelName: string) => ({ provider: 'anthropic', modelName }))),
}));

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn((modelName: string) => ({ provider: 'google', modelName })),
  createGoogleGenerativeAI: vi.fn(() => vi.fn((modelName: string) => ({ provider: 'google', modelName }))),
}));

import { POST } from '@/app/api/inference/llm-filter/route';

describe('POST /api/inference/llm-filter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['OPENAI_API_KEY'];
    delete process.env['AI_PROVIDER'];
  });

  it('C1: generateExplanations=true 요청을 설명 생성 경로로 수용해야 한다', async () => {
    getDbMock.mockResolvedValue({ kind: 'db' });
    generateCandidateExplanationsMock.mockResolvedValue({
      processedCandidateCount: 2,
      generatedCount: 2,
      skippedCount: 0,
      callCount: 1,
      durationMs: 10,
    });

    const response = await POST(new Request('http://localhost/api/inference/llm-filter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-provider': 'openai',
        'x-ai-api-key': 'test-key',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        candidateIds: ['cand-1', 'cand-2'],
        generateExplanations: true,
        maxCalls: 3,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        processedCandidateCount: 2,
        generatedCount: 2,
        skippedCount: 0,
        callCount: 1,
        durationMs: 10,
      },
    });
    expect(generateCandidateExplanationsMock).toHaveBeenCalledTimes(1);
    expect(filterCandidatesMock).not.toHaveBeenCalled();
  });

  it('C5: generateExplanations=false 면 모델 설정 없이도 LLM 호출 없이 종료해야 한다', async () => {
    getDbMock.mockResolvedValue({ kind: 'db' });
    generateCandidateExplanationsMock.mockResolvedValue({
      processedCandidateCount: 0,
      generatedCount: 0,
      skippedCount: 0,
      callCount: 0,
      durationMs: 1,
    });

    const response = await POST(new Request('http://localhost/api/inference/llm-filter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        generateExplanations: false,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        processedCandidateCount: 0,
        generatedCount: 0,
        skippedCount: 0,
        callCount: 0,
        durationMs: 1,
      },
    });
    expect(generateCandidateExplanationsMock).toHaveBeenCalledTimes(1);
    expect(filterCandidatesMock).not.toHaveBeenCalled();
    expect(generateObjectMock).not.toHaveBeenCalled();
  });
});
