import { createHash } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  interactionIntents,
  objects,
  proofPatches,
  proofStates,
} from '@archi-navi/db';
import { smartProofLlmCalls } from '@archi-navi/db/schema';
import { generateId } from '@archi-navi/shared';
import {
  type ProofPatchValidationStatus,
  validateAndApplyProofPatch,
} from '@/orchestration/intentProofEngine';
import type { SmartProofConfig, SmartProofDecision } from './smartProofTypes';
import { resolveSmartProofDecision } from './smartProofTypes';
import type {
  GenerateSmartResolutionFn,
  SmartGenerateResolutionResult,
} from './smartFrontierResolver';

type JsonRecord = Record<string, unknown>;

const CONTRADICTION_CONFIDENCE_THRESHOLD = 0.65;

export interface SmartContradictionCandidate {
  proofStateId: string;
  intentId: string;
  intentType: string;
  sourceServiceId: string;
  sourceServiceName: string | null;
  targetObjectId: string | null;
  targetObjectType: string | null;
  targetObjectName: string | null;
  methodHint: string | null;
  externalPathHint: string | null;
  hostHint: string | null;
  configKeys: string[];
  confidence: number;
  confidenceBreakdown: Record<string, unknown>;
  contradictionCount: number;
  ambiguityCount: number;
}

export interface SmartContradictionChallengeProposal {
  patchType: 'contradiction_challenge';
  shouldChallenge: boolean;
  confidence: number;
  reasoning: string;
  challengeReasons: string[];
  expectedAction: 'reopen_frontier' | null;
}

export interface ResolveSmartContradictionInput {
  workspaceId: string;
  runId?: string | null;
  config: SmartProofConfig;
  candidate: SmartContradictionCandidate;
  generateFn: GenerateSmartResolutionFn<SmartContradictionChallengeProposal>;
}

export interface ResolveSmartContradictionResult {
  proofStateId: string;
  attempted: boolean;
  challenged: boolean;
  confidence: number;
  reasoning: string;
  decision: SmartProofDecision;
  validationStatus: ProofPatchValidationStatus | null;
  patchId: string | null;
  llmCallId: string | null;
  tokensUsed: {
    input: number;
    output: number;
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null))];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildSmartContradictionPrompt(
  candidate: SmartContradictionCandidate,
): string {
  const configKeys = candidate.configKeys.length > 0 ? candidate.configKeys.join(', ') : 'none';
  return [
    'You are reviewing a low-confidence CLOSED_ATOMIC proof for the Smart Proof Engine.',
    'Respond with patchType=contradiction_challenge.',
    `Intent type: ${candidate.intentType}`,
    `Source service: ${candidate.sourceServiceName ?? candidate.sourceServiceId}`,
    `Target object: ${candidate.targetObjectName ?? candidate.targetObjectId ?? 'unknown'} (${candidate.targetObjectType ?? 'unknown'})`,
    `Method hint: ${candidate.methodHint ?? 'unknown'}`,
    `Path hint: ${candidate.externalPathHint ?? 'unknown'}`,
    `Host hint: ${candidate.hostHint ?? 'none'}`,
    `Config keys: ${configKeys}`,
    `Proof confidence: ${candidate.confidence.toFixed(3)}`,
    `Contradiction count: ${candidate.contradictionCount}`,
    `Ambiguity count: ${candidate.ambiguityCount}`,
    `Confidence breakdown: ${JSON.stringify(candidate.confidenceBreakdown)}`,
    'Task:',
    'If this proof looks like a likely false positive, set shouldChallenge=true and expectedAction=reopen_frontier.',
    'If the proof is still acceptable, set shouldChallenge=false.',
  ].join('\n');
}

async function insertSmartLlmCall(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string | null;
    proofStateId: string;
    prompt: string;
    response: SmartContradictionChallengeProposal;
    generated: SmartGenerateResolutionResult<SmartContradictionChallengeProposal>;
    accepted: boolean | null;
    patchId?: string | null;
  },
): Promise<string> {
  const id = generateId();
  await db.insert(smartProofLlmCalls).values({
    id,
    workspaceId: input.workspaceId,
    runId: input.runId,
    proofStateId: input.proofStateId,
    callCategory: 'contradiction_detection',
    frontierReason: 'LOW_CONFIDENCE_CLOSED_ATOMIC',
    model: input.generated.model,
    inputTokens: input.generated.promptTokens,
    outputTokens: input.generated.completionTokens,
    promptHash: sha256(input.prompt),
    responseHash: sha256(JSON.stringify(input.response)),
    promptSnapshot: { prompt: input.prompt },
    responseSnapshot: input.response,
    confidence: input.response.confidence,
    accepted: input.accepted,
    patchId: input.patchId ?? null,
  });
  return id;
}

function buildContradictionChallengePatch(
  proposal: SmartContradictionChallengeProposal,
): { patchType: 'contradiction_challenge'; payload: Record<string, unknown>; sourceKind: 'smart_agent' } {
  return {
    patchType: 'contradiction_challenge',
    payload: {
      challengeReasons: proposal.challengeReasons,
      expectedAction: proposal.expectedAction ?? 'reopen_frontier',
      confidence: proposal.confidence,
      evidenceIds: proposal.challengeReasons.map((reason) => `smart-agent:${reason}`),
    },
    sourceKind: 'smart_agent',
  };
}

