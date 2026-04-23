import { computeRelationCohesion } from './relationCohesion';
import { reviewDomainCandidate } from './llmReviewer';
import type { GenerateDomainReviewFn } from './llmReviewer';
import { runStructuralClustering } from './structuralClustering';
import type {
    CandidateMemberScore,
    DiscoveryInputs,
    DomainCandidate,
    LlmSplitSelector,
} from './types';

export const SECONDARY_AFFINITY_THRESHOLD = 0.5;

export interface RunDomainDiscoveryArgs {
    inputs: DiscoveryInputs;
    review?: GenerateDomainReviewFn;
}

export interface RunDomainDiscoveryResult {
    candidates: DomainCandidate[];
}

export async function runDomainDiscovery(args: RunDomainDiscoveryArgs): Promise<RunDomainDiscoveryResult> {
    const { candidates: structural } = runStructuralClustering(args.inputs);

    const primaryByObject = new Map<string, { slug: string; affinity: number }>();
    for (const cand of structural) {
        for (const member of cand.members) {
            const current = primaryByObject.get(member.objectId);
            if (!current || member.affinity > current.affinity) {
                primaryByObject.set(member.objectId, { slug: cand.slug, affinity: member.affinity });
            }
        }
    }

    const filtered = structural
        .map((cand) => {
            const members: CandidateMemberScore[] = cand.members.filter((member) => {
                const primary = primaryByObject.get(member.objectId);
                if (!primary) return false;
                if (primary.slug === cand.slug) return true;
                return member.affinity >= SECONDARY_AFFINITY_THRESHOLD;
            });
            return { ...cand, members };
        })
        .filter((cand) => cand.members.length > 0);

    const finalCandidates: DomainCandidate[] = filtered.map((cand) => {
        const { members } = computeRelationCohesion({ members: cand.members, relations: args.inputs.relations });
        return {
            id: cand.slug,
            autoName: cand.autoName,
            signals: cand.signals,
            members,
            review: null,
            origin: 'structural',
            parentCandidateId: null,
            splitReason: null,
            splitEvidenceHints: [],
        } satisfies DomainCandidate;
    });

    if (args.review) {
        const objectNameById = buildObjectNameLookup(args.inputs);
        const allIds = finalCandidates.map((c) => c.id);
        for (const cand of finalCandidates) {
            try {
                cand.review = await reviewDomainCandidate(
                    {
                        candidate: {
                            slug: cand.id,
                            autoName: cand.autoName,
                            signals: cand.signals,
                            members: cand.members,
                        },
                        objectNameById,
                        siblingCandidateIds: allIds,
                    },
                    args.review,
                );
            } catch (error) {
                console.warn(`[runDomainDiscovery] LLM review failed for candidate "${cand.id}"`, error);
                cand.review = null;
            }
        }
    }

    return { candidates: materializeSplitCandidates(finalCandidates) };
}

function materializeSplitCandidates(candidates: DomainCandidate[]): DomainCandidate[] {
    const result: DomainCandidate[] = [];

    for (const candidate of candidates) {
        const assignedMemberIds = new Set<string>();
        const splitCandidates: DomainCandidate[] = [];

        for (const suggestion of candidate.review?.splitSuggestions ?? []) {
            const selectors = normalizeSplitSelectors(suggestion.memberSelectors, suggestion.evidenceHints);
            const matchedMembers = candidate.members.filter(
                (member) => !assignedMemberIds.has(member.objectId) && selectors.some((selector) => memberMatchesSelector(member, selector)),
            );

            if (matchedMembers.length === 0) continue;
            matchedMembers.forEach((m) => assignedMemberIds.add(m.objectId));

            splitCandidates.push({
                id: `${candidate.id}--split-${slugify(suggestion.suggestedName)}`,
                autoName: suggestion.suggestedName,
                signals: candidate.signals,
                members: matchedMembers,
                review: {
                    coherent: true,
                    suggestedName: suggestion.suggestedName,
                    responsibilityHint: suggestion.responsibilityHint,
                    mergeWithCandidateId: null,
                    splitSuggestions: [],
                },
                origin: 'llm_split',
                parentCandidateId: candidate.id,
                splitReason: suggestion.reason,
                splitEvidenceHints: suggestion.evidenceHints,
            });
        }

        if (splitCandidates.length === 0) {
            result.push(candidate);
            continue;
        }

        const remainingMembers = candidate.members.filter((m) => !assignedMemberIds.has(m.objectId));
        if (remainingMembers.length > 0) {
            result.push({ ...candidate, members: remainingMembers });
        }
        result.push(...splitCandidates);
    }

    return result;
}

function normalizeSplitSelectors(selectors: LlmSplitSelector[], evidenceHints: string[]): LlmSplitSelector[] {
    const normalized = selectors
        .map((s) => ({ ...s, value: s.value.trim() }))
        .filter((s) => s.value.length > 0);

    if (normalized.length > 0) return normalized;
    return evidenceHints.map((hint) => ({ kind: 'seed_source' as const, value: hint }));
}

function memberMatchesSelector(member: CandidateMemberScore, selector: LlmSplitSelector): boolean {
    const value = selector.value.toLowerCase();
    if (!value) return false;

    if (selector.kind === 'seed_source' || selector.kind === 'route_prefix') {
        return member.seedSources.some((source) => source.toLowerCase().includes(value));
    }

    if (selector.kind === 'object_name') {
        return member.seedSources.some((source) => source.toLowerCase() === `name:${value}`);
    }

    if (selector.kind === 'class_name') {
        return member.seedSources.some((source) => source.toLowerCase().startsWith('class:') && source.toLowerCase().includes(value));
    }

    if (selector.kind === 'file_path') {
        return member.seedSources.some((source) => source.toLowerCase().startsWith('file:') && source.toLowerCase().includes(value));
    }

    if (selector.kind === 'table_name') {
        return member.seedSources.some((source) => source.toLowerCase().startsWith('table:') && source.toLowerCase().includes(value));
    }

    return false;
}

function buildObjectNameLookup(inputs: DiscoveryInputs): Map<string, string> {
    const map = new Map<string, string>();
    for (const obj of inputs.objects) map.set(obj.id, obj.displayName ?? obj.name);
    return map;
}

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'candidate';
}
