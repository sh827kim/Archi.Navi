import { describe, expect, it } from 'vitest';
import { SMART_CORRELATION_REASONS_SUPPORTED } from '@/agent/smartProofTypes';
import {
  buildSmartCorrelationPrompt,
  isSupportedSmartCorrelationReason,
  SUPPORTED_SMART_CORRELATION_REASONS,
  type SmartCorrelationFrontierGroup,
} from '@/agent/smartCorrelationResolver';

function createGroup(): SmartCorrelationFrontierGroup {
  return {
    groupKey: 'service-consumer::order_service::client.orders.url',
    ownerServiceId: 'service-consumer',
    sourceServiceName: 'api-gateway',
    normalizedHostHints: ['order_service'],
    normalizedConfigKeys: ['client.orders.url'],
    proofStateIds: ['proof-1', 'proof-2'],
    intentIds: ['intent-1', 'intent-2'],
    reasons: ['HOST_ALIAS_UNRESOLVED', 'CONFIG_BINDING_MISSING'],
    representativeProofStateId: 'proof-1',
    representativeIntentId: 'intent-1',
    representativeHostHints: ['ORDER_SERVICE'],
    representativeConfigKeys: ['client.orders.url'],
  };
}

describe('smartCorrelationResolver', () => {
  it('지원 correlation reason만 허용해야 한다', () => {
    expect(SUPPORTED_SMART_CORRELATION_REASONS).toEqual(SMART_CORRELATION_REASONS_SUPPORTED);
    expect(isSupportedSmartCorrelationReason('HOST_ALIAS_UNRESOLVED')).toBe(true);
    expect(isSupportedSmartCorrelationReason('CONFIG_BINDING_MISSING')).toBe(true);
    expect(isSupportedSmartCorrelationReason('PROVIDER_SERVICE_AMBIGUOUS')).toBe(false);
  });

  it('correlation prompt는 그룹 단위 문맥과 alias_binding 요구사항을 포함해야 한다', () => {
    const prompt = buildSmartCorrelationPrompt(
      createGroup(),
      [
        { id: 'service-order', name: 'order-service', endpointCount: 12 },
        { id: 'service-billing', name: 'billing-service', endpointCount: 8 },
      ],
      [
        {
          aliasKey: 'client.billing.url',
          aliasValue: 'BILLING_SERVICE',
          resolvedServiceName: 'billing-service',
        },
      ],
    );

    expect(prompt).toContain('Respond with patchType=alias_binding.');
    expect(prompt).toContain('Correlated frontier count: 2');
    expect(prompt).toContain('HOST_ALIAS_UNRESOLVED, CONFIG_BINDING_MISSING');
    expect(prompt).toContain('api-gateway');
    expect(prompt).toContain('ORDER_SERVICE');
    expect(prompt).toContain('client.orders.url');
    expect(prompt).toContain('service-order');
  });
});
