/**
 * LLM 추론 후보 필터링 — 타입 정의
 * 설계 참조: docs/09-llm-inference-filtering.md §3
 */

/** LLM 판정 결과 (verdict) */
export type LlmVerdict = 'LIKELY_VALID' | 'UNCERTAIN' | 'LIKELY_FALSE_POSITIVE';

/** 검토 우선순위 */
export type ReviewPriority = 'HIGH' | 'MEDIUM' | 'LOW';

/** LLM이 후보에 대해 내린 평가 */
export interface LlmAssessment {
  verdict: LlmVerdict;
  /** 신뢰도 조정값 (-0.3 ~ +0.2), 범위 초과 시 clamp */
  confidenceAdjustment: number;
  /** 판정 근거 (자연어) */
  reasoning: string;
  /** 검토 우선순위 제안 */
  reviewPriority: ReviewPriority;
  /** LLM 모델 식별자 */
  model: string;
  /** 평가 시각 (ISO 8601) */
  assessedAt: string;
}

/** Evidence 요약 (LLM 컨텍스트용) */
export interface EvidenceSummary {
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  excerpt: string | null;
  evidenceType: string;
}

/** 후보 + Evidence 컨텍스트 (LLM에 전달) */
export interface CandidateContext {
  candidateId: string;
  subjectName: string;
  objectName: string;
  relationType: string;
  confidence: number;
  evidences: EvidenceSummary[];
  metadata: Record<string, unknown>;
}

/** LLM 호출 추상화 — DI 계약 */
export type GenerateAssessmentFn = (
  prompt: string,
  context: CandidateContext,
) => Promise<LlmAssessment>;

/** 필터 실행 요청 */
export interface LlmFilterRequest {
  workspaceId: string;
  /** 필터링 대상 후보 ID 목록 (비어있으면 전체 PENDING) */
  candidateIds?: string[];
  /** 배치 크기 (기본 10) */
  batchSize?: number;
}

/** 필터 실행 결과 */
export interface LlmFilterResult {
  processedCount: number;
  stats: {
    likelyValid: number;
    uncertain: number;
    likelyFalsePositive: number;
  };
  durationMs: number;
}

/** 배치 처리 개별 결과 */
export interface BatchItemResult {
  candidateId: string;
  success: boolean;
  assessment?: LlmAssessment;
  error?: string;
}

/** confidenceAdjustment 유효 범위 */
export const CONFIDENCE_ADJ_MIN = -0.3;
export const CONFIDENCE_ADJ_MAX = 0.2;

/** confidenceAdjustment를 유효 범위 내로 제한 */
export function clampConfidenceAdjustment(value: number): number {
  return Math.max(CONFIDENCE_ADJ_MIN, Math.min(CONFIDENCE_ADJ_MAX, value));
}
