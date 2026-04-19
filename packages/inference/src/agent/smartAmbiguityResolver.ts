import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  interactionIntents,
  objects,
  proofFrontiers,
  proofStates,
} from '@archi-navi/db';
import { smartProofLlmCalls } from '@archi-navi/db/schema';
import { generateId } from '@archi-navi/shared';
import {
  type ProofPatchType,
  type ProofPatchValidationStatus,
  validateAndApplyProofPatch,
} from '@/orchestration/intentProofEngine';
import type {
  SmartProofConfig,
  SmartProofDecision,
  SupportedSmartAmbiguityReason as CanonicalSupportedSmartAmbiguityReason,
} from './smartProofTypes';
import {
  isSupportedSmartAmbiguityReason as isCanonicalSupportedSmartAmbiguityReason,
  resolveSmartProofDecision,
  SMART_AMBIGUITY_REASONS_SUPPORTED,
} from './smartProofTypes';
import type {
  GenerateSmartResolutionFn,
  SmartGenerateResolutionResult,
} from './smartFrontierResolver';

type JsonRecord = Record<string, unknown>;

export const SUPPORTED_SMART_AMBIGUITY_REASONS = SMART_AMBIGUITY_REASONS_SUPPORTED;

export type SupportedSmartAmbiguityReason = CanonicalSupportedSmartAmbiguityReason;

export interface SmartAmbiguityCandidateService {
  id: string;
  name: string;
  endpointCount: number;
}

export interface SmartAmbiguityResolutionContext {
  workspaceId: string;
  proofStateId: string;
  frontierReason: SupportedSmartAmbiguityReason;
  sourceServiceId: string;
  intent: {
    type: string;
    sourceService: string;
    methodHint: string | null;
    pathHint: string | null;
    hostHint: string | null;
    configKeys: string[];
  };
  proofState: {
    currentSlots: Record<string, unknown>;
    frontierDetail: Record<string, unknown>;
  };
  candidateServices: SmartAmbiguityCandidateService[];
}

export interface SmartProviderServiceSelectionProposal {
  patchType: 'provider_service_selection';
  resolved: boolean;
  selectedServiceId: string | null;
  selectedServiceName: string | null;
  confidence: number;
  reasoning: string;
  ranking: Array<{
    serviceId: string;
    serviceName: string | null;
    score: number | null;
    reasoning: string | null;
  }> | null;
}

export interface ResolveSmartAmbiguityInput {
  workspaceId: string;
  proofStateId: string;
  runId?: string | null;
  config: SmartProofConfig;
  generateFn: GenerateSmartResolutionFn<SmartProviderServiceSelectionProposal>;
}

