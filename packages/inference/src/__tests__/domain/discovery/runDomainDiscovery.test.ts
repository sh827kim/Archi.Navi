import { describe, expect, it, vi } from 'vitest';
import {
  runDomainDiscovery,
  SECONDARY_AFFINITY_THRESHOLD,
  SPLIT_COHERENCE_CONFIDENCE_THRESHOLD,
} from '@/domain/discovery/runDomainDiscovery';
import type { DiscoveryInputs, LlmCandidateReview } from '@/domain/discovery/types';

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
          {
            id: 'a',
            objectType: 'service',
            name: 'OrdersService',
            displayName: null,
            path: '/orders/a',
          },
          {
            id: 'b',
            objectType: 'service',
            name: 'OrdersDetail',
            displayName: null,
            path: '/orders/b',
          },
        ],
        relations: [{ subjectObjectId: 'a', objectId: 'b', relationType: 'call' }],
      }),
    });

    const orders = result.candidates.find((c) => c.id === 'orders')!;
    expect(orders.members.find((m) => m.objectId === 'a')!.relationCohesion).toBe(1);
    expect(orders.members.find((m) => m.objectId === 'b')!.relationCohesion).toBe(1);
  });

  it('T4.1: review 함수가 단일 후보에서 throw 해도 결정적 발견 결과는 살아남고 해당 후보만 review = null', async () => {
    let callIndex = 0;
    const review = vi.fn(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        throw new Error('rate-limit');
      }
      return {
        coherent: true,
        suggestedName: '결제',
        responsibilityHint: '결제 처리',
        mergeWithCandidateId: null,
        splitSuggestions: [],
      };
    });

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

    // 후보 2개가 모두 살아있어야 한다 (한 쪽이 LLM 실패해도 발견 자체는 성공)
    expect(result.candidates).toHaveLength(2);
    const reviewed = result.candidates.filter((c) => c.review !== null);
    const failed = result.candidates.filter((c) => c.review === null);
    expect(reviewed).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });

  it('T5: review 함수가 주입되면 후보별로 호출되어 review 채움', async () => {
    const review = vi.fn(async () => ({
      coherent: true,
      suggestedName: '주문',
      responsibilityHint: '주문 라이프사이클을 책임',
      mergeWithCandidateId: null,
      splitSuggestions: [],
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
        mergeWithCandidateId: null,
        splitSuggestions: [],
      });
    }
  });

  it('T6: LLM split 은 ID 충돌 없이 생성되고 split 후 relationCohesion 을 재계산한다', async () => {
    const review = vi.fn(async (_prompt, inputs) => {
      const splitSuggestions: LlmCandidateReview['splitSuggestions'] = [];
      if (inputs.candidate.slug === 'orders') {
        splitSuggestions.push(
          {
            suggestedName: '주문 처리',
            responsibilityHint: '주문 처리',
            reason: '명령 객체 분리',
            confidence: SPLIT_COHERENCE_CONFIDENCE_THRESHOLD,
            memberSelectors: [{ kind: 'object_name', value: 'OrderCommand' }],
            evidenceHints: [],
          },
          {
            suggestedName: '주문 처리',
            responsibilityHint: '주문 조회',
            reason: '조회 객체 분리',
            confidence: SPLIT_COHERENCE_CONFIDENCE_THRESHOLD - 0.01,
            memberSelectors: [{ kind: 'object_name', value: 'OrderQuery' }],
            evidenceHints: [],
          },
        );
      }

      return {
        coherent: true,
        suggestedName: inputs.candidate.autoName,
        responsibilityHint: '후보 책임',
        mergeWithCandidateId: null,
        splitSuggestions,
      };
    });

    const result = await runDomainDiscovery({
      inputs: makeInputs({
        objects: [
          {
            id: 'cmd',
            objectType: 'service',
            name: 'OrderCommand',
            displayName: null,
            path: '/orders/cmd',
          },
          {
            id: 'query',
            objectType: 'service',
            name: 'OrderQuery',
            displayName: null,
            path: '/orders/query',
          },
          {
            id: 'audit',
            objectType: 'service',
            name: 'OrderAudit',
            displayName: null,
            path: '/orders/audit',
          },
        ],
        relations: [
          { subjectObjectId: 'cmd', objectId: 'query', relationType: 'call' },
          { subjectObjectId: 'audit', objectId: 'cmd', relationType: 'call' },
        ],
      }),
      review,
    });

    const splitIds = result.candidates
      .filter((c) => c.parentCandidateId === 'orders')
      .map((c) => c.id);
    expect(splitIds).toEqual(['orders--split-주문-처리-1', 'orders--split-주문-처리-2']);

    const parent = result.candidates.find((c) => c.id === 'orders')!;
    expect(parent.members).toHaveLength(1);
    expect(parent.members[0]).toMatchObject({ objectId: 'audit', relationCohesion: 0 });
    expect(parent.review).toBeNull();

    const highConfidenceSplit = result.candidates.find(
      (c) => c.id === 'orders--split-주문-처리-1',
    )!;
    expect(highConfidenceSplit.review?.coherent).toBe(true);
    expect(highConfidenceSplit.members[0]).toMatchObject({ objectId: 'cmd', relationCohesion: 0 });

    const lowConfidenceSplit = result.candidates.find((c) => c.id === 'orders--split-주문-처리-2')!;
    expect(lowConfidenceSplit.review?.coherent).toBe(false);
    expect(lowConfidenceSplit.members[0]).toMatchObject({ objectId: 'query', relationCohesion: 0 });
  });

  it('T7: route_prefix split selector 는 route seed 에만 매칭하고 prefixed API route 도 semantic segment 로 잡는다', async () => {
    const review = vi.fn(async (_prompt, inputs) => {
      const splitSuggestions: LlmCandidateReview['splitSuggestions'] = [];
      if (inputs.candidate.slug === 'orders') {
        splitSuggestions.push({
          suggestedName: '주문 API',
          responsibilityHint: '주문 API',
          reason: 'route 기반 분리',
          confidence: 1,
          memberSelectors: [{ kind: 'route_prefix', value: '/:tenant/orders' }],
          evidenceHints: [],
        });
      }

      return {
        coherent: true,
        suggestedName: inputs.candidate.autoName,
        responsibilityHint: '후보 책임',
        mergeWithCandidateId: null,
        splitSuggestions,
      };
    });

    const result = await runDomainDiscovery({
      inputs: makeInputs({
        objects: [
          {
            id: 'route-member',
            objectType: 'api_endpoint',
            name: 'OrdersEndpoint',
            displayName: null,
            path: '/billing/endpoint',
          },
          {
            id: 'path-member',
            objectType: 'service',
            name: 'Worker',
            displayName: null,
            path: '/orders/worker',
          },
        ],
        intents: [
          {
            sourceObjectId: 'route-member',
            intentType: 'http',
            externalPathHint: '/api/v1/orders/{id}',
            externalRoutePattern: null,
            messageTopicHints: [],
          },
        ],
      }),
      review,
    });

    const split = result.candidates.find((c) => c.id === 'orders--split-주문-api-1')!;
    expect(split.members.map((m) => m.objectId)).toEqual(['route-member']);
    expect(split.members[0]?.seedSources).toContain('route:/orders');

    const parent = result.candidates.find((c) => c.id === 'orders')!;
    expect(parent.members.map((m) => m.objectId)).toEqual(['path-member']);
  });
});
