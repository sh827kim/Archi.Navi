/**
 * LLM 프롬프트 템플릿 테스트
 * 설계 참조: docs/09-llm-inference-filtering.md §4
 */
import { describe, it, expect } from 'vitest';
import { buildRelationAssessmentPrompt } from '../../llm/prompts.js';
import type { CandidateContext } from '../../llm/types.js';

function makeContext(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return {
    candidateId: '00000000-0000-0000-0000-000000000001',
    subjectName: 'order-service',
    objectName: 'payment-service',
    relationType: 'call',
    confidence: 0.7,
    evidences: [
      {
        filePath: 'src/main/java/OrderController.java',
        lineStart: 42,
        lineEnd: 45,
        excerpt: 'restTemplate.getForObject("http://payment-service/api/pay", ...)',
        evidenceType: 'FILE',
      },
    ],
    metadata: { source: 'code_signal' },
    ...overrides,
  };
}

describe('buildRelationAssessmentPrompt', () => {
  it('T1: 기본 컨텍스트로 프롬프트 생성 — subject, object, relationType 포함', () => {
    const ctx = makeContext();
    const prompt = buildRelationAssessmentPrompt(ctx);

    expect(prompt).toContain('order-service');
    expect(prompt).toContain('payment-service');
    expect(prompt).toContain('call');
    expect(prompt).toContain('0.7');
    expect(prompt).toContain('OrderController.java');
    expect(prompt).toContain('42');
    expect(prompt).toContain('restTemplate.getForObject');
  });

  it('T2: evidence 없는 경우 — "근거 없음" 또는 빈 evidence 섹션', () => {
    const ctx = makeContext({ evidences: [] });
    const prompt = buildRelationAssessmentPrompt(ctx);

    expect(prompt).toContain('order-service');
    expect(prompt).toContain('payment-service');
    // evidence가 없을 때 해당 사실이 프롬프트에 나타나야 함
    expect(prompt).toMatch(/근거 없음|evidence.*없|No evidence/i);
  });

  it('T3: evidence excerpt 500자 초과 시 truncate', () => {
    const longExcerpt = 'x'.repeat(800);
    const ctx = makeContext({
      evidences: [
        {
          filePath: 'src/Long.java',
          lineStart: 1,
          lineEnd: 50,
          excerpt: longExcerpt,
          evidenceType: 'FILE',
        },
      ],
    });
    const prompt = buildRelationAssessmentPrompt(ctx);

    // 프롬프트에 800자 전체가 포함되면 안됨
    expect(prompt.length).toBeLessThan(longExcerpt.length + 1000);
    // truncate 표시가 있어야 함
    expect(prompt).toContain('...');
  });
});
