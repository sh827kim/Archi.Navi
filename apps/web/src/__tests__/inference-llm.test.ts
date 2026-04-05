// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: generateObjectMock,
}));

import { createGenerateBoostSuggestionFn, createGenerateSmartResolutionFn } from '@/lib/inference-llm';

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

  it('smart resolution generator는 구조화 결과와 usage를 inference 형식으로 변환해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        patchType: 'alias_binding',
        resolved: true,
        selectedServiceId: 'service-order',
        selectedServiceName: 'order-service',
        confidence: 0.91,
        reasoning: 'config key points to order service',
        aliasBinding: {
          aliasKey: 'clients.order.base-url',
          aliasValue: 'ORDER_API',
          bindingKind: 'property_alias',
        },
      },
      usage: {
        inputTokens: 123,
        outputTokens: 45,
      },
    });

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve this frontier')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 123,
      completionTokens: 45,
      object: {
        resolved: true,
        selectedServiceId: 'service-order',
      },
    });
  });

  it('smart resolution generator는 route_transform_patch 응답도 그대로 변환해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        patchType: 'route_transform_patch',
        resolved: true,
        confidence: 0.87,
        reasoning: 'gateway route should target orders-service',
        routeTransform: {
          gatewayKind: 'zuul',
          matchPath: '/api/orders/**',
          targetServiceHint: 'orders-service',
          targetHostAlias: 'orders-service',
          priority: 120,
        },
      },
      usage: {
        inputTokens: 88,
        outputTokens: 21,
      },
    });

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve this gateway frontier')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 88,
      completionTokens: 21,
      object: {
        patchType: 'route_transform_patch',
        resolved: true,
        routeTransform: {
          gatewayKind: 'zuul',
          matchPath: '/api/orders/**',
        },
      },
    });
  });
});
