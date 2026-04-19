/**
 * semanticSignalCollector 단위 테스트
 * 순수 함수이므로 DB 런타임 불필요
 */
import { describe, expect, it } from 'vitest';
import { collectDomainSemanticSignals } from '@/domain/semantic/semanticSignalCollector';
import type { CollectorInputs } from '@/domain/semantic/types';

function makeInputs(overrides: Partial<CollectorInputs> = {}): CollectorInputs {
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
        intents: [],
        relations: [],
        objectsById: {
            'svc-order': {
                id: 'svc-order',
                name: 'order-service',
                displayName: 'Order Service',
                objectType: 'service',
                domainId: 'dom-order',
            },
        },
        ...overrides,
    };
}

describe('collectDomainSemanticSignals', () => {
    it('T1: 신호가 없는 도메인 → 빈 후보 + 빈 evidence', () => {
        const result = collectDomainSemanticSignals(makeInputs());
        expect(result.domainId).toBe('dom-order');
        expect(result.actions).toEqual([]);
        expect(result.events).toEqual([]);
        expect(result.collaborators).toEqual([]);
        expect(result.dbAccesses).toEqual([]);
        expect(result.evidence).toEqual([]);
    });

    it('T2: http_gateway_route intent → action(http) 후보 + evidence 생성', () => {
        const result = collectDomainSemanticSignals(
            makeInputs({
                intents: [
                    {
                        id: 'intent-1',
                        sourceObjectId: 'svc-order',
                        sourceFunctionId: 'fn-create-order',
                        sourceFilePath: 'src/order/OrderController.java',
                        intentType: 'http_gateway_route',
                        methodHint: 'POST',
                        externalPathHint: '/api/v1/orders',
                        externalRoutePattern: null,
                        dbTableHints: [],
                        dbSchemaHint: null,
                        messageTopicHints: [],
                        messageQueueHints: [],
                        messageBrokerKind: null,
                        evidences: [
                            {
                                filePath: 'src/order/OrderController.java',
                                lineStart: 42,
                                lineEnd: 50,
                                excerpt: '@PostMapping("/api/v1/orders") public OrderResponse create(...)',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(result.actions).toHaveLength(1);
        const [action] = result.actions;
        expect(action?.trigger).toBe('http');
        expect(action?.method).toBe('POST');
        expect(action?.path).toBe('/api/v1/orders');
        expect(action?.name).toBe('POST /api/v1/orders');
        expect(action?.evidenceIds.length).toBe(1);
        expect(result.evidence).toHaveLength(1);
        expect(result.evidence[0]?.filePath).toBe('src/order/OrderController.java');
    });

    it('T2.1: outbound http_call intent 는 action 후보에서 제외', () => {
        const result = collectDomainSemanticSignals(
            makeInputs({
                intents: [
                    {
                        id: 'intent-1-outbound',
                        sourceObjectId: 'svc-order',
                        sourceFunctionId: 'fn-call-payment',
                        sourceFilePath: 'src/order/PaymentClient.java',
                        intentType: 'http_call',
                        methodHint: 'POST',
                        externalPathHint: '/payments/approve',
                        externalRoutePattern: null,
                        dbTableHints: [],
                        dbSchemaHint: null,
                        messageTopicHints: [],
                        messageQueueHints: [],
                        messageBrokerKind: null,
                        evidences: [
                            {
                                filePath: 'src/order/PaymentClient.java',
                                lineStart: 21,
                                lineEnd: 28,
                                excerpt: 'restTemplate.postForEntity("/payments/approve", ...)',
                            },
                        ],
                    },
                ],
            }),
        );

        expect(result.actions).toEqual([]);
        expect(result.evidence).toHaveLength(1);
    });

    it('T3: message_publish intent → event 후보(publish)', () => {
        const result = collectDomainSemanticSignals(
            makeInputs({
                intents: [
                    {
                        id: 'intent-2',
                        sourceObjectId: 'svc-order',
                        sourceFunctionId: null,
                        sourceFilePath: 'src/order/OrderEventPublisher.java',
                        intentType: 'message_publish',
                        methodHint: null,
                        externalPathHint: null,
                        externalRoutePattern: null,
                        dbTableHints: [],
                        dbSchemaHint: null,
                        messageTopicHints: ['order.created'],
                        messageQueueHints: [],
                        messageBrokerKind: 'kafka',
                        evidences: [
                            {
                                filePath: 'src/order/OrderEventPublisher.java',
                                lineStart: 17,
                                lineEnd: 22,
                                excerpt: 'kafkaTemplate.send("order.created", payload)',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(result.events).toHaveLength(1);
        const [event] = result.events;
        expect(event?.direction).toBe('publish');
        expect(event?.channel).toBe('order.created');
        expect(event?.name).toBe('order.created');
    });

    it('T4: db_access intent → dbAccesses 후보', () => {
        const result = collectDomainSemanticSignals(
            makeInputs({
                intents: [
                    {
                        id: 'intent-3',
                        sourceObjectId: 'svc-order',
                        sourceFunctionId: null,
                        sourceFilePath: 'src/order/OrderRepository.java',
                        intentType: 'db_access',
                        methodHint: null,
                        externalPathHint: null,
                        externalRoutePattern: null,
                        dbTableHints: ['orders', 'order_items'],
                        dbSchemaHint: 'public',
                        messageTopicHints: [],
                        messageQueueHints: [],
                        messageBrokerKind: null,
                        evidences: [
                            {
                                filePath: 'src/order/OrderRepository.java',
                                lineStart: 10,
                                lineEnd: 12,
                                excerpt: 'select * from orders where ...',
                            },
                        ],
                    },
                ],
            }),
        );
        expect(result.dbAccesses).toHaveLength(2);
        expect(result.dbAccesses.map((d) => d.table).sort()).toEqual(['order_items', 'orders']);
    });

    it('T5: 외부 도메인으로 향하는 relation → collaborator(다른 도메인)', () => {
        const result = collectDomainSemanticSignals(
            makeInputs({
                relations: [
                    {
                        id: 'rel-1',
                        subjectObjectId: 'svc-order',
                        objectId: 'svc-payment',
                        relationType: 'call',
                    },
                ],
                objectsById: {
                    'svc-order': {
                        id: 'svc-order',
                        name: 'order-service',
                        displayName: 'Order Service',
                        objectType: 'service',
                        domainId: 'dom-order',
                    },
                    'svc-payment': {
                        id: 'svc-payment',
                        name: 'payment-service',
                        displayName: 'Payment Service',
                        objectType: 'service',
                        domainId: 'dom-payment',
                    },
                },
            }),
        );
        expect(result.collaborators).toHaveLength(1);
        const [collab] = result.collaborators;
        expect(collab?.targetObjectId).toBe('svc-payment');
        expect(collab?.targetDomainId).toBe('dom-payment');
        expect(collab?.relationType).toBe('call');
    });

    it('T6: 도메인 내부 relation(member→member) 은 collaborator 에서 제외', () => {
        const result = collectDomainSemanticSignals(
            makeInputs({
                members: [
                    { id: 'svc-order', name: 'order-service', displayName: 'Order Service', objectType: 'service', description: null },
                    { id: 'svc-order-job', name: 'order-batch', displayName: 'Order Batch', objectType: 'service', description: null },
                ],
                relations: [
                    { id: 'rel-internal', subjectObjectId: 'svc-order', objectId: 'svc-order-job', relationType: 'call' },
                ],
                objectsById: {
                    'svc-order': { id: 'svc-order', name: 'order-service', displayName: null, objectType: 'service', domainId: 'dom-order' },
                    'svc-order-job': { id: 'svc-order-job', name: 'order-batch', displayName: null, objectType: 'service', domainId: 'dom-order' },
                },
            }),
        );
        expect(result.collaborators).toHaveLength(0);
    });

    it('T7: 같은 (table, source) 가 여러 intent 에서 반복돼도 evidence 는 누적되고 dbAccess 는 1개로 dedupe', () => {
        const intentTpl = {
            sourceObjectId: 'svc-order',
            sourceFunctionId: null,
            sourceFilePath: 'src/order/OrderRepository.java',
            intentType: 'db_access',
            methodHint: null,
            externalPathHint: null,
            externalRoutePattern: null,
            dbTableHints: ['orders'],
            dbSchemaHint: 'public',
            messageTopicHints: [],
            messageQueueHints: [],
            messageBrokerKind: null,
        } as const;
        const result = collectDomainSemanticSignals(
            makeInputs({
                intents: [
                    { id: 'i1', ...intentTpl, evidences: [{ filePath: 'a.java', lineStart: 1, lineEnd: 1, excerpt: 'select 1' }] },
                    { id: 'i2', ...intentTpl, evidences: [{ filePath: 'b.java', lineStart: 2, lineEnd: 2, excerpt: 'select 2' }] },
                ],
            }),
        );
        expect(result.dbAccesses).toHaveLength(1);
        expect(result.dbAccesses[0]?.table).toBe('orders');
        expect(result.dbAccesses[0]?.evidenceIds.length).toBe(2);
    });
});
