// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { POST } from '@/app/api/inference/smart/route';

describe('POST /api/inference/smart', () => {
  afterEach(() => {
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
});
