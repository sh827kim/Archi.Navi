/**
 * LLM 배치 처리기
 * 후보 컨텍스트 목록을 배치로 분할하여 LLM 호출
 * 설계 참조: docs/09-llm-inference-filtering.md §5
 */
import type {
  CandidateContext,
  GenerateAssessmentFn,
  BatchItemResult,
} from './types.js';
import { clampConfidenceAdjustment } from './types.js';
import { buildRelationAssessmentPrompt } from './prompts.js';

/** 동시 LLM 호출 제한 */
const MAX_CONCURRENCY = 3;

/**
 * 단일 후보에 대해 LLM 평가 실행
 * 실패 시 error 필드에 메시지를 담아 반환 (throw하지 않음)
 */
async function processOne(
  context: CandidateContext,
  generateFn: GenerateAssessmentFn,
): Promise<BatchItemResult> {
  try {
    const prompt = buildRelationAssessmentPrompt(context);
    const assessment = await generateFn(prompt, context);

    // confidenceAdjustment clamp
    assessment.confidenceAdjustment = clampConfidenceAdjustment(
      assessment.confidenceAdjustment,
    );

    return {
      candidateId: context.candidateId,
      success: true,
      assessment,
    };
  } catch (err) {
    return {
      candidateId: context.candidateId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * concurrency-limited 실행
 * p-limit 없이 수동 세마포어로 구현
 */
async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<BatchItemResult>,
  concurrency: number,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * 후보 컨텍스트 배열을 배치로 처리
 * @param contexts 후보 컨텍스트 배열
 * @param generateFn LLM 호출 함수
 * @param batchSize 배치 크기 (기본 10)
 * @returns 각 후보별 처리 결과
 */
export async function processBatch(
  contexts: CandidateContext[],
  generateFn: GenerateAssessmentFn,
  batchSize: number = 10,
): Promise<BatchItemResult[]> {
  if (contexts.length === 0) return [];

  const allResults: BatchItemResult[] = [];

  // 배치 분할 처리
  for (let i = 0; i < contexts.length; i += batchSize) {
    const batch = contexts.slice(i, i + batchSize);
    const batchResults = await runWithConcurrency(
      batch,
      (ctx) => processOne(ctx, generateFn),
      MAX_CONCURRENCY,
    );
    allResults.push(...batchResults);
  }

  return allResults;
}
