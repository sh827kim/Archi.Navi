import { buildDomainReviewPrompt } from '../../llm/domainReviewPrompt';
import type { LlmCandidateReview } from './types';
import type { StructuralClusterCandidate } from './structuralClustering';

export const MAX_REVIEW_PROMPT_MEMBERS = 12;
export const MAX_REVIEW_PROMPT_SEED_SOURCES = 8;

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
  const visibleMembers = inputs.candidate.members.slice(0, MAX_REVIEW_PROMPT_MEMBERS);
  const omittedMemberCount = Math.max(0, inputs.candidate.members.length - visibleMembers.length);
  const memberNames = visibleMembers.map(
    (m) => inputs.objectNameById.get(m.objectId) ?? m.objectId,
  );
  if (omittedMemberCount > 0) {
    memberNames.push(`... ${omittedMemberCount} more members omitted for prompt size`);
  }

  const memberDetails = visibleMembers.map((m) => {
    const name = inputs.objectNameById.get(m.objectId) ?? m.objectId;
    const visibleSeeds = m.seedSources.slice(0, MAX_REVIEW_PROMPT_SEED_SOURCES);
    const omittedSeedCount = Math.max(0, m.seedSources.length - visibleSeeds.length);
    const seeds = formatSeedSources(visibleSeeds, omittedSeedCount);
    return `${m.objectId} | ${name} | affinity=${m.affinity.toFixed(2)} | seeds=${seeds}`;
  });
  if (omittedMemberCount > 0) {
    memberDetails.push(`... ${omittedMemberCount} more members omitted for prompt size`);
  }

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

function formatSeedSources(seedSources: string[], omittedSeedCount: number): string {
  if (seedSources.length === 0) return '(seed 없음)';
  const suffix = omittedSeedCount > 0 ? `, ... ${omittedSeedCount} more seeds omitted` : '';
  return `${seedSources.join(', ')}${suffix}`;
}
