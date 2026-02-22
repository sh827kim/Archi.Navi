/**
 * LLM 추론 후보 필터링 — 프롬프트 템플릿
 * 설계 참조: docs/09-llm-inference-filtering.md §4
 */
import type { CandidateContext } from './types.js';

/** Evidence excerpt 최대 길이 */
const MAX_EXCERPT_LENGTH = 500;

/** Evidence excerpt를 최대 길이로 truncate */
function truncateExcerpt(excerpt: string | null): string {
  if (!excerpt) return '(내용 없음)';
  if (excerpt.length <= MAX_EXCERPT_LENGTH) return excerpt;
  return excerpt.slice(0, MAX_EXCERPT_LENGTH) + '...';
}

/**
 * Relation 후보 검증 프롬프트 생성
 * LLM에 전달할 구조화된 프롬프트를 생성한다.
 */
export function buildRelationAssessmentPrompt(context: CandidateContext): string {
  const { subjectName, objectName, relationType, confidence, evidences } = context;

  // Evidence 섹션 구성
  let evidenceSection: string;
  if (evidences.length === 0) {
    evidenceSection = '- (근거 없음)';
  } else {
    evidenceSection = evidences
      .map((e) => {
        const location = e.filePath
          ? `${e.filePath}:${e.lineStart ?? '?'}-${e.lineEnd ?? '?'}`
          : '(경로 없음)';
        const excerpt = truncateExcerpt(e.excerpt);
        return `- [${e.evidenceType}] ${location}\n  "${excerpt}"`;
      })
      .join('\n');
  }

  return `당신은 마이크로서비스 아키텍처 분석 전문가입니다.
아래 추론된 서비스 관계 후보가 유효한지 검증해주세요.

## 후보 정보
- Subject: ${subjectName}
- Relation: ${relationType}
- Object: ${objectName}
- Confidence: ${confidence}

## Evidence (근거)
${evidenceSection}

## 검증 기준
1. 관계 타입이 evidence와 일치하는가?
2. subject와 object가 실제 서비스 간 관계로 보이는가?
3. 테스트 코드, mock, 주석에서 추출된 false positive는 아닌가?
4. URL 패턴이나 설정이 실제 서비스 연결을 나타내는가?

## 응답 형식 (JSON)
{
  "verdict": "LIKELY_VALID" | "UNCERTAIN" | "LIKELY_FALSE_POSITIVE",
  "confidenceAdjustment": <-0.3 ~ +0.2>,
  "reasoning": "<판정 근거를 한국어로 1~2문장>",
  "reviewPriority": "HIGH" | "MEDIUM" | "LOW"
}`;
}
