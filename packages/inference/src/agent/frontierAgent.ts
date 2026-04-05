import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  interactionIntents,
  objects,
  proofFrontiers,
  proofPatches,
  proofStates,
  routeTransforms,
} from '@archi-navi/db';
import { type ProofPatchType, type ProofPatchValidationStatus, validateAndApplyProofPatch, } from '@/orchestration';

type JsonRecord = Record<string, unknown>;

type SupportedFrontierAgentPatchType =
  | 'alias_binding'
  | 'route_transform_patch'
  | 'endpoint_disambiguation';

export interface FrontierAgentPatchProposal {
  proofStateId: string;
  frontierReason: string;
  frontierClass: string;
  patchType: SupportedFrontierAgentPatchType;
  payload: Record<string, unknown>;
  rationale: string;
}

export interface RunFrontierAgentPassInput {
  workspaceId: string;
  proofStateId: string;
  runId?: string | null;
}

export interface FrontierAgentPassResult {
  proofStateId: string;
  frontierReason: string | null;
  attempted: boolean;
  proposal: FrontierAgentPatchProposal | null;
  patchId: string | null;
  validationStatus: ProofPatchValidationStatus | null;
  errors: string[];
  resolution: Awaited<ReturnType<typeof validateAndApplyProofPatch>>['resolution'] | null;
}

interface FrontierContext {
  state: typeof proofStates.$inferSelect;
  frontier: typeof proofFrontiers.$inferSelect;
  intent: typeof interactionIntents.$inferSelect;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null))];
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizePathSegment(segment: string): string {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return '';
  if (/^\{[^/]+\}$/.test(trimmed)) return '{*}';
  if (/^\$\{[^/]+\}$/.test(trimmed)) return '{*}';
  if (/^:[^/]+$/.test(trimmed)) return '{*}';
  return trimmed.toLowerCase();
}

function normalizeComparablePath(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.trim().replace(/\/+/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const trimmed = withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/g, '') : withLeadingSlash;
  return trimmed
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => normalizePathSegment(segment))
    .join('/');
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => asString(value)).filter((value): value is string => value !== null))];
}

interface AliasServiceMatchScore {
  service: {
    id: string;
    name: string;
    metadata: unknown;
  };
  score: number;
  exactNameMatchCount: number;
  exactHostMatchCount: number;
  partialNameMatchCount: number;
  partialHostMatchCount: number;
  exactServiceNameMatchCount: number;
  matchedHintCoverage: number;
}

function compareAliasServiceMatchQuality(
  left: AliasServiceMatchScore,
  right: AliasServiceMatchScore,
): number {
  return (
    right.score - left.score
    || right.exactNameMatchCount - left.exactNameMatchCount
    || right.exactHostMatchCount - left.exactHostMatchCount
    || right.partialNameMatchCount - left.partialNameMatchCount
    || right.partialHostMatchCount - left.partialHostMatchCount
    || right.exactServiceNameMatchCount - left.exactServiceNameMatchCount
    || right.matchedHintCoverage - left.matchedHintCoverage
  );
}

