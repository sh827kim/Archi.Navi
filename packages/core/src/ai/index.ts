/**
 * AI 레이어 모듈 (Phase 2)
 * Evidence Assembler: 쿼리 결과 → 증거 체인 구조화
 * Answer Composer: LLM 구조화 응답 형식 강제
 * Domain Summary Formatter: DOMAIN_SUMMARY 집계 결과 → LLM 컨텍스트 텍스트
 *
 * 설계 참조: docs/archive/ArchiNavi_AI_Reasoning_레이어_설계안_v1.md
 * 로드맵: docs/08-roadmap.md §2-2, §2-3, §2-4
 */
export {
    assembleEvidenceChain,
    formatEvidenceChain,
} from './evidence-assembler';

export type { EvidenceItem, EvidenceChain, AssembleOptions } from './evidence-assembler';

export { buildAnswerComposerSystemPrompt } from './answer-composer';

export {
    formatDomainSummary,
    buildDomainAnswerComposerPrompt,
} from './domain-summary-formatter';
