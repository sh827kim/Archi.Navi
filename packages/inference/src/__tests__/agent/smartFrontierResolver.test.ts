import { describe, expect, it } from 'vitest';
import { SMART_FRONTIER_RESOLUTION_REASONS_SUPPORTED } from '@/agent/smartProofTypes';
import {
  buildEndpointDisambiguationPrompt,
  buildHostAliasResolutionPrompt,
  buildMethodPathHintPrompt,
  buildRouteTransformResolutionPrompt,
  buildSmartAliasBindingPatch,
  buildSmartEndpointDisambiguationPatch,
  buildSmartFrontierPrompt,
  buildSmartMethodPathHintPatch,
  buildSmartPatchFromProposal,
  buildSmartRouteTransformPatch,
  isSupportedSmartFrontierReason,
  SUPPORTED_SMART_FRONTIER_REASONS,
  type SmartFrontierResolutionContext,
} from '@/agent/smartFrontierResolver';

function createContext(): SmartFrontierResolutionContext {
  return {
    workspaceId: 'ws-1',
    proofStateId: 'proof-1',
    frontierReason: 'HOST_ALIAS_UNRESOLVED',
    sourceServiceId: 'service-consumer',
    intent: {
      type: 'http_call',
      sourceService: 'gateway-service',
      methodHint: 'GET',
      pathHint: '/api/orders/{id}',
      hostHint: 'ORDER_API',
      configKeys: ['clients.order.base-url'],
      targetServiceHint: 'order-service',
      providerHint: 'order-service',
      gatewayKind: 'spring_cloud_gateway',
      externalRoutePattern: '/api/orders/**',
    },
    proofState: {
      currentSlots: {},
      frontierDetail: {},
    },
    availableServices: [
      { id: 'service-order', name: 'order-service', endpointCount: 12 },
      { id: 'service-payment', name: 'payment-service', endpointCount: 8 },
    ],
    aliasBindings: [
      { key: 'clients.payment.base-url', value: 'PAYMENT_API', resolvedService: 'payment-service' },
    ],
    candidateEndpoints: [
      {
        id: 'endpoint-order-get',
        name: 'GET /api/orders/{id}',
        method: 'GET',
        path: '/api/orders/{id}',
        serviceId: 'service-order',
        serviceName: 'order-service',
      },
    ],
  };
}

