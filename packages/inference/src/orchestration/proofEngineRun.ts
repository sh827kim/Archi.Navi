import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  functionSummaries,
  inferenceRuns,
  interactionIntents,
  proofFrontiers,
  proofPatches,
  proofStates,
  relationCandidates,
} from '@archi-navi/db';
import { smartProofLlmCalls } from '@archi-navi/db/schema';
import { buildEmptySmartModeSummary, type SmartModeSummary } from '../agent/smartProofTypes';

export type ProofEngineName = 'intent_proof';

const DEFAULT_PROOF_CONFIDENCE_PROFILE_NAME = 'intent-proof-default';
const DEFAULT_PROOF_CONFIDENCE_PROFILE_VERSION = 'v1';

export interface ProofEngineSummary {
  engine: ProofEngineName;
  intentCount: number;
  gatewayRouteSeedCount: number;
  derivedEndpointProofCount: number;
  proofClosedAtomicCount: number;
  proofFrontierCount: number;
  routeFamilyFrontierCount: number;
  proofRejectedCount: number;
  projectedCandidateCount: number;
  serviceTargetProjectionCount: number;
  agentFrontierCount: number;
  agentPatchedFrontierCount: number;
  confidenceProfileName: string | null;
  confidenceProfileVersion: string | null;
  functionSummaryExtractionBreakdown: Record<string, number>;
  frontierBreakdown: Record<string, number>;
  targetBreakdown: Record<string, number>;
  smartMode: SmartModeSummary;
}

interface BuildProofEngineSummaryForRunInput {
  workspaceId: string;
  runId: string;
}