function scoreAliasServiceMatch(
  service: {
    id: string;
    name: string;
    metadata: unknown;
  },
  serviceHintCandidates: string[],
  exactServiceNameHintCandidates: string[],
): AliasServiceMatchScore {
  const metadata = asRecord(service.metadata);
  const nameTokens = uniqueStrings([
    service.name,
    asString(metadata?.['serviceName']),
  ]).map(normalizeToken);
  const hostTokens = uniqueStrings([
    asString(metadata?.['host']),
  ]).map(normalizeToken);
  const normalizedExactServiceNameCandidates = exactServiceNameHintCandidates
    .map((entry) => asString(entry)?.toLowerCase().trim())
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  const normalizedServiceName = service.name.trim().toLowerCase();

  let score = 0;
  let exactNameMatchCount = 0;
  let exactHostMatchCount = 0;
  let partialNameMatchCount = 0;
  let partialHostMatchCount = 0;
  let exactServiceNameMatchCount = 0;
  let matchedHintCoverage = 0;

  for (const hint of normalizedExactServiceNameCandidates) {
    if (hint.length === 0) continue;
    if (normalizedServiceName === hint) {
      exactServiceNameMatchCount += 1;
    }
  }

  for (const hint of serviceHintCandidates) {
    const normalizedHint = normalizeToken(hint);
    if (normalizedHint.length === 0) continue;

    if (nameTokens.some((token) => token === normalizedHint)) {
      score = Math.max(score, 3);
      exactNameMatchCount += 1;
      matchedHintCoverage += normalizedHint.length;
      continue;
    }
    if (hostTokens.some((token) => token === normalizedHint)) {
      score = Math.max(score, 3);
      exactHostMatchCount += 1;
      matchedHintCoverage += normalizedHint.length;
      continue;
    }
    if (nameTokens.some((token) => token.includes(normalizedHint) || normalizedHint.includes(token))) {
      score = Math.max(score, 1);
      partialNameMatchCount += 1;
      matchedHintCoverage += normalizedHint.length;
      continue;
    }
    if (hostTokens.some((token) => token.includes(normalizedHint) || normalizedHint.includes(token))) {
      score = Math.max(score, 1);
      partialHostMatchCount += 1;
      matchedHintCoverage += normalizedHint.length;
    }
  }

  return {
    service,
    score,
    exactNameMatchCount,
    exactHostMatchCount,
    partialNameMatchCount,
    partialHostMatchCount,
    exactServiceNameMatchCount,
    matchedHintCoverage,
  };
}

async function loadFrontierContext(
  db: DbClient,
  workspaceId: string,
  proofStateId: string,
): Promise<FrontierContext | null> {
  const stateRows = await db
    .select()
    .from(proofStates)
    .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.id, proofStateId)))
    .limit(1);
  const state = stateRows[0];
  if (!state || state.status !== 'FRONTIER') return null;

  const [frontierRows, intentRows] = await Promise.all([
    db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)))
      .limit(1),
    db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.id, state.intentId)))
      .limit(1),
  ]);

  const frontier = frontierRows[0];
  const intent = intentRows[0];
  if (!frontier || !intent) return null;

  return { state, frontier, intent };
}

async function buildAliasBindingProposal(
  db: DbClient,
  context: FrontierContext,
): Promise<FrontierAgentPatchProposal | null> {
  if (
    context.frontier.frontierReason !== 'CONFIG_BINDING_MISSING'
    && context.frontier.frontierReason !== 'HOST_ALIAS_UNRESOLVED'
  ) {
    return null;
  }

  const detail = asRecord(context.frontier.detail) ?? {};
  const hostHints = asStringArray(detail['hostHints']);
  const configKeys = asStringArray(detail['configKeys']);
  const serviceHintCandidates = uniqueStrings([
    context.intent.targetServiceHint,
    context.intent.providerHint,
    ...hostHints,
    context.intent.hostHint,
  ]);
  const exactServiceNameHintCandidates = uniqueStrings([
    context.intent.targetServiceHint,
    context.intent.providerHint,
  ]);
  if (serviceHintCandidates.length === 0) {
    return null;
  }

  const serviceRows = await db
    .select({
      id: objects.id,
      name: objects.name,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, context.intent.workspaceId),
        eq(objects.objectType, 'service'),
      ),
    );

  const scoredMatches = serviceRows
    .map((service) => scoreAliasServiceMatch(service, serviceHintCandidates, exactServiceNameHintCandidates))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      compareAliasServiceMatchQuality(left, right));

  const winner = scoredMatches[0];
  if (!winner) return null;
  if (scoredMatches.length > 1 && compareAliasServiceMatchQuality(winner, scoredMatches[1]!) === 0) {
    return null;
  }

  const aliasKey = configKeys[0] ?? hostHints[0] ?? context.intent.hostHint;
  const aliasValue = hostHints[0] ?? context.intent.hostHint ?? serviceHintCandidates[0] ?? winner.service.name;
  if (!aliasKey || !aliasValue) return null;

  return {
    proofStateId: context.state.id,
    frontierReason: context.frontier.frontierReason,
    frontierClass: context.frontier.frontierClass,
    patchType: 'alias_binding',
    payload: {
      ownerServiceId: context.state.consumerServiceId,
      bindingKind: 'property_alias',
      aliasKey,
      aliasValue,
      resolvedServiceId: winner.service.id,
      confidence: 0.76,
      evidenceIds: [`frontier-agent:${context.frontier.frontierReason}`],
    },
    rationale: `alias ${aliasKey}를 service ${winner.service.name}에 단일 매칭했습니다.`,
  };
}

