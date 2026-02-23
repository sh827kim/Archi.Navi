/**
 * Answer Composer 단위 테스트 (Phase 2, 2-3)
 * buildAnswerComposerSystemPrompt 검증
 */
import { describe, it, expect } from 'vitest';
import { buildAnswerComposerSystemPrompt } from '../../ai/answer-composer';
import type { EvidenceChain } from '../../ai/evidence-assembler';

// ─── 테스트용 EvidenceChain 팩토리 ────────────────────────────────────────────

function makeChain(overrides: Partial<EvidenceChain> = {}): EvidenceChain {
    return {
        items: [
            {
                type: 'code',
                sourceId: 'svc-order',
                sourceName: '주문 서비스',
                targetId: 'svc-payment',
                targetName: '결제 서비스',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                filePath: 'OrderController.java',
                lineStart: 120,
                lineEnd: 145,
                excerpt: 'restTemplate.getForObject(...)',
                score: 6.37,
            },
            {
                type: 'rollup',
                sourceId: 'svc-payment',
                sourceName: '결제 서비스',
                targetId: 'svc-pg',
                targetName: 'PG 서비스',
                relationType: 'call',
                confidence: 0.85,
                edgeWeight: 3,
                hop: 1,
                score: 1.275,
            },
        ],
        totalCount: 2,
        truncated: false,
        queryType: 'IMPACT_ANALYSIS',
        ...overrides,
    };
}

// ─── buildAnswerComposerSystemPrompt 테스트 ───────────────────────────────────

describe('buildAnswerComposerSystemPrompt', () => {
    it('빈 체인이면 빈 문자열을 반환해야 한다', () => {
        const emptyChain: EvidenceChain = {
            items: [],
            totalCount: 0,
            truncated: false,
            queryType: 'IMPACT_ANALYSIS',
        };
        expect(buildAnswerComposerSystemPrompt(emptyChain)).toBe('');
    });

    it('필수 섹션 헤더를 모두 포함해야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain());
        expect(result).toContain('**결론:**');
        expect(result).toContain('**신뢰도:**');
        expect(result).toContain('**증거 목록:**');
        expect(result).toContain('**요약:**');
        expect(result).toContain('**딥링크:**');
    });

    it('IMPACT_ANALYSIS: sourceId를 highlight 파라미터로 사용해야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain({ queryType: 'IMPACT_ANALYSIS' }));
        expect(result).toContain('/mapping?highlight=svc-order');
    });

    it('PATH_DISCOVERY: from=sourceId&to=targetId 형식의 딥링크를 생성해야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain({ queryType: 'PATH_DISCOVERY' }));
        expect(result).toContain('/mapping?from=svc-order&to=svc-payment');
    });

    it('USAGE_DISCOVERY: targetId를 highlight 파라미터로 사용해야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain({ queryType: 'USAGE_DISCOVERY' }));
        expect(result).toContain('/mapping?highlight=svc-payment');
    });

    it('가장 높은 confidence 값을 예시로 포함해야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain());
        // mockChain의 최대 confidence: 0.91
        expect(result).toContain('0.91');
    });

    it('알 수 없는 쿼리 타입은 IMPACT_ANALYSIS와 동일하게 sourceId highlight를 사용해야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain({ queryType: 'DOMAIN_SUMMARY' }));
        expect(result).toContain('/mapping?highlight=svc-order');
    });

    it('증거가 한 개인 경우에도 딥링크를 포함해야 한다', () => {
        const singleItemChain: EvidenceChain = {
            items: [
                {
                    type: 'rollup',
                    sourceId: 'svc-a',
                    sourceName: 'A 서비스',
                    targetId: 'svc-b',
                    targetName: 'B 서비스',
                    relationType: 'call',
                    confidence: 0.75,
                    edgeWeight: 2,
                    hop: 0,
                    score: 1.5,
                },
            ],
            totalCount: 1,
            truncated: false,
            queryType: 'IMPACT_ANALYSIS',
        };
        const result = buildAnswerComposerSystemPrompt(singleItemChain);
        expect(result).toContain('/mapping?highlight=svc-a');
    });

    it('LLM 규칙 지침이 포함되어야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain());
        expect(result).toContain('규칙');
        expect(result).toContain('확정 불가');
    });

    it('응답 형식 강제 안내가 포함되어야 한다', () => {
        const result = buildAnswerComposerSystemPrompt(makeChain());
        expect(result).toContain('Answer Composer');
    });

    it('최대 confidence가 여러 항목 중 가장 높은 값이어야 한다', () => {
        const chain = makeChain(); // confidence: 0.91, 0.85
        const result = buildAnswerComposerSystemPrompt(chain);
        // 0.91이 최대여야 함
        expect(result).toContain('0.91');
        // 0.85가 단독으로 앞서지 않아야 함 (정확한 최대값 사용 확인)
        expect(result).not.toMatch(/예.*0\.85/);
    });
});
