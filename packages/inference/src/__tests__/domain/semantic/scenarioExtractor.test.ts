/**
 * scenarioExtractor 단위 테스트
 * 순수 함수: CollectedSemanticSignals → ScenarioCandidate[]
 * (LLM 호출 전, 진입점 후보 목록만 산출)
 */
import { describe, expect, it } from 'vitest';
import { extractScenarioCandidates } from '@/domain/semantic/scenarioExtractor';
import type { CollectedSemanticSignals } from '@/domain/semantic/types';

function makeSignals(overrides: Partial<CollectedSemanticSignals> = {}): CollectedSemanticSignals {
    return {
        domainId: 'dom-order',
        domainName: '주문 도메인',
        members: [
            {
                id: 'svc-order',
                name: 'order-service',
                displayName: 'Order Service',
                objectType: 'service',
                description: null,
            },
        ],
        actions: [],
        events: [],
        collaborators: [],
        dbAccesses: [],
        evidence: [],
        ...overrides,
    };
}

describe('extractScenarioCandidates', () => {
    it('T1: actions/events 가 비어 있으면 빈 배열', () => {
        expect(extractScenarioCandidates(makeSignals())).toEqual([]);
    });

    it('T2: HTTP action 한 건 → http 트리거 시나리오 1건', () => {
        const result = extractScenarioCandidates(
            makeSignals({
                actions: [
                    {
                        name: 'POST /api/v1/orders',
                        trigger: 'http',
                        method: 'POST',
                        path: '/api/v1/orders',
                        sourceObjectId: 'svc-order',
                        evidenceIds: ['ev-1'],
                    },
                ],
            }),
        );
        expect(result).toHaveLength(1);
        const [scenario] = result;
        expect(scenario?.trigger).toBe('http');
        expect(scenario?.entryPointObjectId).toBe('svc-order');
        expect(scenario?.title).toContain('POST');
        expect(scenario?.title).toContain('/api/v1/orders');
        expect(scenario?.evidenceIds).toEqual(['ev-1']);
    });

    it('T3: consume event 1건 → message 트리거 시나리오 1건, publish event 는 제외', () => {
        const result = extractScenarioCandidates(
            makeSignals({
                events: [
                    {
                        name: 'order.created',
                        direction: 'publish',
                        channel: 'order.created',
                        sourceObjectId: 'svc-order',
                        evidenceIds: ['ev-pub'],
                    },
                    {
                        name: 'payment.completed',
                        direction: 'consume',
                        channel: 'payment.completed',
                        sourceObjectId: 'svc-order',
                        evidenceIds: ['ev-con'],
                    },
                ],
            }),
        );
        expect(result).toHaveLength(1);
        const [scenario] = result;
        expect(scenario?.trigger).toBe('message');
        expect(scenario?.title).toContain('payment.completed');
        expect(scenario?.evidenceIds).toEqual(['ev-con']);
    });

    it('T4: maxScenarios 옵션으로 결과 개수 제한', () => {
        const result = extractScenarioCandidates(
            makeSignals({
                actions: Array.from({ length: 10 }, (_, i) => ({
                    name: `GET /resource/${i}`,
                    trigger: 'http' as const,
                    method: 'GET',
                    path: `/resource/${i}`,
                    sourceObjectId: 'svc-order',
                    evidenceIds: [],
                })),
            }),
            { maxScenarios: 3 },
        );
        expect(result).toHaveLength(3);
    });

    it('T5: 같은 (trigger, entryPoint, key) 후보는 dedupe', () => {
        const result = extractScenarioCandidates(
            makeSignals({
                actions: [
                    {
                        name: 'POST /orders',
                        trigger: 'http',
                        method: 'POST',
                        path: '/orders',
                        sourceObjectId: 'svc-order',
                        evidenceIds: ['ev-1'],
                    },
                    {
                        name: 'POST /orders',
                        trigger: 'http',
                        method: 'POST',
                        path: '/orders',
                        sourceObjectId: 'svc-order',
                        evidenceIds: ['ev-2'],
                    },
                ],
            }),
        );
        expect(result).toHaveLength(1);
        expect(result[0]?.evidenceIds.sort()).toEqual(['ev-1', 'ev-2']);
    });

    it('T6: HTTP + consume event 가 모두 있으면 둘 다 시나리오 후보로 포함', () => {
        const result = extractScenarioCandidates(
            makeSignals({
                actions: [
                    {
                        name: 'POST /api/v1/orders',
                        trigger: 'http',
                        method: 'POST',
                        path: '/api/v1/orders',
                        sourceObjectId: 'svc-order',
                        evidenceIds: [],
                    },
                ],
                events: [
                    {
                        name: 'payment.completed',
                        direction: 'consume',
                        channel: 'payment.completed',
                        sourceObjectId: 'svc-order',
                        evidenceIds: [],
                    },
                ],
            }),
        );
        expect(result).toHaveLength(2);
        const triggers = result.map((s) => s.trigger).sort();
        expect(triggers).toEqual(['http', 'message']);
    });
});
