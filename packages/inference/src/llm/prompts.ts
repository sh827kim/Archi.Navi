/**
 * LLM 추론 후보 필터링 — 프롬프트 템플릿
 * 설계 참조: docs/09-llm-inference-filtering.md §4
 */
import type { CandidateContext } from './types';
import { truncateOptionalText } from './textUtils';

/** Evidence excerpt 최대 길이 */
const MAX_EXCERPT_LENGTH = 500;

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
        const excerpt = truncateOptionalText(e.excerpt, MAX_EXCERPT_LENGTH, '(내용 없음)', '...');
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

export function buildRelationExplanationPrompt(contexts: CandidateContext[]): string {
  if (contexts.length === 0) {
    return '설명할 관계 후보가 없습니다.';
  }

  const subjectName = contexts[0]?.subjectName ?? 'unknown-subject';
  const candidateSection = contexts.map((context) => {
    const evidenceSection = context.evidences.length === 0
      ? '- (근거 없음)'
      : context.evidences.map((evidence) => {
        const location = evidence.filePath
          ? `${evidence.filePath}:${evidence.lineStart ?? '?'}-${evidence.lineEnd ?? '?'}`
          : '(경로 없음)';
        const excerpt = truncateOptionalText(
          evidence.excerpt,
          MAX_EXCERPT_LENGTH,
          '(내용 없음)',
          '...',
        );
        return `- [${evidence.evidenceType}] ${location}\n  "${excerpt}"`;
      }).join('\n');

    return `### Candidate ${context.candidateId}
- Relation: ${context.relationType}
- Object: ${context.objectName}
- Confidence: ${context.confidence}
- Evidence:
${evidenceSection}`;
  }).join('\n\n');

  return `당신은 마이크로서비스 아키텍처 분석 전문가입니다.
아래는 동일한 Subject 서비스(${subjectName})에서 추론된 관계 후보들입니다.
각 후보에 대해 승인 판단에 도움이 되는 설명을 한국어 1~2문장으로 작성하세요.

${candidateSection}

응답 형식(JSON):
{
  "explanations": [
    {
      "candidateId": "<candidate id>",
      "summary": "<왜 이 관계가 존재하는지 설명>"
    }
  ]
}`;
}
