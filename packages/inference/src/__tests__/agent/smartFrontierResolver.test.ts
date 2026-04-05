import { describe, expect, it } from 'vitest';
import {
  buildHostAliasResolutionPrompt,
  buildRouteTransformResolutionPrompt,
  buildSmartAliasBindingPatch,
  buildSmartFrontierPrompt,
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
  };
}

describe('smartFrontierResolver', () => {
  it('지원 frontier reason만 허용해야 한다', () => {
    expect(SUPPORTED_SMART_FRONTIER_REASONS).toEqual([
      'HOST_ALIAS_UNRESOLVED',
      'CONFIG_BINDING_MISSING',
      'ROUTE_FAMILY_DERIVATION_EMPTY',
      'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED',
    ]);
    expect(isSupportedSmartFrontierReason('HOST_ALIAS_UNRESOLVED')).toBe(true);
    expect(isSupportedSmartFrontierReason('CONFIG_BINDING_MISSING')).toBe(true);
    expect(isSupportedSmartFrontierReason('ROUTE_FAMILY_DERIVATION_EMPTY')).toBe(true);
    expect(isSupportedSmartFrontierReason('ROUTE_TO_ENDPOINT_COMPOSITION_FAILED')).toBe(true);
    expect(isSupportedSmartFrontierReason('ENDPOINT_MATCH_AMBIGUOUS')).toBe(false);
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

    expect(aliasPrompt).toContain('Respond with patchType=alias_binding.');
    expect(routePrompt).toContain('Respond with patchType=route_transform_patch.');
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
