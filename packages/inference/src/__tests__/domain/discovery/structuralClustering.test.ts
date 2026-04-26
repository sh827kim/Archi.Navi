/**
 * structuralClustering 단위 테스트
 * 순수 함수: DiscoveryInputs → StructuralClusteringResult
 */
import { describe, expect, it } from 'vitest';
import {
    AFFINITY_THRESHOLD,
    runStructuralClustering,
    tokenizeName,
} from '@/domain/discovery/structuralClustering';
import type { DiscoveryInputs } from '@/domain/discovery/types';

function makeInputs(overrides: Partial<DiscoveryInputs> = {}): DiscoveryInputs {
    return {
        workspaceId: 'ws-1',
        objects: [],
        intents: [],
        relations: [],
        codeArtifacts: [],
        ...overrides,
    };
}

describe('tokenizeName', () => {
    it('T1: pascalCase 분해 + Service suffix 제거', () => {
        const tokens = tokenizeName('OrderService');
        expect(Array.from(tokens).sort()).toEqual(['order']);
    });

    it('T2: snake_case 분해 + 짧은 토큰 제거', () => {
        const tokens = tokenizeName('payment_processor_a');
        expect(Array.from(tokens).sort()).toEqual(['payment', 'processor']);
    });

    it('T3: kebab-case + Controller suffix 제거', () => {
        const tokens = tokenizeName('user-auth-controller');
        expect(Array.from(tokens).sort()).toEqual(['auth', 'user']);
    });

    it('T4: 한글 이름 토큰은 보존해야 한다', () => {
        const tokens = tokenizeName('주문 서비스');
        expect(Array.from(tokens).sort()).toEqual(['서비스', '주문']);
    });
});