export interface ResolveSmartAmbiguityResult {
  proofStateId: string;
  frontierReason: string;
  attempted: boolean;
  resolved: boolean;
  confidence: number;
  reasoning: string;
  decision: SmartProofDecision;
  patch: {
    patchType: 'provider_service_selection';
    payload: Record<string, unknown>;
    sourceKind: 'smart_agent';
  } | null;
  validationStatus: ProofPatchValidationStatus | null;
  errors: string[];
  resolution: Awaited<ReturnType<typeof validateAndApplyProofPatch>>['resolution'] | null;
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

export function isSupportedSmartAmbiguityReason(
  reason: string | null,
): reason is SupportedSmartAmbiguityReason {
  return isCanonicalSupportedSmartAmbiguityReason(reason);
}

export function buildProviderServiceSelectionPrompt(
  ctx: SmartAmbiguityResolutionContext,
): string {
  const candidateServices = ctx.candidateServices.length > 0
    ? ctx.candidateServices
      .map((service) => `- ${service.id}: ${service.name} (${service.endpointCount} endpoints)`)
      .join('\n')
    : 'none';
  const configKeys = ctx.intent.configKeys.length > 0 ? ctx.intent.configKeys.join(', ') : 'none';

  return [
    'You are resolving an ambiguous provider service frontier for the Smart Proof Engine.',
    `Frontier reason: ${ctx.frontierReason}`,
    'Respond with patchType=provider_service_selection.',
    `Source service: ${ctx.intent.sourceService}`,
    `HTTP method hint: ${ctx.intent.methodHint ?? 'unknown'}`,
    `Path hint: ${ctx.intent.pathHint ?? 'unknown'}`,
    `Host hint: ${ctx.intent.hostHint ?? 'none'}`,
    `Config keys: ${configKeys}`,
    'Candidate services:',
    candidateServices,
    'Task:',
    'Choose the single best provider service from the candidate set.',
    'If confidence is too low, return resolved=false.',
  ].join('\n');
}

export function buildSmartProviderServiceSelectionPatch(
  proposal: SmartProviderServiceSelectionProposal,
): ResolveSmartAmbiguityResult['patch'] {
  return {
    patchType: 'provider_service_selection',
    payload: {
      selectedServiceId: proposal.selectedServiceId,
      confidence: proposal.confidence,
      evidenceIds: ['smart-agent:PROVIDER_SERVICE_AMBIGUOUS'],
    },
    sourceKind: 'smart_agent',
  };
}

export async function loadSmartAmbiguityContext(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateId: string;
  },
): Promise<SmartAmbiguityResolutionContext | null> {
  const rows = await db
    .select({
      proofStateId: proofStates.id,
      sourceServiceId: proofStates.consumerServiceId,
      slotState: proofStates.slotState,
      frontierReason: proofFrontiers.frontierReason,
      frontierDetail: proofFrontiers.detail,
      intentType: interactionIntents.intentType,
      sourceServiceName: objects.name,
      methodHint: interactionIntents.methodHint,
      pathHint: interactionIntents.externalPathHint,
      hostHint: interactionIntents.hostHint,
      configKeys: interactionIntents.configKeys,
    })
    .from(proofStates)
    .innerJoin(proofFrontiers, eq(proofFrontiers.proofStateId, proofStates.id))
    .innerJoin(interactionIntents, eq(interactionIntents.id, proofStates.intentId))
    .leftJoin(objects, eq(objects.id, interactionIntents.sourceServiceId))
    .where(
      and(
        eq(proofStates.workspaceId, input.workspaceId),
        eq(proofStates.id, input.proofStateId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.sourceServiceId || !isSupportedSmartAmbiguityReason(row.frontierReason)) {
    return null;
  }

  const frontierDetail = asRecord(row.frontierDetail) ?? {};
  const candidateProviderIds = asStringArray(frontierDetail['candidateProviderIds']);
  const candidateServices = candidateProviderIds.length === 0
    ? []
    : await db
      .select({
        id: objects.id,
        name: objects.name,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, input.workspaceId),
          eq(objects.objectType, 'service'),
          inArray(objects.id, candidateProviderIds),
        ),
      );
  const endpointCounts = candidateProviderIds.length === 0
    ? []
    : await db
      .select({
        parentId: objects.parentId,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, input.workspaceId),
          eq(objects.objectType, 'api_endpoint'),
          inArray(objects.parentId, candidateProviderIds),
        ),
      );
  const endpointCountByServiceId = new Map<string, number>();
  for (const row of endpointCounts) {
    if (!row.parentId) continue;
    endpointCountByServiceId.set(row.parentId, (endpointCountByServiceId.get(row.parentId) ?? 0) + 1);
  }

  return {
    workspaceId: input.workspaceId,
    proofStateId: row.proofStateId,
    frontierReason: row.frontierReason,
    sourceServiceId: row.sourceServiceId,
    intent: {
      type: row.intentType,
      sourceService: row.sourceServiceName ?? row.sourceServiceId,
      methodHint: row.methodHint,
      pathHint: row.pathHint,
      hostHint: row.hostHint,
      configKeys: asStringArray(row.configKeys),
    },
    proofState: {
      currentSlots: asRecord(row.slotState) ?? {},
      frontierDetail,
    },
    candidateServices: candidateServices.map((service) => ({
      id: service.id,
      name: service.name,
      endpointCount: endpointCountByServiceId.get(service.id) ?? 0,
    })),
  };
}

