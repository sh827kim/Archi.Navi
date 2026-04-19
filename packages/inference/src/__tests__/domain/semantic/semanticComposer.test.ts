/**
 * semanticComposer 단위 테스트
 * LLM 호출은 DI 로 주입된 generate 함수로 모킹한다 (실제 네트워크 없음).
 */
import { describe, expect, it, vi } from 'vitest';
import {
    composeDomainSemanticProfile,
    type GenerateSemanticProfileFn,
    type SemanticComposerInputs,
    type SemanticLlmDraft,
} from '@/domain/semantic/semanticComposer';
import type { CollectedSemanticSignals } from '@/domain/semantic/types';
import type { ScenarioCandidate } from '@/domain/semantic/scenarioExtractor';

function makeSignals(): CollectedSemanticSignals {
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
        events: [
            {
                name: 'order.created',
                direction: 'publish',
                channel: 'order.created',
                sourceObjectId: 'svc-order',
                evidenceIds: ['ev-2'],
            },
        ],
        collaborators: [
            {
                targetObjectId: 'svc-payment',
                targetName: 'payment-service',
                targetDomainId: 'dom-payment',
                relationType: 'call',
                reason: '도메인 내 객체가 payment-service 로 call 관계',
                evidenceIds: [],
            },
        ],
        dbAccesses: [
            {
                table: 'orders',
                schema: 'public',
                sourceObjectId: 'svc-order',
                evidenceIds: ['ev-3'],
            },
        ],
        evidence: [
            { id: 'ev-1', filePath: 'src/a.java', startLine: 1, endLine: 1 },
            { id: 'ev-2', filePath: 'src/b.java', startLine: 2, endLine: 2 },
            { id: 'ev-3', filePath: 'src/c.java', startLine: 3, endLine: 3 },
        ],
    };
}

function makeInputs(overrides: Partial<SemanticComposerInputs> = {}): SemanticComposerInputs {
    const scenarios: ScenarioCandidate[] = [
        {
            title: 'POST /api/v1/orders 요청 처리',
            trigger: 'http',
            entryPointObjectId: 'svc-order',
            description: 'HTTP POST /api/v1/orders 진입점',
            evidenceIds: ['ev-1'],
        },
    ];
    return {
        workspaceId: 'ws-1',
        signals: makeSignals(),
        scenarios,
        llmModel: 'claude-opus-4-7',
        ...overrides,
    };
}

function makeDraft(overrides: Partial<SemanticLlmDraft> = {}): SemanticLlmDraft {
    return {
        responsibility: '주문 생성과 결제 연동을 책임지는 도메인',
        state: [
            { name: 'Order', type: 'Order', description: '주문 엔터티', evidenceIds: ['ev-1'] },
        ],
        actions: [
            {
                name: 'createOrder',
                description: '주문을 생성한다',
                params: [{ name: 'payload', type: 'OrderRequest' }],
                trigger: 'http',
                evidenceIds: ['ev-1'],
            },
        ],
        invariants: [
            {
                description: '주문 금액은 음수일 수 없다',
                failureMode: 'ValidationException',
                evidenceIds: ['ev-1'],
            },
        ],
        events: [
            {
                name: 'OrderCreated',
                direction: 'publish',
                channel: 'order.created',
                description: '주문 생성 후 발행',
                evidenceIds: ['ev-2'],
            },
        ],
        collaborators: [
            {
                targetObjectId: 'svc-payment',
                targetName: 'payment-service',
                targetDomainId: 'dom-payment',
                relationType: 'call',
                reason: '결제 처리 요청',
                evidenceIds: [],
            },
        ],
        scenarios: [
            {
                title: '주문 생성 흐름',
                steps: ['사용자가 주문 요청', '주문 생성', 'OrderCreated 발행'],
                entryPointObjectId: 'svc-order',
                evidenceIds: ['ev-1'],
            },
        ],
        ...overrides,
    };
}

describe('composeDomainSemanticProfile', () => {
    it('T1: LLM draft → DomainSemanticProfile 합성 (schemaVersion, status=DRAFT, llmModel, domainId 채움)', async () => {
        const generate: GenerateSemanticProfileFn = vi.fn().mockResolvedValue(makeDraft());
        const profile = await composeDomainSemanticProfile(makeInputs(), generate);

        expect(profile.schemaVersion).toBe('1.0');
        expect(profile.workspaceId).toBe('ws-1');
        expect(profile.domainId).toBe('dom-order');
        expect(profile.domainName).toBe('주문 도메인');
        expect(profile.status).toBe('DRAFT');
        expect(profile.llmModel).toBe('claude-opus-4-7');
        expect(profile.responsibility).toContain('주문');
        expect(profile.state).toHaveLength(1);
        expect(profile.actions).toHaveLength(1);
        expect(profile.events).toHaveLength(1);
        expect(profile.scenarios).toHaveLength(1);
        expect(profile.evidence).toHaveLength(3);
        expect(typeof profile.generatedAt).toBe('string');
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('T2: LLM 이 잘못된 evidenceId 를 돌려주면 해당 id 는 drop, 유효한 id 는 유지', async () => {
        const draft = makeDraft({
            state: [
                {
                    name: 'Order',
                    type: 'Order',
                    description: '주문 엔터티',
                    evidenceIds: ['ev-1', 'ev-nonexistent'],
                },
            ],
        });
        const generate: GenerateSemanticProfileFn = vi.fn().mockResolvedValue(draft);
        const profile = await composeDomainSemanticProfile(makeInputs(), generate);

        expect(profile.state[0]?.evidenceIds).toEqual(['ev-1']);
    });

    it('T3: generate 에 전달되는 prompt 에 도메인 이름/액션/이벤트/시나리오 후보가 포함', async () => {
        const generate = vi.fn<GenerateSemanticProfileFn>().mockResolvedValue(makeDraft());
        await composeDomainSemanticProfile(makeInputs(), generate);

        const [prompt] = generate.mock.calls[0] ?? [];
        expect(prompt).toBeDefined();
        expect(prompt).toContain('주문 도메인');
        expect(prompt).toContain('POST');
        expect(prompt).toContain('/api/v1/orders');
        expect(prompt).toContain('order.created');
        expect(prompt).toContain('orders'); // dbAccess table
        expect(prompt).toContain('payment-service'); // collaborator
    });

    it('T4: generate 가 던진 예외는 그대로 전파', async () => {
        const generate: GenerateSemanticProfileFn = vi.fn().mockRejectedValue(new Error('LLM 503'));
        await expect(composeDomainSemanticProfile(makeInputs(), generate)).rejects.toThrow('LLM 503');
    });
});
