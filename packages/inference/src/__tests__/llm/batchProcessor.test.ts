/**
 * LLM 배치 처리기 테스트
 * 설계 참조: docs/09-llm-inference-filtering.md §5
 */
import { describe, it, expect } from 'vitest';
import { processBatch } from '@/llm/batchProcessor';
import type {
  CandidateContext,
  GenerateAssessmentFn,
  LlmAssessment,
} from '@/llm/types';

function makeContext(id: string, name: string): CandidateContext {
  return {
    candidateId: id,
    subjectName: `subject-${name}`,
    objectName: `object-${name}`,
    relationType: 'call',
    confidence: 0.7,
    evidences: [],
    metadata: {},
  };
}

function makeMockLlm(delay = 0): GenerateAssessmentFn {
  return async (_prompt: string, _ctx: CandidateContext): Promise<LlmAssessment> => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return {
      verdict: 'LIKELY_VALID',
      confidenceAdjustment: 0.1,
      reasoning: 'mock valid',
      reviewPriority: 'LOW',
      model: 'mock',
      assessedAt: new Date().toISOString(),
    };
  };
}

describe('processBatch', () => {
  it('T10: batchSize별 분할 처리 — 모든 항목 처리됨', async () => {
    const contexts = Array.from({ length: 5 }, (_, i) =>
      makeContext(`id-${i}`, `svc-${i}`),
    );

    const results = await processBatch(contexts, makeMockLlm(), 2);

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.every((r) => r.assessment?.verdict === 'LIKELY_VALID')).toBe(true);
  });

  it('T11: 개별 실패 시 다른 후보 계속 처리', async () => {
    const contexts = [
      makeContext('ok-1', 'ok1'),
      makeContext('fail-1', 'fail1'),
      makeContext('ok-2', 'ok2'),
    ];

    let callIdx = 0;
    const failingMock: GenerateAssessmentFn = async (_p, _c) => {
      callIdx++;
      if (callIdx === 2) {
        throw new Error('LLM API timeout');
      }
      return {
        verdict: 'LIKELY_VALID',
        confidenceAdjustment: 0.1,
        reasoning: 'ok',
        reviewPriority: 'LOW',
        model: 'mock',
        assessedAt: new Date().toISOString(),
      };
    };

    const results = await processBatch(contexts, failingMock, 10);

    expect(results).toHaveLength(3);
    // 첫 번째: 성공
    expect(results[0]?.success).toBe(true);
    // 두 번째: 실패
    expect(results[1]?.success).toBe(false);
    expect(results[1]?.error).toContain('LLM API timeout');
    // 세 번째: 성공 (실패에 영향 없음)
    expect(results[2]?.success).toBe(true);
  });

  it('T12: 빈 배열 입력 시 빈 결과 반환', async () => {
    const results = await processBatch([], makeMockLlm(), 10);

    expect(results).toHaveLength(0);
  });
});