export async function loadSmartContradictionCandidates(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string;
  },
): Promise<SmartContradictionCandidate[]> {
  const rows = await db
    .select({
      proofStateId: proofStates.id,
      intentId: proofStates.intentId,
      intentType: interactionIntents.intentType,
      sourceServiceId: interactionIntents.sourceServiceId,
      sourceServiceName: objects.name,
      targetObjectId: proofStates.targetObjectId,
      targetObjectType: proofStates.targetObjectType,
      methodHint: interactionIntents.methodHint,
      externalPathHint: interactionIntents.externalPathHint,
      hostHint: interactionIntents.hostHint,
      configKeys: interactionIntents.configKeys,
      confidence: proofStates.confidence,
      confidenceBreakdown: proofStates.confidenceBreakdown,
      contradictionCount: proofStates.contradictionCount,
      ambiguityCount: proofStates.ambiguityCount,
    })
    .from(proofStates)
    .innerJoin(interactionIntents, eq(interactionIntents.id, proofStates.intentId))
    .leftJoin(objects, eq(objects.id, interactionIntents.sourceServiceId))
    .where(
      and(
        eq(proofStates.workspaceId, input.workspaceId),
        eq(interactionIntents.updatedRunId, input.runId),
        eq(proofStates.status, 'CLOSED_ATOMIC'),
        lt(proofStates.confidence, CONTRADICTION_CONFIDENCE_THRESHOLD),
      ),
    );

  if (rows.length === 0) return [];

  const targetIds = rows
    .map((row) => row.targetObjectId)
    .filter((value): value is string => typeof value === 'string');
  const targetNames = targetIds.length === 0
    ? new Map<string, string>()
    : new Map(
        (
          await db
            .select({ id: objects.id, name: objects.name })
            .from(objects)
            .where(and(eq(objects.workspaceId, input.workspaceId), inArray(objects.id, targetIds)))
        ).map((row) => [row.id, row.name]),
      );
  const challengedRows = await db
    .select({
      proofStateId: proofPatches.proofStateId,
    })
    .from(proofPatches)
    .where(
      and(
        eq(proofPatches.workspaceId, input.workspaceId),
        eq(proofPatches.patchType, 'contradiction_challenge'),
        eq(proofPatches.validationStatus, 'ACCEPTED'),
      ),
    );
  const challengedProofStateIds = new Set(
    challengedRows
      .map((row) => row.proofStateId)
      .filter((value): value is string => typeof value === 'string'),
  );

  return rows
    .filter((row) => !challengedProofStateIds.has(row.proofStateId))
    .map((row) => ({
      proofStateId: row.proofStateId,
      intentId: row.intentId,
      intentType: row.intentType,
      sourceServiceId: row.sourceServiceId,
      sourceServiceName: row.sourceServiceName ?? null,
      targetObjectId: row.targetObjectId,
      targetObjectType: row.targetObjectType,
      targetObjectName: row.targetObjectId ? (targetNames.get(row.targetObjectId) ?? null) : null,
      methodHint: row.methodHint,
      externalPathHint: row.externalPathHint,
      hostHint: row.hostHint,
      configKeys: asStringArray(row.configKeys),
      confidence: row.confidence,
      confidenceBreakdown: asRecord(row.confidenceBreakdown) ?? {},
      contradictionCount: row.contradictionCount,
      ambiguityCount: row.ambiguityCount,
    }))
    .sort((a, b) => a.confidence - b.confidence || a.proofStateId.localeCompare(b.proofStateId));
}

export async function resolveSmartContradiction(
  db: DbClient,
  input: ResolveSmartContradictionInput,
): Promise<ResolveSmartContradictionResult> {
  const prompt = buildSmartContradictionPrompt(input.candidate);
  const generated = await input.generateFn(prompt);
  const proposal = generated.object;

  if (!proposal.shouldChallenge) {
    const llmCallId = await insertSmartLlmCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.candidate.proofStateId,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return {
      proofStateId: input.candidate.proofStateId,
      attempted: true,
      challenged: false,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      decision: 'SKIPPED',
      validationStatus: null,
      patchId: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
    };
  }

  const decision = resolveSmartProofDecision(input.config, proposal.confidence);
  if (decision === 'SKIPPED') {
    const llmCallId = await insertSmartLlmCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.candidate.proofStateId,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return {
      proofStateId: input.candidate.proofStateId,
      attempted: true,
      challenged: false,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      decision,
      validationStatus: null,
      patchId: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
    };
  }

  const patch = buildContradictionChallengePatch(proposal);
  const patchResult = await validateAndApplyProofPatch(db, {
    workspaceId: input.workspaceId,
    proofStateId: input.candidate.proofStateId,
    patchType: 'contradiction_challenge',
    payload: patch.payload,
    sourceKind: 'smart_agent',
    runId: input.runId ?? null,
    applyMode: decision === 'PENDING_REVIEW' ? 'defer' : 'apply',
  });

  const llmCallId = await insertSmartLlmCall(db, {
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    proofStateId: input.candidate.proofStateId,
    prompt,
    response: proposal,
    generated,
    accepted:
      patchResult.validationStatus === 'ACCEPTED'
        ? true
        : patchResult.validationStatus === 'PENDING'
          ? null
          : false,
    patchId: patchResult.patchId,
  });

  return {
    proofStateId: input.candidate.proofStateId,
    attempted: true,
    challenged: patchResult.validationStatus === 'ACCEPTED',
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    decision:
      patchResult.validationStatus === 'ACCEPTED'
        ? 'ACCEPTED'
        : patchResult.validationStatus === 'PENDING'
          ? 'PENDING_REVIEW'
          : 'SKIPPED',
    validationStatus: patchResult.validationStatus,
    patchId: patchResult.patchId,
    llmCallId,
    tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
  };
}