async function buildRouteTransformPatchProposal(
  db: DbClient,
  context: FrontierContext,
): Promise<FrontierAgentPatchProposal | null> {
  if (
    context.intent.intentType !== 'http_gateway_route'
    || (
      context.frontier.frontierReason !== 'ROUTE_FAMILY_DERIVATION_EMPTY'
      && context.frontier.frontierReason !== 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED'
      && context.frontier.frontierReason !== 'PATH_TEMPLATE_UNKNOWN'
    )
  ) {
    return null;
  }

  const gatewayKind = asString(context.intent.gatewayKind);
  const ownerServiceId = asString(context.intent.sourceServiceId);
  const matchPath = asString(context.intent.externalRoutePattern)
    ?? asString(context.state.externalPathResolved)
    ?? asString(context.intent.externalPathHint);
  const targetServiceHint = asString(context.intent.targetServiceHint)
    ?? asString(context.intent.providerHint)
    ?? asString(context.intent.hostHint);
  if (!gatewayKind || !ownerServiceId || !matchPath || !targetServiceHint) {
    return null;
  }

  const existing = await db
    .select({ id: routeTransforms.id })
    .from(routeTransforms)
    .where(
      and(
        eq(routeTransforms.workspaceId, context.intent.workspaceId),
        eq(routeTransforms.ownerServiceId, ownerServiceId),
        eq(routeTransforms.gatewayKind, gatewayKind),
        eq(routeTransforms.matchPath, matchPath),
        eq(routeTransforms.targetServiceHint, targetServiceHint),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return null;
  }

  return {
    proofStateId: context.state.id,
    frontierReason: context.frontier.frontierReason,
    frontierClass: context.frontier.frontierClass,
    patchType: 'route_transform_patch',
    payload: {
      ownerServiceId,
      gatewayKind,
      matchPath,
      targetServiceHint,
      priority: 100,
      evidenceIds: [`frontier-agent:${context.frontier.frontierReason}`],
    },
    rationale: `gateway route ${matchPath}에 대한 최소 route transform 후보를 제안했습니다.`,
  };
}

async function buildEndpointDisambiguationProposal(
  db: DbClient,
  context: FrontierContext,
): Promise<FrontierAgentPatchProposal | null> {
  if (context.frontier.frontierReason !== 'ENDPOINT_MATCH_AMBIGUOUS') {
    return null;
  }

  const detail = asRecord(context.frontier.detail) ?? {};
  const endpointHintId = asString(detail['endpointHintId']);
  const candidateIds = uniqueStrings([
    ...asStringArray(detail['candidateObjectIds']),
    ...asStringArray(asRecord(detail['endpointCandidateSet'])?.['objectIds']),
  ]);
  if (candidateIds.length === 0) {
    return null;
  }

  if (endpointHintId && candidateIds.includes(endpointHintId)) {
    return {
      proofStateId: context.state.id,
      frontierReason: context.frontier.frontierReason,
      frontierClass: context.frontier.frontierClass,
      patchType: 'endpoint_disambiguation',
      payload: {
        endpointId: endpointHintId,
        evidenceIds: [`frontier-agent:${context.frontier.frontierReason}`],
      },
      rationale: `frontier detail의 endpointHintId ${endpointHintId}를 우선 채택했습니다.`,
    };
  }

  const endpointRows = await db
    .select({
      id: objects.id,
      name: objects.name,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, context.intent.workspaceId),
        inArray(objects.id, candidateIds),
      ),
    );
  const internalPath = asString((asRecord(context.frontier.detail) ?? {})['internalPathResolved'])
    ?? context.state.internalPathResolved;
  const method = context.state.methodResolved;
  const exactMatches = endpointRows.filter((endpoint) => {
    const metadata = asRecord(endpoint.metadata);
    const endpointMethod = asString(metadata?.['method']);
    const endpointPath = asString(metadata?.['path']);
    return (
      endpointMethod !== null
      && endpointPath !== null
      && endpointMethod === method
      && endpointPath === internalPath
    );
  });
  if (exactMatches.length === 1) {
    return {
      proofStateId: context.state.id,
      frontierReason: context.frontier.frontierReason,
      frontierClass: context.frontier.frontierClass,
      patchType: 'endpoint_disambiguation',
      payload: {
        endpointId: exactMatches[0]!.id,
        evidenceIds: [`frontier-agent:${context.frontier.frontierReason}`],
      },
      rationale: '정확한 method/path 일치 후보가 하나뿐이라 endpoint를 고정했습니다.',
    };
  }

  const compatibleCandidates = endpointRows
    .map((endpoint) => {
      const metadata = asRecord(endpoint.metadata);
      const endpointMethod = asString(metadata?.['method']);
      const endpointPath = asString(metadata?.['path']);
      return {
        endpoint,
        endpointMethod,
        endpointPath,
        signature: normalizeComparablePath(endpointPath),
      };
    })
    .filter((entry) => entry.endpointMethod === method && entry.signature !== null);
  if (compatibleCandidates.length === 0) {
    return null;
  }

  const distinctSignatures = new Set(compatibleCandidates.map((entry) => entry.signature));
  if (distinctSignatures.size !== 1) {
    return null;
  }

  const selected = compatibleCandidates.sort((left, right) => {
    const leftPath = left.endpointPath ?? left.endpoint.name;
    const rightPath = right.endpointPath ?? right.endpoint.name;
    const pathCompare = leftPath.localeCompare(rightPath);
    if (pathCompare !== 0) return pathCompare;
    return left.endpoint.id.localeCompare(right.endpoint.id);
  })[0];
  if (!selected) {
    return null;
  }

  return {
    proofStateId: context.state.id,
    frontierReason: context.frontier.frontierReason,
    frontierClass: context.frontier.frontierClass,
    patchType: 'endpoint_disambiguation',
    payload: {
      endpointId: selected.endpoint.id,
      evidenceIds: [`frontier-agent:${context.frontier.frontierReason}`],
    },
    rationale: 'ambiguous candidate들이 동일 canonical path shape를 공유해 deterministic tie-break로 endpoint를 고정했습니다.',
  };
}

