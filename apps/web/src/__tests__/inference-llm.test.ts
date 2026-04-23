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

    await expect(generateSmartResolution('Respond with patchType=alias_binding.\nresolve this frontier')).resolves.toMatchObject({
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

    await expect(generateSmartResolution('Respond with patchType=route_transform_patch.\nresolve this gateway frontier')).resolves.toMatchObject({
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

    await expect(generateSmartResolution('Respond with patchType=provider_service_selection.\nresolve provider ambiguity')).resolves.toMatchObject({
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

  it('smart resolution generator는 provider_service_selection 에 selectedServiceId 가 없으면 거부해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: null,
        selectedServiceName: 'order-api-b',
        confidence: 0.78,
        reasoning: 'service name and host hint both match',
        ranking: null,
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

    await expect(generateSmartResolution('Respond with patchType=provider_service_selection.\nresolve provider without selectedServiceId')).rejects.toThrow(
      'provider_service_selection requires selectedServiceId when resolved is true',
    );
  });

  it('smart resolution generator는 provider_service_selection unresolved 응답에서 selectedServiceId 없이도 허용해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: false,
        selectedServiceId: null,
        selectedServiceName: null,
        confidence: 0.42,
        reasoning: 'multiple services still plausible',
        ranking: null,
      }),
      usage: {
        inputTokens: 40,
        outputTokens: 12,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('Respond with patchType=provider_service_selection.\nresolve unresolved provider ambiguity')).resolves.toMatchObject({
      model: 'gpt-4o',
      promptTokens: 40,
      completionTokens: 12,
      object: {
        patchType: 'provider_service_selection',
        resolved: false,
      },
    });
  });

  it('smart-review provider 프롬프트는 provider 전용 schema를 사용해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: false,
        selectedServiceId: null,
        selectedServiceName: null,
        confidence: 0.51,
        reasoning: 'still ambiguous',
        ranking: null,
      }),
      usage: {
        inputTokens: 33,
        outputTokens: 11,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(
      generateSmartResolution('Respond with patchType=provider_service_selection.\nTask: choose provider'),
    ).resolves.toMatchObject({
      object: {
        patchType: 'provider_service_selection',
        resolved: false,
        selectedServiceId: null,
        selectedServiceName: null,
        ranking: null,
      },
    });

    expect(generateObjectMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'json',
      prompt: expect.stringContaining('patchType=provider_service_selection'),
    }));
  });

  it('smart-review provider 전용 schema는 ranking=null 을 허용해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: false,
        selectedServiceId: null,
        selectedServiceName: null,
        confidence: 0.51,
        reasoning: 'still ambiguous',
        ranking: null,
      }),
      usage: {
        inputTokens: 33,
        outputTokens: 11,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(
      generateSmartResolution('Respond with patchType=provider_service_selection.\nTask: choose provider'),
    ).resolves.toMatchObject({
      object: {
        patchType: 'provider_service_selection',
        ranking: null,
      },
    });
  });

  it('smart-review provider 전용 schema는 ranking 필드가 누락되면 실패해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: false,
        selectedServiceId: null,
        selectedServiceName: null,
        confidence: 0.51,
        reasoning: 'still ambiguous',
      }),
      usage: {
        inputTokens: 33,
        outputTokens: 11,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(
      generateSmartResolution('Respond with patchType=provider_service_selection.\nTask: choose provider'),
    ).rejects.toThrow('ranking');
  });

  it('smart-review provider 전용 schema도 resolved=true 이면 selectedServiceId를 요구해야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'provider_service_selection',
        resolved: true,
        selectedServiceId: null,
        selectedServiceName: 'order-api-b',
        confidence: 0.78,
        reasoning: 'service name and host hint both match',
        ranking: null,
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

    await expect(
      generateSmartResolution('Respond with patchType=provider_service_selection.\nTask: choose provider'),
    ).rejects.toThrow('provider_service_selection requires selectedServiceId when resolved is true');
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

    await expect(generateSmartResolution('Respond with patchType=provider_service_selection.\nresolve this provider ambiguity')).resolves.toMatchObject({
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

    await expect(generateSmartResolution('Respond with patchType=contradiction_challenge.\nreview this low-confidence proof')).resolves.toMatchObject({
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

  it('smart-review contradiction 프롬프트는 skip 응답에서 challengeReasons를 생략할 수 있어야 한다', async () => {
    generateObjectMock.mockImplementation(async (params: { schema: { parse: (input: unknown) => unknown } }) => ({
      object: params.schema.parse({
        patchType: 'contradiction_challenge',
        shouldChallenge: false,
        confidence: 0.41,
        reasoning: 'proof still looks acceptable',
      }),
      usage: {
        inputTokens: 39,
        outputTokens: 9,
      },
    }));

    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(
      generateSmartResolution('Respond with patchType=contradiction_challenge.\nTask: review proof'),
    ).resolves.toMatchObject({
      model: 'gpt-4o',
      object: {
        patchType: 'contradiction_challenge',
        shouldChallenge: false,
        challengeReasons: [],
        expectedAction: null,
      },
    });
  });

  it('smart-review contradiction 전용 schema는 shouldChallenge=true 이면 challengeReasons를 요구해야 한다', async () => {
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
      generateSmartResolution('Respond with patchType=contradiction_challenge.\nTask: review proof'),
    ).rejects.toThrow('contradiction_challenge requires challengeReasons when shouldChallenge is true');
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
      generateSmartResolution('Respond with patchType=contradiction_challenge.\nreview this low-confidence proof without challenge reasons'),
    ).rejects.toThrow('contradiction_challenge requires challengeReasons when shouldChallenge is true');
  });

  it('smart resolution generator는 patchType 없는 프롬프트에서 명시적 에러를 던져야 한다', async () => {
    const generateSmartResolution = createGenerateSmartResolutionFn(
      { provider: 'openai' } as never,
      'gpt-4o',
    );

    await expect(generateSmartResolution('resolve this frontier without explicit patch type')).rejects.toThrow(
      'Unsupported Smart patchType in prompt: unknown',
    );
    expect(generateObjectMock).not.toHaveBeenCalled();
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
        mergeWithCandidateId: null,
        splitSuggestions: [],
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
          topCodeFamily: null,
          topTableFamily: null,
          seedSourceSummary: [],
        },
      },
      objectNameById: new Map(),
      siblingCandidateIds: [],
    })).resolves.toEqual({
      coherent: true,
      suggestedName: '주문',
      responsibilityHint: '주문 라이프사이클을 책임한다',
      mergeWithCandidateId: null,
      splitSuggestions: [],
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