describe('runStructuralClustering', () => {
    it('T1: 빈 입력 → 후보 0건', () => {
        const result = runStructuralClustering(makeInputs());
        expect(result.candidates).toEqual([]);
    });

    it('T2: path prefix 1개 신호만 일치하는 객체 → 가중치 기준 임계값 미만으로 제외', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'obj-1',
                        objectType: 'service',
                        name: 'misc',
                        displayName: null,
                        path: '/payments/billing',
                    },
                ],
            }),
        );

        const payments = result.candidates.find((c) => c.slug === 'payments');
        expect(payments).toBeUndefined();
    });

    it('T3: 4개 신호 모두 일치 → affinity = 1, 강한 신호 칩 3개 모두 채움', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'obj-1',
                        objectType: 'service',
                        name: 'OrdersService',
                        displayName: null,
                        path: '/orders/api',
                    },
                ],
                intents: [
                    {
                        sourceObjectId: 'obj-1',
                        intentType: 'http_call',
                        externalPathHint: '/orders/123',
                        externalRoutePattern: null,
                        messageTopicHints: ['orders.created'],
                    },
                ],
            }),
        );

        const orders = result.candidates.find((c) => c.slug === 'orders');
        expect(orders).toBeDefined();
        const member = orders!.members[0]!;
        expect(member.pathPrefixMatch).toBe(1);
        expect(member.routePrefixMatch).toBe(1);
        expect(member.topicPrefixMatch).toBe(1);
        expect(member.nameTokenJaccard).toBe(1);
        expect(member.affinity).toBeCloseTo(0.75);
        expect(orders!.signals.topPathPrefix).toBe('orders');
        expect(orders!.signals.topRoutePrefix).toBe('/orders');
        expect(orders!.signals.topTopicPrefix).toBe('orders');
    });

    it('T4: 임계값 통과 후보의 모든 멤버는 affinity ≥ threshold', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'obj-1',
                        objectType: 'service',
                        name: 'OrdersService',
                        displayName: null,
                        path: '/orders/x',
                    },
                    {
                        id: 'obj-2',
                        objectType: 'service',
                        name: 'BillingService',
                        displayName: null,
                        path: '/billing/y',
                    },
                ],
            }),
        );
        for (const candidate of result.candidates) {
            for (const member of candidate.members) {
                expect(member.affinity).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
            }
        }
        // 각 도메인의 자기 객체는 path + name 일치로 임계값을 통과한다.
        const orders = result.candidates.find((c) => c.slug === 'orders');
        expect(orders!.members.find((m) => m.objectId === 'obj-1')!.affinity).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
    });

    it('T5: 멤버 수 내림차순 정렬', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    { id: 'a', objectType: 'service', name: 'BigService', displayName: null, path: '/big/x' },
                    { id: 'b', objectType: 'service', name: 'BigService', displayName: null, path: '/big/y' },
                    { id: 'c', objectType: 'service', name: 'BigService', displayName: null, path: '/big/z' },
                    { id: 'd', objectType: 'service', name: 'SmallService', displayName: null, path: '/small/q' },
                ],
            }),
        );
        const slugs = result.candidates.map((c) => c.slug);
        expect(slugs[0]).toBe('big');
        // small 도 후보에 포함됐는지 확인
        expect(slugs).toContain('small');
    });

    it('T6.1: transport/version prefix(/api, /v1) 는 슬러그로 잡지 않고 다음 의미 segment 를 사용', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    { id: 'svc-orders', objectType: 'service', name: 'OrdersService', displayName: null, path: '/api/orders/list' },
                    { id: 'svc-pay', objectType: 'service', name: 'PaymentsService', displayName: null, path: '/v1/payments/charge' },
                ],
                intents: [
                    {
                        sourceObjectId: 'svc-orders',
                        intentType: 'http_call',
                        externalPathHint: '/api/orders/123',
                        externalRoutePattern: null,
                        messageTopicHints: [],
                    },
                ],
            }),
        );

        const slugs = result.candidates.map((c) => c.slug);
        // api / v1 은 후보 풀에 들어가지 않아야 한다 (서로 다른 도메인이 한 후보로 묶이는 문제 방지)
        expect(slugs).not.toContain('api');
        expect(slugs).not.toContain('v1');
        // 의미 있는 segment 인 orders, payments 가 후보로 잡혀야 한다
        expect(slugs).toContain('orders');
        expect(slugs).toContain('payments');

        const orders = result.candidates.find((c) => c.slug === 'orders')!;
        // 강한 신호 칩도 의미 있는 segment 로 채워져야 한다
        expect(orders.signals.topPathPrefix).toBe('orders');
        expect(orders.signals.topRoutePrefix).toBe('/orders');
    });

    it('T6.2: 모든 segment 가 transport prefix 라면 마지막 segment 를 fallback', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    { id: 'svc-x', objectType: 'service', name: 'InternalService', displayName: null, path: '/api/internal' },
                ],
            }),
        );
        // 모두 prefix → fallback 인 마지막 segment "internal" 이 슬러그로 잡힘
        // 의미 있는 도메인은 아니지만, 의도된 fallback 동작 검증.
        const slugs = result.candidates.map((c) => c.slug);
        expect(slugs).toContain('internal');
    });

    it('T6: relationCohesion 은 본 모듈에서 0 으로 초기화', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [{ id: 'a', objectType: 'service', name: 'OrdersService', displayName: null, path: '/orders/x' }],
            }),
        );
        const orders = result.candidates.find((c) => c.slug === 'orders');
        expect(orders!.members[0]!.relationCohesion).toBe(0);
    });

    it('T7: 한글 slug 는 정규화 후 보존 (approve 와 일관성)', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    { id: 'ord', objectType: 'service', name: '주문서비스', displayName: null, path: '/주문' },
                    { id: 'pay', objectType: 'service', name: '결제Handler', displayName: null, path: '/결제/api' },
                ],
                intents: [
                    {
                        sourceObjectId: 'ord',
                        intentType: 'http_call',
                        externalPathHint: '/주문',
                        externalRoutePattern: null,
                        messageTopicHints: [],
                    },
                    {
                        sourceObjectId: 'pay',
                        intentType: 'message_publish',
                        externalPathHint: null,
                        externalRoutePattern: null,
                        messageTopicHints: ['결제.처리'],
                    },
                ],
            }),
        );

        const slugs = result.candidates.map((c) => c.slug);
        // 한글 slug 가 보존되어야 함 (빈 문자열로 변환돼 무시되지 않아야 함)
        expect(slugs).toContain('주문');
        expect(slugs).toContain('결제');

        const order = result.candidates.find((c) => c.slug === '주문')!;
        expect(order.members).toHaveLength(1);
        expect(order.members[0]!.objectId).toBe('ord');
    });

    it('T8: 한글 이름 토큰도 slug 후보와 jaccard 계산에 반영해야 한다', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'svc-order',
                        objectType: 'service',
                        name: '주문',
                        displayName: null,
                        path: '/주문',
                    },
                ],
            }),
        );

        const order = result.candidates.find((c) => c.slug === '주문');
        expect(order).toBeDefined();
        expect(order!.members[0]!.nameTokenJaccard).toBe(1);
        expect(order!.members[0]!.affinity).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
    });

    it('T9: signal-only service 의 intent 는 직접 코드 자식에게 상속되지만 service 자체는 멤버에 포함되지 않는다', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'svc-gateway',
                        objectType: 'service',
                        name: 'GatewayService',
                        displayName: null,
                        path: '/infra/gateway',
                        memberEligible: false,
                    },
                    {
                        id: 'fn-create-order',
                        objectType: 'function',
                        name: 'create',
                        displayName: null,
                        path: '/misc/create',
                        parentId: 'svc-gateway',
                    },
                ],
                intents: [
                    {
                        sourceObjectId: 'svc-gateway',
                        intentType: 'http_gateway_route',
                        externalPathHint: '/orders',
                        externalRoutePattern: '/orders/**',
                        messageTopicHints: [],
                    },
                ],
            }),
        );

        const orders = result.candidates.find((c) => c.slug === 'orders');
        expect(orders).toBeDefined();
        expect(orders!.members).toEqual([
            expect.objectContaining({
                objectId: 'fn-create-order',
                routePrefixMatch: 1,
                affinity: 0.3,
            }),
        ]);
        expect(orders!.members.some((member) => member.objectId === 'svc-gateway')).toBe(false);
        expect(orders!.signals.topRoutePrefix).toBe('/orders');
    });

    it('T10: snake_case 이름이어도 DB 테이블 객체가 아니면 table family 신호로 쓰지 않는다', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'fn-order-items',
                        objectType: 'function',
                        name: 'order_items',
                        displayName: null,
                        path: '/order/function',
                    },
                    {
                        id: 'table-order-items',
                        objectType: 'db_table',
                        name: 'order_items',
                        displayName: null,
                        path: '/storage/order-items',
                    },
                ],
                intents: [
                    {
                        sourceObjectId: 'fn-order-items',
                        intentType: 'http_endpoint',
                        externalPathHint: '/order/items',
                        externalRoutePattern: null,
                        messageTopicHints: [],
                    },
                ],
            }),
        );

        const order = result.candidates.find((c) => c.slug === 'order')!;
        const functionMember = order.members.find((m) => m.objectId === 'fn-order-items')!;
        const tableMember = order.members.find((m) => m.objectId === 'table-order-items')!;

        expect(functionMember.tableFamilyMatch).toBe(0);
        expect(functionMember.seedSources).not.toContain('table:order');
        expect(tableMember.tableFamilyMatch).toBe(1);
        expect(tableMember.seedSources).toContain('table:order');
    });

    it('T10.1: inbound endpoint route 는 첫 segment 이후의 도메인 힌트도 후보로 만든다', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'ep-product',
                        objectType: 'api_endpoint',
                        name: 'GET /product/{id}',
                        displayName: null,
                        path: '/monolith/api/product',
                    },
                    {
                        id: 'ep-cart',
                        objectType: 'api_endpoint',
                        name: 'POST /cart',
                        displayName: null,
                        path: '/monolith/api/cart',
                    },
                    {
                        id: 'ep-checkout',
                        objectType: 'api_endpoint',
                        name: 'POST /cart/checkout',
                        displayName: null,
                        path: '/monolith/api/cart-checkout',
                    },
                ],
                intents: [
                    {
                        sourceObjectId: 'ep-product',
                        intentType: 'inbound_endpoint',
                        externalPathHint: '/product/{id}',
                        externalRoutePattern: '/product/{id}',
                        messageTopicHints: [],
                    },
                    {
                        sourceObjectId: 'ep-cart',
                        intentType: 'inbound_endpoint',
                        externalPathHint: '/cart',
                        externalRoutePattern: '/cart',
                        messageTopicHints: [],
                    },
                    {
                        sourceObjectId: 'ep-checkout',
                        intentType: 'inbound_endpoint',
                        externalPathHint: '/cart/checkout',
                        externalRoutePattern: '/cart/checkout',
                        messageTopicHints: [],
                    },
                ],
            }),
        );

        const slugs = result.candidates.map((c) => c.slug);
        expect(slugs).toContain('product');
        expect(slugs).toContain('cart');
        expect(slugs).toContain('checkout');
        expect(slugs).not.toContain('post');
        expect(slugs).not.toContain('id');

        const checkout = result.candidates.find((c) => c.slug === 'checkout')!;
        expect(checkout.signals.topRoutePrefix).toBe('/checkout');
        expect(checkout.members).toEqual([
            expect.objectContaining({
                objectId: 'ep-checkout',
                routePrefixMatch: 1,
                affinity: 0.35,
            }),
        ]);
    });

    it('T11: package seed 는 com/org 같은 namespace root 와 회사 prefix 를 제외한다', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    {
                        id: 'svc-orders',
                        objectType: 'service',
                        name: 'Worker',
                        displayName: null,
                        path: '/orders/worker',
                    },
                ],
                codeArtifacts: [
                    {
                        ownerObjectId: 'svc-orders',
                        packageName: 'com.example.orders',
                        filePath: 'src/main/java/com/example/orders/Worker.java',
                    },
                ],
            }),
        );

        const slugs = result.candidates.map((c) => c.slug);
        expect(slugs).not.toContain('com');
        expect(slugs).not.toContain('example');
        expect(slugs).toContain('orders');

        const orders = result.candidates.find((c) => c.slug === 'orders')!;
        expect(orders.members[0]).toMatchObject({
            objectId: 'svc-orders',
            codeFamilyMatch: 1,
        });
    });
});