export function buildEmptyProofEngineSummary(): ProofEngineSummary {
  return {
    engine: 'intent_proof',
    intentCount: 0,
    gatewayRouteSeedCount: 0,
    derivedEndpointProofCount: 0,
    proofClosedAtomicCount: 0,
    proofFrontierCount: 0,
    routeFamilyFrontierCount: 0,
    proofRejectedCount: 0,
    projectedCandidateCount: 0,
    serviceTargetProjectionCount: 0,
    agentFrontierCount: 0,
    agentPatchedFrontierCount: 0,
    confidenceProfileName: DEFAULT_PROOF_CONFIDENCE_PROFILE_NAME,
    confidenceProfileVersion: DEFAULT_PROOF_CONFIDENCE_PROFILE_VERSION,
    functionSummaryExtractionBreakdown: {
      ast_primary: 0,
      mixed_signals: 0,
      legacy_edges_fallback: 0,
    },
    frontierBreakdown: {},
    targetBreakdown: {},
    smartMode: buildEmptySmartModeSummary(false),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function buildProofEngineSummaryForRun(
  db: DbClient,
  input: BuildProofEngineSummaryForRunInput,
): Promise<ProofEngineSummary> {
  const runIntents = await db
    .select({
      id: interactionIntents.id,
      intentType: interactionIntents.intentType,
    })
    .from(interactionIntents)
    .where(
      and(
        eq(interactionIntents.workspaceId, input.workspaceId),
        eq(interactionIntents.updatedRunId, input.runId),
      ),
    );

  if (runIntents.length === 0) {
    const runRows = await db
      .select({ stats: inferenceRuns.stats })
      .from(inferenceRuns)
      .where(and(eq(inferenceRuns.workspaceId, input.workspaceId), eq(inferenceRuns.id, input.runId)))
      .limit(1);
    const runStats = asRecord(runRows[0]?.stats);
    const requestedSmartProof = asRecord(runStats?.['requestedSmartProof']);

    return {
      ...buildEmptyProofEngineSummary(),
      smartMode: buildEmptySmartModeSummary(requestedSmartProof?.['enabled'] === true),
    };
  }

  const intentIds = runIntents.map((row) => row.id);
  const gatewayRouteIntentIds = new Set(
    runIntents
      .filter((row) => row.intentType === 'http_gateway_route')
      .map((row) => row.id),
  );
  const states = await db
    .select({
      id: proofStates.id,
      intentId: proofStates.intentId,
      originIntentId: proofStates.originIntentId,
      parentProofStateId: proofStates.parentProofStateId,
      status: proofStates.status,
      targetObjectType: proofStates.targetObjectType,
      confidenceBreakdown: proofStates.confidenceBreakdown,
    })
    .from(proofStates)
    .where(
      and(
        eq(proofStates.workspaceId, input.workspaceId),
        inArray(proofStates.intentId, intentIds),
      ),
    );

  if (states.length === 0) {
    const runRows = await db
      .select({ stats: inferenceRuns.stats })
      .from(inferenceRuns)
      .where(and(eq(inferenceRuns.workspaceId, input.workspaceId), eq(inferenceRuns.id, input.runId)))
      .limit(1);
    const runStats = asRecord(runRows[0]?.stats);
    const requestedSmartProof = asRecord(runStats?.['requestedSmartProof']);

    return {
      ...buildEmptyProofEngineSummary(),
      smartMode: buildEmptySmartModeSummary(requestedSmartProof?.['enabled'] === true),
    };
  }

  const stateIds = states.map((state) => state.id);
  const [frontiers, patches, candidates, updatedSummaries, smartCallRows, runRows] = await Promise.all([
    db
      .select({
        proofStateId: proofFrontiers.proofStateId,
        frontierReason: proofFrontiers.frontierReason,
        retryStrategy: proofFrontiers.retryStrategy,
      })
      .from(proofFrontiers)
      .where(
        and(
          eq(proofFrontiers.workspaceId, input.workspaceId),
          inArray(proofFrontiers.proofStateId, stateIds),
        ),
      ),
    db
      .select({
        id: proofPatches.id,
        proofStateId: proofPatches.proofStateId,
        sourceKind: proofPatches.sourceKind,
        validationStatus: proofPatches.validationStatus,
      })
      .from(proofPatches)
      .where(
        and(
          eq(proofPatches.workspaceId, input.workspaceId),
          inArray(proofPatches.proofStateId, stateIds),
        ),
      ),
    db
      .select({
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, input.workspaceId)),
    db
      .select({
        extractionStrategy: functionSummaries.extractionStrategy,
      })
      .from(functionSummaries)
      .where(
        and(
          eq(functionSummaries.workspaceId, input.workspaceId),
          eq(functionSummaries.updatedRunId, input.runId),
        ),
      ),
    db
      .select({
        callCategory: smartProofLlmCalls.callCategory,
        frontierReason: smartProofLlmCalls.frontierReason,
        inputTokens: smartProofLlmCalls.inputTokens,
        outputTokens: smartProofLlmCalls.outputTokens,
        estimatedCostUsd: smartProofLlmCalls.estimatedCostUsd,
        accepted: smartProofLlmCalls.accepted,
        confidence: smartProofLlmCalls.confidence,
        patchId: smartProofLlmCalls.patchId,
      })
      .from(smartProofLlmCalls)
      .where(
        and(
          eq(smartProofLlmCalls.workspaceId, input.workspaceId),
          eq(smartProofLlmCalls.runId, input.runId),
        ),
      ),
    db
      .select({ stats: inferenceRuns.stats })
      .from(inferenceRuns)
      .where(and(eq(inferenceRuns.workspaceId, input.workspaceId), eq(inferenceRuns.id, input.runId)))
      .limit(1),
  ]);

  const smartCallPatchIds = smartCallRows
    .map((call) => call.patchId)
    .filter((patchId): patchId is string => typeof patchId === 'string');

  const smartCallPatchRows = smartCallPatchIds.length === 0
    ? []
    : await db
      .select({
        id: proofPatches.id,
        validationStatus: proofPatches.validationStatus,
      })
      .from(proofPatches)
      .where(
        and(
          eq(proofPatches.workspaceId, input.workspaceId),
          inArray(proofPatches.id, smartCallPatchIds),
        ),
      );

  const trackedStateIds = new Set(stateIds);
  const projectedCandidateCount = candidates.filter((candidate) => {
    const metadata = candidate.metadata as Record<string, unknown> | null;
    const proofStateId = typeof metadata?.['proofStateId'] === 'string' ? metadata['proofStateId'] : null;
    return proofStateId !== null && trackedStateIds.has(proofStateId);
  }).length;

  const frontierBreakdown: Record<string, number> = {};
  for (const frontier of frontiers) {
    frontierBreakdown[frontier.frontierReason] = (frontierBreakdown[frontier.frontierReason] ?? 0) + 1;
  }

  const targetBreakdown: Record<string, number> = {};
  for (const state of states) {
    if (state.status !== 'CLOSED_ATOMIC' || !state.targetObjectType) continue;
    targetBreakdown[state.targetObjectType] = (targetBreakdown[state.targetObjectType] ?? 0) + 1;
  }

  const functionSummaryExtractionBreakdown: Record<string, number> = {
    ast_primary: 0,
    mixed_signals: 0,
    legacy_edges_fallback: 0,
  };
  for (const summary of updatedSummaries) {
    const key = summary.extractionStrategy;
    functionSummaryExtractionBreakdown[key] = (functionSummaryExtractionBreakdown[key] ?? 0) + 1;
  }

  const confidenceProfileSnapshots = states
    .map((state) => asRecord(state.confidenceBreakdown))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const confidenceProfileName =
    confidenceProfileSnapshots
      .map((entry) => asString(entry['confidenceProfileName']))
      .find((entry): entry is string => entry !== null)
    ?? DEFAULT_PROOF_CONFIDENCE_PROFILE_NAME;
  const confidenceProfileVersion =
    confidenceProfileSnapshots
      .map((entry) => asString(entry['confidenceProfileVersion']))
      .find((entry): entry is string => entry !== null)
    ?? DEFAULT_PROOF_CONFIDENCE_PROFILE_VERSION;

  const agentPatchedProofIds = new Set(
    patches
      .filter((patch) => patch.sourceKind === 'agent' && patch.validationStatus === 'ACCEPTED' && patch.proofStateId)
      .map((patch) => patch.proofStateId as string),
  );
  const runStats = asRecord(runRows[0]?.stats);
  const requestedSmartProof = asRecord(runStats?.['requestedSmartProof']);
  const smartMode = buildEmptySmartModeSummary(requestedSmartProof?.['enabled'] === true);
  const smartPatchStatusById = new Map(
    smartCallPatchRows.map((patch) => [patch.id, patch.validationStatus]),
  );

  for (const row of smartCallRows) {
    smartMode.llmCallCount += 1;
    smartMode.totalInputTokens += row.inputTokens;
    smartMode.totalOutputTokens += row.outputTokens;
    smartMode.estimatedCostUsd += row.estimatedCostUsd ?? 0;
    smartMode.resolutionByCategory[row.callCategory] = (smartMode.resolutionByCategory[row.callCategory] ?? 0) + 1;
    if (row.frontierReason) {
      smartMode.resolutionByFrontierReason[row.frontierReason] =
        (smartMode.resolutionByFrontierReason[row.frontierReason] ?? 0) + 1;
    }

    const patchStatus = row.patchId ? smartPatchStatusById.get(row.patchId) ?? null : null;
    if (patchStatus === 'ACCEPTED') {
      smartMode.autoAcceptedCount += 1;
      if (row.callCategory === 'frontier_resolution' || row.callCategory === 'ambiguity_resolution') {
        smartMode.frontierResolvedByLlm += 1;
      }
      if (row.callCategory === 'pre_resolution_enhancement') {
        smartMode.summaryEnhancedByLlm += 1;
      }
    } else if (patchStatus === 'PENDING') {
      smartMode.pendingReviewCount += 1;
    } else if (patchStatus === 'REJECTED' || row.accepted === false) {
      smartMode.skippedCount += 1;
    }
  }

  return {
    engine: 'intent_proof',
    intentCount: runIntents.length,
    gatewayRouteSeedCount: gatewayRouteIntentIds.size,
    derivedEndpointProofCount: states.filter(
      (state) =>
        state.parentProofStateId !== null
        && state.originIntentId !== null
        && gatewayRouteIntentIds.has(state.originIntentId)
        && state.status === 'CLOSED_ATOMIC'
        && state.targetObjectType === 'api_endpoint',
    ).length,
    proofClosedAtomicCount: states.filter((state) => state.status === 'CLOSED_ATOMIC').length,
    proofFrontierCount: states.filter((state) => state.status === 'FRONTIER').length,
    routeFamilyFrontierCount: states.filter(
      (state) =>
        state.parentProofStateId === null
        && gatewayRouteIntentIds.has(state.intentId)
        && state.status === 'FRONTIER',
    ).length,
    proofRejectedCount: states.filter((state) => state.status === 'REJECTED').length,
    projectedCandidateCount,
    serviceTargetProjectionCount: states.filter(
      (state) => state.status === 'CLOSED_ATOMIC' && state.targetObjectType === 'service',
    ).length,
    agentFrontierCount: frontiers.filter((frontier) => frontier.retryStrategy === 'agent_patch').length,
    agentPatchedFrontierCount: agentPatchedProofIds.size,
    confidenceProfileName,
    confidenceProfileVersion,
    functionSummaryExtractionBreakdown,
    frontierBreakdown,
    targetBreakdown,
    smartMode,
  };
}
