/**
 * Answer Composer (Phase 2, 2-3)
 *
 * LLM이 증거 기반 구조화된 답변을 출력하도록 하는 시스템 프롬프트 생성기.
 *
 * 설계 참조: docs/archive/ArchiNavi_AI_Reasoning_레이어_설계안_v1.md §5
 * 로드맵: docs/08-roadmap.md §2-3
 *
 * 응답 형식 (LLM이 따라야 할 템플릿):
 *   **결론:** [핵심 결론 한 문장]
 *   **신뢰도:** [최대 confidence 값]
 *   **증거 목록:**
 *   - [증거 1]
 *   - [증거 2]
 *   **요약:** [분석 결과 요약]
 *   **딥링크:** [/mapping?...]
 */
import type { EvidenceChain } from './evidence-assembler';

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 쿼리 타입과 첫 번째 증거 항목을 기반으로 딥링크 URL을 생성한다.
 *
 * - IMPACT_ANALYSIS: 영향을 주는 source 서비스 강조
 * - PATH_DISCOVERY: source → target 경로 강조
 * - USAGE_DISCOVERY: 사용되는 target 서비스 강조
 * - 기타: IMPACT_ANALYSIS와 동일
 */
function buildDeepLink(chain: EvidenceChain): string {
    const first = chain.items[0]!;

    if (chain.queryType === 'PATH_DISCOVERY') {
        return `/mapping?from=${first.sourceId}&to=${first.targetId}`;
    }
    if (chain.queryType === 'USAGE_DISCOVERY') {
        return `/mapping?highlight=${first.targetId}`;
    }
    // IMPACT_ANALYSIS (default)
    return `/mapping?highlight=${first.sourceId}`;
}

// ─── 핵심 함수 ────────────────────────────────────────────────────────────────

/**
 * EvidenceChain을 기반으로 Answer Composer 형식 지침을 생성한다.
 *
 * route.ts의 시스템 프롬프트 말미에 추가되어 LLM의 출력 형식을 강제한다.
 * 빈 체인이면 빈 문자열을 반환한다(LLM이 자유 형식으로 답변).
 */
export function buildAnswerComposerSystemPrompt(chain: EvidenceChain): string {
    if (chain.items.length === 0) return '';

    const maxConfidence = Math.max(...chain.items.map((item) => item.confidence));
    const deepLink = buildDeepLink(chain);

    return `

## Answer Composer 응답 형식 (필수)

위 증거 데이터를 바탕으로 반드시 아래 형식으로 답변하세요:

**결론:** [핵심 결론을 한 문장으로]
**신뢰도:** [최대 confidence 값, 예: ${maxConfidence.toFixed(2)}]
**증거 목록:**
- [증거 설명 (서비스 관계, 파일 위치 포함)]
- [추가 증거...]
**요약:** [분석 결과 요약 (2-3 문장)]
**딥링크:** ${deepLink}

규칙:
- 이 형식을 반드시 유지하세요
- 증거 데이터에 없는 사실은 추가하지 마세요
- confidence 값은 제공된 데이터 기준으로 작성하세요
- 증거가 부족하면 **결론:** "확정 불가"를 명시하세요`;
}