async function insertSmartAmbiguityCall(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string | null;
    proofStateId: string;
    frontierReason: string;
    prompt: string;
    response: SmartProviderServiceSelectionProposal;
    generated: SmartGenerateResolutionResult<SmartProviderServiceSelectionProposal>;
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
    callCategory: 'ambiguity_resolution',
    frontierReason: input.frontierReason,
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

export async function resolveSmartAmbiguity(
  db: DbClient,
  input: ResolveSmartAmbiguityInput,
): Promise<ResolveSmartAmbiguityResult> {
  const ctx = await loadSmartAmbiguityContext(db, input);
  if (!ctx) {
    return {
      proofStateId: input.proofStateId,
      frontierReason: 'UNSUPPORTED',
      attempted: false,
      resolved: false,
      confidence: 0,
      reasoning: 'unsupported ambiguity frontier',
      decision: 'SKIPPED',
      patch: null,
      validationStatus: null,
      errors: [],
      resolution: null,
      llmCallId: null,
      tokensUsed: { input: 0, output: 0 },
    };
  }

  const prompt = buildProviderServiceSelectionPrompt(ctx);
  const generated = await input.generateFn(prompt);
  const proposal = generated.object;
  if (proposal.patchType !== 'provider_service_selection') {
    const normalizedProposal: SmartProviderServiceSelectionProposal = {
      patchType: 'provider_service_selection',
      resolved: false,
      selectedServiceId: null,
      selectedServiceName: null,
      confidence: 0,
      reasoning: `unexpected patchType: ${proposal.patchType}`,
      ranking: null,
    };
    const llmCallId = await insertSmartAmbiguityCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      prompt,
      response: normalizedProposal,
      generated: { ...generated, object: normalizedProposal },
      accepted: false,
    });
    return {
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      attempted: true,
      resolved: false,
      confidence: 0,
      reasoning: normalizedProposal.reasoning,
      decision: 'SKIPPED',
      patch: null,
      validationStatus: null,
      errors: [],
      resolution: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
    };
  }

  if (!proposal.resolved) {
    const llmCallId = await insertSmartAmbiguityCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return {
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      attempted: true,
      resolved: false,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      decision: 'SKIPPED',
      patch: null,
      validationStatus: null,
      errors: [],
      resolution: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
    };
  }

  const decision = resolveSmartProofDecision(input.config, proposal.confidence);
  const patch = buildSmartProviderServiceSelectionPatch(proposal);
  if (decision === 'SKIPPED' || !patch) {
    const llmCallId = await insertSmartAmbiguityCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return {
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      attempted: true,
      resolved: false,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      decision: 'SKIPPED',
      patch: null,
      validationStatus: null,
      errors: [],
      resolution: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
    };
  }

  const patchResult = await validateAndApplyProofPatch(db, {
    workspaceId: input.workspaceId,
    proofStateId: input.proofStateId,
    patchType: patch.patchType as ProofPatchType,
    payload: patch.payload,
    sourceKind: 'smart_agent',
    runId: input.runId ?? null,
    applyMode: decision === 'PENDING_REVIEW' ? 'defer' : 'apply',
  });
  const llmCallId = await insertSmartAmbiguityCall(db, {
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    proofStateId: input.proofStateId,
    frontierReason: ctx.frontierReason,
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
    proofStateId: input.proofStateId,
    frontierReason: ctx.frontierReason,
    attempted: true,
    resolved: patchResult.validationStatus === 'ACCEPTED',
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    decision:
      patchResult.validationStatus === 'ACCEPTED'
        ? 'ACCEPTED'
        : patchResult.validationStatus === 'PENDING'
          ? 'PENDING_REVIEW'
          : 'SKIPPED',
    patch,
    validationStatus: patchResult.validationStatus,
    errors: patchResult.errors,
    resolution: patchResult.resolution,
    llmCallId,
    tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
  };
}
