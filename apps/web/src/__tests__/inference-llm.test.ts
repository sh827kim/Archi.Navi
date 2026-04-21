// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateObjectMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: generateObjectMock,
}));

import {
  createGenerateBoostSuggestionFn,
  createGenerateDomainReviewFn,
  createGenerateSemanticProfileFn,
  createGenerateSmartResolutionFn,
} from '@/lib/inference-llm';

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

  it('smart resolution generator는 provider_service_selection 응답도 그대로 변환해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: 'service-order',
        selectedServiceName: 'order-service',
        confidence: 0.89,
        reasoning: 'provider ambiguity resolved by host/config hints',
        ranking: [
          {
            serviceId: 'service-order',
            serviceName: 'order-service',
            score: 0.89,
            reasoning: 'best',
          },
        ],
      },
      usage: {
        inputTokens: 77,
        outputTokens: 19,
      },
    });

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve provider ambiguity')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 77,
      completionTokens: 19,
      object: {
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: 'service-order',
      },
    });
  });

  it('smart resolution generator는 provider_service_selection 에서 ranking 필드가 없어도 허용해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: 'service-order-b',
        selectedServiceName: 'order-api-b',
        confidence: 0.78,
        reasoning: 'service name and host hint both match',
      },
      usage: {
        inputTokens: 61,
        outputTokens: 16,
      },
    });

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve provider without ranking')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 61,
      completionTokens: 16,
      object: {
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: 'service-order-b',
      },
    });
  });

  it('smart resolution generator는 provider_service_selection 에 selectedServiceId 가 없으면 거부해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceName: 'order-api-b',
        confidence: 0.78,
        reasoning: 'service name and host hint both match',
      }),
      usage: {
        inputTokens: 61,
        outputTokens: 16,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve provider without selectedServiceId')).rejects.toThrow(
      'provider_service_selection requires selectedServiceId',
    );
  });

  it('smart resolution generator는 provider_service_selection 응답도 그대로 변환해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: 'service-order-a',
        selectedServiceName: 'order-api-a',
        confidence: 0.89,
        reasoning: 'host hint matches order-api-a more strongly',
        ranking: null,
      },
      usage: {
        inputTokens: 55,
        outputTokens: 14,
      },
    });

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve this provider ambiguity')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 55,
      completionTokens: 14,
      object: {
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: 'service-order-a',
      },
    });
  });

  it('smart resolution generator는 contradiction_challenge 응답도 그대로 변환해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'contradiction_challenge',
        shouldChallenge: true,
        confidence: 0.84,
        reasoning: 'closed proof is too weak and should be reopened',
        challengeReasons: ['LOW_CONFIDENCE_FALSE_POSITIVE'],
        expectedAction: 'reopen_frontier',
      }),
      usage: {
        inputTokens: 42,
        outputTokens: 12,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('review this low-confidence proof')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 42,
      completionTokens: 12,
      object: {
        patchType: 'contradiction_challenge',
        shouldChallenge: true,
        expectedAction: 'reopen_frontier',
      },
    });
  });

  it('smart resolution generator는 shouldChallenge=true 인 contradiction_challenge 에 challengeReasons가 없으면 실패해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'contradiction_challenge',
        shouldChallenge: true,
        confidence: 0.84,
        reasoning: 'closed proof is too weak and should be reopened',
        expectedAction: 'reopen_frontier',
      }),
      usage: {
        inputTokens: 40,
        outputTokens: 10,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(
      generateSmartResolution('review this low-confidence proof without challenge reasons'),
    ).rejects.toThrow('contradiction_challenge requires challengeReasons when shouldChallenge is true');
  });
});

describe('createGenerateDomainReviewFn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('domain review generator는 mergeWithCandidateId 가 없어도 null 로 정규화해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        coherent: true,
        suggestedName: '주문',
        responsibilityHint: '주문 라이프사이클을 책임한다',
      },
    });

    const generateDomainReview = createGenerateDomainReviewFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateDomainReview('review this candidate', {
      candidate: {
        slug: 'orders',
        autoName: 'Orders',
        members: [],
        signals: {
          topPathPrefix: 'orders',
          topRoutePrefix: '/orders',
          topTopicPrefix: null,
        },
      },
      objectNameById: new Map(),
      siblingCandidateIds: [],
    })).resolves.toEqual({
      coherent: true,
      suggestedName: '주문',
      responsibilityHint: '주문 라이프사이클을 책임한다',
      mergeWithCandidateId: null,
    });
  });
});

describe('createGenerateSemanticProfileFn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('semantic profile generator는 invariant.failureMode 가 없어도 null 로 정규화해야 한다', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        responsibility: '주문 도메인 책임',
        state: [],
        actions: [],
        invariants: [
          {
            description: '주문 수량은 1 이상이어야 한다',
            evidenceIds: ['ev-1'],
          },
        ],
        events: [],
        collaborators: [],
        scenarios: [],
      },
    });

    const generateSemanticProfile = createGenerateSemanticProfileFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSemanticProfile('compose semantic profile', {
      workspaceId: 'ws-1',
      llmModel: 'gpt-4o',
      signals: {
        domainId: 'dom-1',
        domainName: '주문',
        members: [],
        actions: [],
        events: [],
        collaborators: [],
        dbAccesses: [],
        evidence: [],
      },
      scenarios: [],
    })).resolves.toMatchObject({
      invariants: [
        {
          description: '주문 수량은 1 이상이어야 한다',
          failureMode: null,
          evidenceIds: ['ev-1'],
        },
      ],
    });
  });
});