describe('smartFrontierResolver', () => {
  it('지원 frontier reason만 허용해야 한다', () => {
    expect(SUPPORTED_SMART_FRONTIER_REASONS).toEqual(SMART_FRONTIER_RESOLUTION_REASONS_SUPPORTED);
    expect(isSupportedSmartFrontierReason('HOST_ALIAS_UNRESOLVED')).toBe(true);
    expect(isSupportedSmartFrontierReason('CONFIG_BINDING_MISSING')).toBe(true);
    expect(isSupportedSmartFrontierReason('ROUTE_FAMILY_DERIVATION_EMPTY')).toBe(true);
    expect(isSupportedSmartFrontierReason('ROUTE_TO_ENDPOINT_COMPOSITION_FAILED')).toBe(true);
    expect(isSupportedSmartFrontierReason('PATH_TEMPLATE_UNKNOWN')).toBe(true);
    expect(isSupportedSmartFrontierReason('METHOD_UNKNOWN')).toBe(true);
    expect(isSupportedSmartFrontierReason('PROVIDER_ENDPOINT_NOT_FOUND')).toBe(true);
    expect(isSupportedSmartFrontierReason('ENDPOINT_MATCH_AMBIGUOUS')).toBe(true);
    expect(isSupportedSmartFrontierReason('PROVIDER_SERVICE_AMBIGUOUS')).toBe(false);
  });

  it('host alias prompt는 핵심 frontier 문맥을 포함해야 한다', () => {
    const prompt = buildHostAliasResolutionPrompt(createContext());

    expect(prompt).toContain('Frontier reason: HOST_ALIAS_UNRESOLVED');
    expect(prompt).toContain('Source service: gateway-service');
    expect(prompt).toContain('Host hint: ORDER_API');
    expect(prompt).toContain('clients.order.base-url');
    expect(prompt).toContain('order-service');
    expect(prompt).toContain('payment-service');
  });

  it('alias binding proposal은 smart_agent patch로 변환되어야 한다', () => {
    const patch = buildSmartAliasBindingPatch(createContext(), {
      patchType: 'alias_binding',
      resolved: true,
      selectedServiceId: 'service-order',
      selectedServiceName: 'order-service',
      confidence: 0.88,
      reasoning: 'config key and host hint both match order service',
      aliasBinding: {
        aliasKey: 'clients.order.base-url',
        aliasValue: 'ORDER_API',
        bindingKind: 'property_alias',
      },
    });

    expect(patch).toMatchObject({
      patchType: 'alias_binding',
      sourceKind: 'smart_agent',
      payload: {
        ownerServiceId: 'service-consumer',
        bindingKind: 'property_alias',
        aliasKey: 'clients.order.base-url',
        aliasValue: 'ORDER_API',
        resolvedServiceId: 'service-order',
        confidence: 0.88,
      },
    });
  });

  it('route transform prompt는 gateway frontier 문맥을 포함해야 한다', () => {
    const prompt = buildRouteTransformResolutionPrompt({
      ...createContext(),
      frontierReason: 'ROUTE_FAMILY_DERIVATION_EMPTY',
    });

    expect(prompt).toContain('Frontier reason: ROUTE_FAMILY_DERIVATION_EMPTY');
    expect(prompt).toContain('Respond with patchType=route_transform_patch.');
    expect(prompt).toContain('Gateway kind: spring_cloud_gateway');
    expect(prompt).toContain('Match path hint: /api/orders/**');
  });

  it('dispatcher는 frontier reason에 맞는 prompt를 선택해야 한다', () => {
    const aliasPrompt = buildSmartFrontierPrompt(createContext());
    const routePrompt = buildSmartFrontierPrompt({
      ...createContext(),
      frontierReason: 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED',
    });
    const endpointPrompt = buildSmartFrontierPrompt({
      ...createContext(),
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
    });
    const methodPrompt = buildSmartFrontierPrompt({
      ...createContext(),
      frontierReason: 'METHOD_UNKNOWN',
    });

    expect(aliasPrompt).toContain('Respond with patchType=alias_binding.');
    expect(routePrompt).toContain('Respond with patchType=route_transform_patch.');
    expect(endpointPrompt).toContain('Respond with patchType=endpoint_disambiguation.');
    expect(methodPrompt).toContain('Respond with patchType=method_path_hint.');
  });

  it('PATH_TEMPLATE_UNKNOWN은 gateway route가 아니면 method_path_hint 흐름을 유지해야 한다', () => {
    const prompt = buildSmartFrontierPrompt({
      ...createContext(),
      frontierReason: 'PATH_TEMPLATE_UNKNOWN',
      intent: {
        ...createContext().intent,
        type: 'http_call',
      },
    });

    expect(prompt).toContain('Respond with patchType=method_path_hint.');
    expect(prompt).not.toContain('Respond with patchType=route_transform_patch.');
  });

  it('endpoint disambiguation prompt는 candidate endpoint 문맥을 포함해야 한다', () => {
    const prompt = buildEndpointDisambiguationPrompt({
      ...createContext(),
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
    });

    expect(prompt).toContain('Frontier reason: ENDPOINT_MATCH_AMBIGUOUS');
    expect(prompt).toContain('Respond with patchType=endpoint_disambiguation.');
    expect(prompt).toContain('endpoint-order-get');
    expect(prompt).toContain('/api/orders/{id}');
  });

  it('method path hint prompt는 method/path 추론 문맥을 포함해야 한다', () => {
    const prompt = buildMethodPathHintPrompt({
      ...createContext(),
      frontierReason: 'METHOD_UNKNOWN',
    });

    expect(prompt).toContain('Frontier reason: METHOD_UNKNOWN');
    expect(prompt).toContain('Respond with patchType=method_path_hint.');
    expect(prompt).toContain('Current path hint: /api/orders/{id}');
  });

  it('route transform proposal은 smart_agent patch로 변환되어야 한다', () => {
    const patch = buildSmartRouteTransformPatch(
      {
        ...createContext(),
        frontierReason: 'ROUTE_FAMILY_DERIVATION_EMPTY',
      },
      {
        patchType: 'route_transform_patch',
        resolved: true,
        confidence: 0.84,
        reasoning: 'gateway route should be forwarded to order-service',
        routeTransform: {
          gatewayKind: 'spring_cloud_gateway',
          matchPath: '/api/orders/**',
          targetServiceHint: 'order-service',
          targetHostAlias: 'ORDER_API',
          priority: 120,
        },
      },
    );

    expect(patch).toMatchObject({
      patchType: 'route_transform_patch',
      sourceKind: 'smart_agent',
      payload: {
        ownerServiceId: 'service-consumer',
        gatewayKind: 'spring_cloud_gateway',
        matchPath: '/api/orders/**',
        targetServiceHint: 'order-service',
        targetHostAlias: 'ORDER_API',
        priority: 120,
      },
    });
  });

  it('endpoint disambiguation proposal은 smart_agent patch로 변환되어야 한다', () => {
    const patch = buildSmartEndpointDisambiguationPatch(
      {
        ...createContext(),
        frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      },
      {
        patchType: 'endpoint_disambiguation',
        resolved: true,
        confidence: 0.87,
        reasoning: 'exact endpoint match',
        endpointSelection: {
          endpointId: 'endpoint-order-get',
          method: 'GET',
          path: '/api/orders/{id}',
        },
      },
    );

    expect(patch).toMatchObject({
      patchType: 'endpoint_disambiguation',
      sourceKind: 'smart_agent',
      payload: {
        endpointId: 'endpoint-order-get',
        method: 'GET',
        path: '/api/orders/{id}',
      },
    });
  });

  it('method path hint proposal은 smart_agent patch로 변환되어야 한다', () => {
    const patch = buildSmartMethodPathHintPatch(
      {
        ...createContext(),
        frontierReason: 'METHOD_UNKNOWN',
      },
      {
        patchType: 'method_path_hint',
        resolved: true,
        confidence: 0.8,
        reasoning: 'inferred from route shape',
        methodPathHint: {
          method: 'GET',
          externalPath: '/api/orders/{id}',
        },
      },
    );

    expect(patch).toMatchObject({
      patchType: 'method_path_hint',
      sourceKind: 'smart_agent',
      payload: {
        method: 'GET',
        externalPath: '/api/orders/{id}',
      },
    });
  });

  it('proposal adapter는 frontier reason과 patch type이 맞지 않으면 null 이어야 한다', () => {
    const patch = buildSmartPatchFromProposal(createContext(), {
      patchType: 'route_transform_patch',
      resolved: true,
      confidence: 0.8,
      reasoning: 'mismatched patch type',
      routeTransform: {
        gatewayKind: 'spring_cloud_gateway',
        matchPath: '/api/orders/**',
        targetServiceHint: 'order-service',
        targetHostAlias: null,
        priority: 100,
      },
    });

    expect(patch).toBeNull();
  });
});