export async function buildFrontierAgentPatchProposal(
  db: DbClient,
  input: { workspaceId: string; proofStateId: string },
): Promise<FrontierAgentPatchProposal | null> {
  const context = await loadFrontierContext(db, input.workspaceId, input.proofStateId);
  if (!context) return null;

  const existingAcceptedPatchRows = await db
    .select({ id: proofPatches.id })
    .from(proofPatches)
    .where(
      and(
        eq(proofPatches.workspaceId, input.workspaceId),
        eq(proofPatches.proofStateId, input.proofStateId),
        eq(proofPatches.sourceKind, 'agent'),
        eq(proofPatches.validationStatus, 'ACCEPTED'),
      ),
    )
    .limit(1);
  if (existingAcceptedPatchRows.length > 0) return null;




  return await buildAliasBindingProposal(db, context)
    ?? await buildRouteTransformPatchProposal(db, context)
    ?? await buildEndpointDisambiguationProposal(db, context);
}

export async function runFrontierAgentPass(
  db: DbClient,
  input: RunFrontierAgentPassInput,
): Promise<FrontierAgentPassResult> {
  const context = await loadFrontierContext(db, input.workspaceId, input.proofStateId);
  const frontierReason = context?.frontier.frontierReason ?? null;
  const proposal = await buildFrontierAgentPatchProposal(db, input);

  if (!proposal) {
    return {
      proofStateId: input.proofStateId,
      frontierReason,
      attempted: false,
      proposal: null,
      patchId: null,
      validationStatus: null,
      errors: [],
      resolution: null,
    };
  }

  const patchResult = await validateAndApplyProofPatch(db, {
    workspaceId: input.workspaceId,
    proofStateId: input.proofStateId,
    patchType: proposal.patchType as ProofPatchType,
    payload: proposal.payload,
    sourceKind: 'agent',
    runId: input.runId ?? null,
  });

  return {
    proofStateId: input.proofStateId,
    frontierReason: proposal.frontierReason,
    attempted: true,
    proposal,
    patchId: patchResult.patchId,
    validationStatus: patchResult.validationStatus,
    errors: patchResult.errors,
    resolution: patchResult.resolution,
  };
}
