import { buildDomainReviewPrompt } from '../../llm/domainReviewPrompt';
import type { LlmCandidateReview } from './types';
import type { StructuralClusterCandidate } from './structuralClustering';

export interface DomainReviewerInputs {
    candidate: StructuralClusterCandidate;
    objectNameById: Map<string, string>;
    siblingCandidateIds: string[];
}

export type GenerateDomainReviewFn = (
    prompt: string,
    inputs: DomainReviewerInputs,
) => Promise<LlmCandidateReview>;

export async function reviewDomainCandidate(
    inputs: DomainReviewerInputs,
    generate: GenerateDomainReviewFn,
): Promise<LlmCandidateReview> {
    const memberNames = inputs.candidate.members.map((m) => inputs.objectNameById.get(m.objectId) ?? m.objectId);

    const memberDetails = inputs.candidate.members.map((m) => {
        const name = inputs.objectNameById.get(m.objectId) ?? m.objectId;
        const seeds = m.seedSources.length > 0 ? m.seedSources.join(', ') : '(seed 없음)';
        return `${m.objectId} | ${name} | affinity=${m.affinity.toFixed(2)} | seeds=${seeds}`;
    });

    const prompt = buildDomainReviewPrompt({
        candidateId: inputs.candidate.slug,
        autoName: inputs.candidate.autoName,
        memberNames,
        memberDetails,
        signals: inputs.candidate.signals,
        siblingCandidateIds: inputs.siblingCandidateIds.filter((id) => id !== inputs.candidate.slug),
    });

    return generate(prompt, inputs);
}
