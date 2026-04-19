/**
 * Phase 1 도메인 발견 — 후보 LLM 검토 단계.
 * 결정적 클러스터링 후 후보별로 1회 호출 (저비용). 응답 zod 스키마는 호출 측에서 강제.
 *
 * 입출력 분리: provider 어댑터(=GenerateDomainReviewFn) 를 DI 로 주입받아 mock 테스트가 쉽다.
 */
import { buildDomainReviewPrompt } from '../../llm/domainReviewPrompt';
import type { LlmCandidateReview } from './types';
import type { StructuralClusterCandidate } from './structuralClustering';

export interface DomainReviewerInputs {
    candidate: StructuralClusterCandidate;
    /** 멤버 이름 lookup (objectId → displayName/name) */
    objectNameById: Map<string, string>;
    /** 같은 발견 라운드에서 함께 검토되는 다른 후보 id 목록 */
    siblingCandidateIds: string[];
}

/** LLM 호출 추상화 — prompt → review */
export type GenerateDomainReviewFn = (
    prompt: string,
    inputs: DomainReviewerInputs,
) => Promise<LlmCandidateReview>;

export async function reviewDomainCandidate(
    inputs: DomainReviewerInputs,
    generate: GenerateDomainReviewFn,
): Promise<LlmCandidateReview> {
    const memberNames = inputs.candidate.members
        .map((m) => inputs.objectNameById.get(m.objectId) ?? m.objectId)
        .slice(0, 10);

    const prompt = buildDomainReviewPrompt({
        candidateId: inputs.candidate.slug,
        autoName: inputs.candidate.autoName,
        memberNames,
        signals: inputs.candidate.signals,
        siblingCandidateIds: inputs.siblingCandidateIds.filter((id) => id !== inputs.candidate.slug),
    });

    return generate(prompt, inputs);
}
