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
export const SPLIT_COHERENCE_CONFIDENCE_THRESHOLD = 0.7;

const NON_DOMAIN_ROUTE_SEGMENTS = new Set([
  'api',
  'apis',
  'rest',
  'graphql',
  'gql',
  'rpc',
  'grpc',
  'public',
  'internal',
  'private',
  'app',
  'web',
]);

export interface RunDomainDiscoveryArgs {
  inputs: DiscoveryInputs;
  review?: GenerateDomainReviewFn;
}

export interface RunDomainDiscoveryResult {
  candidates: DomainCandidate[];
}

export async function runDomainDiscovery(
  args: RunDomainDiscoveryArgs,
): Promise<RunDomainDiscoveryResult> {
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
    const { members } = computeRelationCohesion({
      members: cand.members,
      relations: args.inputs.relations,
    });
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

  return { candidates: materializeSplitCandidates(finalCandidates, args.inputs.relations) };
}

function materializeSplitCandidates(
  candidates: DomainCandidate[],
  relations: DiscoveryInputs['relations'],
): DomainCandidate[] {
  const result: DomainCandidate[] = [];

  for (const candidate of candidates) {
    const assignedMemberIds = new Set<string>();
    const splitCandidates: DomainCandidate[] = [];

    for (const [suggestionIndex, suggestion] of (
      candidate.review?.splitSuggestions ?? []
    ).entries()) {
      const selectors = normalizeSplitSelectors(
        suggestion.memberSelectors,
        suggestion.evidenceHints,
      );
      const matchedMembers = candidate.members.filter(
        (member) =>
          !assignedMemberIds.has(member.objectId) &&
          selectors.some((selector) => memberMatchesSelector(member, selector)),
      );

      if (matchedMembers.length === 0) continue;
      matchedMembers.forEach((m) => assignedMemberIds.add(m.objectId));

      splitCandidates.push(
        withRecomputedCohesion(
          {
            id: `${candidate.id}--split-${slugify(suggestion.suggestedName)}-${suggestionIndex + 1}`,
            autoName: suggestion.suggestedName,
            signals: candidate.signals,
            members: matchedMembers,
            review: {
              coherent: suggestion.confidence >= SPLIT_COHERENCE_CONFIDENCE_THRESHOLD,
              suggestedName: suggestion.suggestedName,
              responsibilityHint: suggestion.responsibilityHint,
              mergeWithCandidateId: null,
              splitSuggestions: [],
            },
            origin: 'llm_split',
            parentCandidateId: candidate.id,
            splitReason: suggestion.reason,
            splitEvidenceHints: suggestion.evidenceHints,
          },
          relations,
        ),
      );
    }

    if (splitCandidates.length === 0) {
      result.push(candidate);
      continue;
    }

    const remainingMembers = candidate.members.filter((m) => !assignedMemberIds.has(m.objectId));
    if (remainingMembers.length > 0) {
      result.push(
        withRecomputedCohesion(
          { ...candidate, members: remainingMembers, review: null },
          relations,
        ),
      );
    }
    result.push(...splitCandidates);
  }

  return result;
}

function withRecomputedCohesion(
  candidate: DomainCandidate,
  relations: DiscoveryInputs['relations'],
): DomainCandidate {
  const { members } = computeRelationCohesion({ members: candidate.members, relations });
  return { ...candidate, members };
}

function normalizeSplitSelectors(
  selectors: LlmSplitSelector[],
  evidenceHints: string[],
): LlmSplitSelector[] {
  const normalized = selectors
    .map((s) => ({ ...s, value: s.value.trim() }))
    .filter((s) => s.value.length > 0);

  if (normalized.length > 0) return normalized;
  return evidenceHints.map((hint) => ({ kind: 'seed_source' as const, value: hint }));
}

function memberMatchesSelector(member: CandidateMemberScore, selector: LlmSplitSelector): boolean {
  const value = selector.value.toLowerCase();
  if (!value) return false;

  if (selector.kind === 'seed_source') {
    return member.seedSources.some((source) => source.toLowerCase().includes(value));
  }

  if (selector.kind === 'route_prefix') {
    const selectorSegment = normalizeRouteSegment(value);
    if (!selectorSegment) return false;
    return member.seedSources.some((source) => {
      const routeSegment = normalizeRouteSourceSegment(source);
      return routeSegment === selectorSegment;
    });
  }

  if (selector.kind === 'object_name') {
    return member.seedSources.some((source) => source.toLowerCase() === `name:${value}`);
  }

  if (selector.kind === 'class_name') {
    return member.seedSources.some(
      (source) => source.toLowerCase().startsWith('class:') && source.toLowerCase().includes(value),
    );
  }

  if (selector.kind === 'file_path') {
    return member.seedSources.some(
      (source) => source.toLowerCase().startsWith('file:') && source.toLowerCase().includes(value),
    );
  }

  if (selector.kind === 'table_name') {
    return member.seedSources.some(
      (source) => source.toLowerCase().startsWith('table:') && source.toLowerCase().includes(value),
    );
  }

  return false;
}

function normalizeRouteSourceSegment(source: string): string | null {
  const [kind, ...rest] = source.split(':');
  if (!kind) return null;
  if (kind.toLowerCase() !== 'route') return null;
  return normalizeRouteSegment(rest.join(':'));
}

function normalizeRouteSegment(value: string): string | null {
  const segments = value
    .toLowerCase()
    .split(/[\/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !isDynamicRouteSegment(segment))
    .map((segment) => segment.replace(/[^a-z0-9가-힣]/g, ''));
  for (const segment of segments) {
    if (!isNonDomainRouteSegment(segment)) return segment;
  }
  return segments[segments.length - 1] ?? null;
}

function isDynamicRouteSegment(segment: string): boolean {
  return segment.startsWith(':') || segment.startsWith('{');
}

function isNonDomainRouteSegment(segment: string): boolean {
  return NON_DOMAIN_ROUTE_SEGMENTS.has(segment) || /^v\d+$/i.test(segment);
}

function buildObjectNameLookup(inputs: DiscoveryInputs): Map<string, string> {
  const map = new Map<string, string>();
  for (const obj of inputs.objects) map.set(obj.id, obj.displayName ?? obj.name);
  return map;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'candidate'
  );
}
