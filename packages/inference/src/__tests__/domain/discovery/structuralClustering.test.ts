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
});

describe('runStructuralClustering', () => {
    it('T1: 빈 입력 → 후보 0건', () => {
        const result = runStructuralClustering(makeInputs());
        expect(result.candidates).toEqual([]);
    });

    it('T2: path prefix 1개 신호만 일치하는 객체 → affinity = 0.25 (임계값 통과)', () => {
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
        expect(payments).toBeDefined();
        expect(payments!.members[0]!.affinity).toBeCloseTo(AFFINITY_THRESHOLD);
        expect(payments!.members[0]!.pathPrefixMatch).toBe(1);
        expect(payments!.signals.topPathPrefix).toBe('payments');
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
        expect(member.affinity).toBe(1);
        expect(orders!.signals.topPathPrefix).toBe('orders');
        expect(orders!.signals.topRoutePrefix).toBe('/orders');
        expect(orders!.signals.topTopicPrefix).toBe('orders');
    });

    it('T4: 임계값 통과 후보의 모든 멤버는 affinity ≥ 0.25', () => {
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
        // 각 도메인의 자기 객체는 path + name 일치로 affinity ≥ 0.5
        const orders = result.candidates.find((c) => c.slug === 'orders');
        expect(orders!.members.find((m) => m.objectId === 'obj-1')!.affinity).toBeGreaterThanOrEqual(0.5);
    });

    it('T5: 멤버 수 내림차순 정렬', () => {
        const result = runStructuralClustering(
            makeInputs({
                objects: [
                    { id: 'a', objectType: 'service', name: 'a', displayName: null, path: '/big/x' },
                    { id: 'b', objectType: 'service', name: 'b', displayName: null, path: '/big/y' },
                    { id: 'c', objectType: 'service', name: 'c', displayName: null, path: '/big/z' },
                    { id: 'd', objectType: 'service', name: 'd', displayName: null, path: '/small/q' },
                ],
            }),
        );
        const slugs = result.candidates.map((c) => c.slug);
        expect(slugs[0]).toBe('big');
        // small 도 후보에 포함됐는지 확인
        expect(slugs).toContain('small');
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
});
