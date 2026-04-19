import { describe, expect, it, vi } from 'vitest';
import {
    runDomainDiscovery,
    SECONDARY_AFFINITY_THRESHOLD,
} from '@/domain/discovery/runDomainDiscovery';
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

describe('runDomainDiscovery', () => {
    it('T1: 빈 입력 → 후보 0건', async () => {
        const result = await runDomainDiscovery({ inputs: makeInputs() });
        expect(result.candidates).toEqual([]);
    });

    it('T2: 단일 객체가 자기 슬러그에 primary 로 배치, review = null', async () => {
        const result = await runDomainDiscovery({
            inputs: makeInputs({
                objects: [
                    {
                        id: 'svc-orders',
                        objectType: 'service',
                        name: 'OrdersService',
                        displayName: 'Orders Service',
                        path: '/orders/api',
                    },
                ],
            }),
        });

        const orders = result.candidates.find((c) => c.id === 'orders');
        expect(orders).toBeDefined();
        expect(orders!.members).toHaveLength(1);
        expect(orders!.members[0]!.objectId).toBe('svc-orders');
        expect(orders!.review).toBeNull();
    });

    it('T3: 한 객체가 두 후보에 모두 0.25 이상이면 affinity 높은 곳을 primary 로', async () => {
        const result = await runDomainDiscovery({
            inputs: makeInputs({
                objects: [
                    // path /orders + name OrdersBilling → orders(path+name) > billing(name only)
                    {
                        id: 'svc-x',
                        objectType: 'service',
                        name: 'OrdersBilling',
                        displayName: null,
                        path: '/orders/x',
                    },
                ],
            }),
        });

        const ordersMembers = result.candidates.find((c) => c.id === 'orders')?.members ?? [];
        const billingMembers = result.candidates.find((c) => c.id === 'billing')?.members ?? [];

        expect(ordersMembers.find((m) => m.objectId === 'svc-x')).toBeDefined();
        // billing affinity 가 0.5 미만이라면 secondary 보존되지 않음
        const billingMember = billingMembers.find((m) => m.objectId === 'svc-x');
        if (billingMember) {
            expect(billingMember.affinity).toBeGreaterThanOrEqual(SECONDARY_AFFINITY_THRESHOLD);
        }
    });

    it('T4: 관계 응집도가 멤버 cohesion 으로 채워짐', async () => {
        const result = await runDomainDiscovery({
            inputs: makeInputs({
                objects: [
                    { id: 'a', objectType: 'service', name: 'OrdersService', displayName: null, path: '/orders/a' },
                    { id: 'b', objectType: 'service', name: 'OrdersDetail', displayName: null, path: '/orders/b' },
                ],
                relations: [{ subjectObjectId: 'a', objectId: 'b', relationType: 'call' }],
            }),
        });

        const orders = result.candidates.find((c) => c.id === 'orders')!;
        expect(orders.members.find((m) => m.objectId === 'a')!.relationCohesion).toBe(1);
        expect(orders.members.find((m) => m.objectId === 'b')!.relationCohesion).toBe(1);
    });

    it('T5: review 함수가 주입되면 후보별로 호출되어 review 채움', async () => {
        const review = vi.fn(async () => ({
            coherent: true,
            suggestedName: '주문',
            responsibilityHint: '주문 라이프사이클을 책임',
        }));

        const result = await runDomainDiscovery({
            inputs: makeInputs({
                objects: [
                    {
                        id: 'svc-orders',
                        objectType: 'service',
                        name: 'OrdersService',
                        displayName: null,
                        path: '/orders/api',
                    },
                    {
                        id: 'svc-payments',
                        objectType: 'service',
                        name: 'PaymentsService',
                        displayName: null,
                        path: '/payments/api',
                    },
                ],
            }),
            review,
        });

        // 후보 2개 → review 2회 호출
        expect(review).toHaveBeenCalledTimes(2);
        for (const cand of result.candidates) {
            expect(cand.review).toEqual({
                coherent: true,
                suggestedName: '주문',
                responsibilityHint: '주문 라이프사이클을 책임',
            });
        }
    });
});
