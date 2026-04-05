import { describe, expect, it } from 'vitest';
import {
  buildProviderServiceSelectionPrompt,
  buildSmartProviderServiceSelectionPatch,
  isSupportedSmartAmbiguityReason,
  SUPPORTED_SMART_AMBIGUITY_REASONS,
  type SmartAmbiguityResolutionContext,
} from '@/agent/smartAmbiguityResolver';

function createContext(): SmartAmbiguityResolutionContext {
  return {
    workspaceId: 'ws-1',
    proofStateId: 'proof-1',
    frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
    sourceServiceId: 'service-consumer',
    intent: {
      type: 'http_call',
      sourceService: 'gateway-service',
      methodHint: 'GET',
      pathHint: '/api/orders/123',
      hostHint: 'ORDER_API',
      configKeys: ['clients.order.base-url'],
    },
    proofState: {
      currentSlots: {},
      frontierDetail: {
        candidateProviderIds: ['service-order-a', 'service-order-b'],
      },
    },
    candidateServices: [
      { id: 'service-order-a', name: 'order-api-a', endpointCount: 12 },
      { id: 'service-order-b', name: 'order-api-b', endpointCount: 8 },
    ],
  };
}

describe('smartAmbiguityResolver', () => {
  it('지원 ambiguity reason만 허용해야 한다', () => {
    expect(SUPPORTED_SMART_AMBIGUITY_REASONS).toEqual(['PROVIDER_SERVICE_AMBIGUOUS']);
    expect(isSupportedSmartAmbiguityReason('PROVIDER_SERVICE_AMBIGUOUS')).toBe(true);
    expect(isSupportedSmartAmbiguityReason('ENDPOINT_MATCH_AMBIGUOUS')).toBe(false);
  });

  it('provider service selection prompt는 핵심 ambiguity 문맥을 포함해야 한다', () => {
    const prompt = buildProviderServiceSelectionPrompt(createContext());

    expect(prompt).toContain('Frontier reason: PROVIDER_SERVICE_AMBIGUOUS');
    expect(prompt).toContain('Respond with patchType=provider_service_selection.');
    expect(prompt).toContain('gateway-service');
    expect(prompt).toContain('clients.order.base-url');
    expect(prompt).toContain('service-order-a');
    expect(prompt).toContain('order-api-b');
  });

  it('provider service proposal은 smart_agent patch로 변환되어야 한다', () => {
    const patch = buildSmartProviderServiceSelectionPatch({
      patchType: 'provider_service_selection',
      resolved: true,
      selectedServiceId: 'service-order-a',
      selectedServiceName: 'order-api-a',
      confidence: 0.88,
      reasoning: 'alias and path hint more strongly match order-api-a',
      ranking: null,
    });

    expect(patch).toMatchObject({
      patchType: 'provider_service_selection',
      sourceKind: 'smart_agent',
      payload: {
        selectedServiceId: 'service-order-a',
        confidence: 0.88,
      },
    });
  });
});
