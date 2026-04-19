import { describe, expect, it, vi } from 'vitest';
import { reviewDomainCandidate } from '@/domain/discovery/llmReviewer';
import type { GenerateDomainReviewFn } from '@/domain/discovery/llmReviewer';
import type { StructuralClusterCandidate } from '@/domain/discovery/structuralClustering';

function candidate(overrides: Partial<StructuralClusterCandidate> = {}): StructuralClusterCandidate {
    return {
        slug: 'orders',
        autoName: 'Orders',
        members: [
            {
                objectId: 'svc-order',
                pathPrefixMatch: 1,
                routePrefixMatch: 1,
                topicPrefixMatch: 0,
                nameTokenJaccard: 1,
                affinity: 0.75,
                relationCohesion: 0.8,
            },
        ],
        signals: {
            topPathPrefix: 'orders',
            topRoutePrefix: '/orders',
            topTopicPrefix: null,
        },
        ...overrides,
    };
}

describe('reviewDomainCandidate', () => {
    it('T1: 프롬프트에 후보 슬러그/멤버/신호가 포함된다', async () => {
        const generate: GenerateDomainReviewFn = vi.fn(async () => ({
            coherent: true,
            suggestedName: '주문',
            responsibilityHint: '주문 생성과 조회를 책임진다',
        }));

        await reviewDomainCandidate(
            {
                candidate: candidate(),
                objectNameById: new Map([['svc-order', 'Order Service']]),
                siblingCandidateIds: ['orders', 'payments'],
            },
            generate,
        );

        const call = vi.mocked(generate).mock.calls[0]!;
        const prompt = call[0];
        expect(prompt).toContain('orders');
        expect(prompt).toContain('Order Service');
        expect(prompt).toContain('path prefix: orders');
        expect(prompt).toContain('route prefix: /orders');
        // 자기 자신은 sibling 에서 빠져야 함
        expect(prompt).not.toMatch(/-\s*orders\s*\n/);
        expect(prompt).toContain('- payments');
    });

    it('T2: generate 가 반환한 review 를 그대로 반환', async () => {
        const generate: GenerateDomainReviewFn = vi.fn(async () => ({
            coherent: false,
            suggestedName: 'Misc',
            responsibilityHint: '책임이 분산되어 일관성이 부족',
            mergeWithCandidateId: 'payments',
        }));

        const result = await reviewDomainCandidate(
            {
                candidate: candidate(),
                objectNameById: new Map(),
                siblingCandidateIds: [],
            },
            generate,
        );

        expect(result).toEqual({
            coherent: false,
            suggestedName: 'Misc',
            responsibilityHint: '책임이 분산되어 일관성이 부족',
            mergeWithCandidateId: 'payments',
        });
    });

    it('T3: 멤버 이름이 10개를 초과하면 첫 10개만 프롬프트에 포함', async () => {
        const lotsOfMembers = Array.from({ length: 15 }, (_, i) => ({
            objectId: `m-${i}`,
            pathPrefixMatch: 1 as const,
            routePrefixMatch: 0 as const,
            topicPrefixMatch: 0 as const,
            nameTokenJaccard: 0,
            affinity: 0.25,
            relationCohesion: 0,
        }));

        const generate: GenerateDomainReviewFn = vi.fn(async () => ({
            coherent: true,
            suggestedName: 'X',
            responsibilityHint: 'x',
        }));

        await reviewDomainCandidate(
            {
                candidate: candidate({ members: lotsOfMembers }),
                objectNameById: new Map(lotsOfMembers.map((m, i) => [m.objectId, `Member${i}`])),
                siblingCandidateIds: [],
            },
            generate,
        );

        const prompt = vi.mocked(generate).mock.calls[0]![0];
        expect(prompt).toContain('Member0');
        expect(prompt).toContain('Member9');
        expect(prompt).not.toContain('Member10');
        expect(prompt).not.toContain('Member14');
    });
});
