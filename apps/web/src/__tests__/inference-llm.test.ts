// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: generateObjectMock,
}));

import { createGenerateBoostSuggestionFn } from '@/lib/inference-llm';

describe('createGenerateBoostSuggestionFn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('모델이 null 을 반환하면 정상적으로 skip 처리한다', async () => {
    generateObjectMock.mockResolvedValue({ object: null });

    const generateBoostSuggestion = createGenerateBoostSuggestionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(
      generateBoostSuggestion({
        callerServiceId: 'svc-a',
        callerServiceName: 'ServiceA',
        filePath: 'src/a.ts',
        excerpt: 'foo()',
        calleeSymbol: 'foo',
        candidateServices: ['ServiceB'],
      }),
    ).resolves.toBeNull();
  });
});
