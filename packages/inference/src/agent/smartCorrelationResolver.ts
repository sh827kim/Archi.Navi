import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  aliasBindings,
  interactionIntents,
  objects,
  proofFrontiers,
  proofStates,
} from '@archi-navi/db';
import { smartProofLlmCalls } from '@archi-navi/db/schema';
import { generateId } from '@archi-navi/shared';
import {
  type ProofPatchValidationStatus,
  resolveInteractionIntentProof,
  validateAndApplyProofPatch,
} from '@/orchestration/intentProofEngine';
import type {
  SmartProofConfig,
  SmartProofDecision,
  SupportedSmartCorrelationReason as CanonicalSupportedSmartCorrelationReason,
} from './smartProofTypes';
import {
  isSupportedSmartCorrelationReason as isCanonicalSupportedSmartCorrelationReason,
  resolveSmartProofDecision,
  SMART_CORRELATION_REASONS_SUPPORTED,
} from './smartProofTypes';
import type { GenerateSmartResolutionFn, SmartGenerateResolutionResult } from './smartFrontierResolver';

type JsonRecord = Record<string, unknown>;

export const SUPPORTED_SMART_CORRELATION_REASONS = SMART_CORRELATION_REASONS_SUPPORTED;

export type SupportedSmartCorrelationReason = CanonicalSupportedSmartCorrelationReason;

export interface SmartCorrelationFrontierSeed {
  proofStateId: string;
  intentId: string;
  frontierReason: SupportedSmartCorrelationReason;
  ownerServiceId: string;
  sourceServiceName: string;
  hostHints: string[];
  configKeys: string[];
}

export interface SmartCorrelationFrontierGroup {
  groupKey: string;
  ownerServiceId: string;
  sourceServiceName: string;
  normalizedHostHints: string[];
  normalizedConfigKeys: string[];
  proofStateIds: string[];
  intentIds: string[];
  reasons: SupportedSmartCorrelationReason[];
  representativeProofStateId: string;
  representativeIntentId: string;
  representativeHostHints: string[];
  representativeConfigKeys: string[];
}

export interface SmartCorrelationAliasBindingProposal {
  patchType: 'alias_binding';
  resolved: boolean;
  selectedServiceId: string | null;
  selectedServiceName: string | null;
  confidence: number;
  reasoning: string;
  aliasBinding: {
    aliasKey: string;
    aliasValue: string;
    bindingKind: 'base_url' | 'service_discovery' | 'gateway_target' | 'property_alias';
  } | null;
}

export interface ResolveSmartCorrelationGroupInput {
  workspaceId: string;
  runId?: string | null;
  config: SmartProofConfig;
  group: SmartCorrelationFrontierGroup;
  generateFn: GenerateSmartResolutionFn<SmartCorrelationAliasBindingProposal>;
}

export interface ResolveSmartCorrelationGroupResult {
  groupKey: string;
  attempted: boolean;
  resolved: boolean;
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
  frontierCountBefore: number;
  frontierCountAfter: number;
  frontierReducedCount: number;
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

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isSupportedSmartCorrelationReason(
  reason: string | null,
): reason is SupportedSmartCorrelationReason {
  return isCanonicalSupportedSmartCorrelationReason(reason);
}

function buildGroupKey(input: {
  ownerServiceId: string;
  normalizedHostHints: string[];
  normalizedConfigKeys: string[];
}): string {
  return [
    input.ownerServiceId,
    input.normalizedHostHints.join('|'),
    input.normalizedConfigKeys.join('|'),
  ].join('::');
}

export function buildSmartCorrelationPrompt(
  group: SmartCorrelationFrontierGroup,
  availableServices: Array<{ id: string; name: string; endpointCount: number }>,
  existingBindings: Array<{ aliasKey: string; aliasValue: string; resolvedServiceName: string | null }>,
): string {
  const reasons = group.reasons.join(', ');
  const hostHints = group.representativeHostHints.length > 0 ? group.representativeHostHints.join(', ') : 'none';
  const configKeys = group.representativeConfigKeys.length > 0 ? group.representativeConfigKeys.join(', ') : 'none';
  const serviceLines = availableServices.length > 0
    ? availableServices.map((service) => `- ${service.id}: ${service.name} (${service.endpointCount} endpoints)`).join('\n')
    : 'none';
  const bindingLines = existingBindings.length > 0
    ? existingBindings.map((binding) => `- ${binding.aliasKey} = ${binding.aliasValue} -> ${binding.resolvedServiceName ?? 'unresolved'}`).join('\n')
    : 'none';

  return [
    'You are correlating repeated alias/config frontiers for the Smart Proof Engine.',
    'Respond with patchType=alias_binding.',
    `Owner service: ${group.sourceServiceName} (${group.ownerServiceId})`,
    `Correlated frontier count: ${group.proofStateIds.length}`,
    `Frontier reasons in group: ${reasons}`,
    `Host hints: ${hostHints}`,
    `Config keys: ${configKeys}`,
    'Available services:',
    serviceLines,
    'Existing alias bindings for this owner service:',
    bindingLines,
    'Task:',
    'Choose one target service and alias binding that can resolve this repeated frontier pattern.',
    'If confidence is too low, return resolved=false.',
  ].join('\n');
}

function buildCorrelationPatch(
  group: SmartCorrelationFrontierGroup,
  proposal: SmartCorrelationAliasBindingProposal,
): { patchType: 'alias_binding'; payload: Record<string, unknown>; sourceKind: 'smart_agent' } {
  const aliasKey = proposal.aliasBinding?.aliasKey
    ?? group.representativeConfigKeys[0]
    ?? group.representativeHostHints[0]
    ?? 'smart.alias';
  const aliasValue = proposal.aliasBinding?.aliasValue
    ?? group.representativeHostHints[0]
    ?? aliasKey;

  return {
    patchType: 'alias_binding',
    payload: {
      ownerServiceId: group.ownerServiceId,
      bindingKind: proposal.aliasBinding?.bindingKind ?? 'property_alias',
      aliasKey,
      aliasValue,
      resolvedServiceId: proposal.selectedServiceId,
      confidence: proposal.confidence,
      evidenceIds: [`smart-agent:${group.reasons[0] ?? 'HOST_ALIAS_UNRESOLVED'}`],
    },
    sourceKind: 'smart_agent',
  };
}

async function insertSmartLlmCall(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string | null;
    proofStateId: string;
    frontierReason: string;
    prompt: string;
    response: SmartCorrelationAliasBindingProposal;
    generated: SmartGenerateResolutionResult<SmartCorrelationAliasBindingProposal>;
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
    callCategory: 'cross_proof_correlation',
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

async function countGroupFrontiers(
  db: DbClient,
  input: { workspaceId: string; proofStateIds: string[] },
): Promise<number> {
  if (input.proofStateIds.length === 0) return 0;
  const rows = await db
    .select({ proofStateId: proofFrontiers.proofStateId })
    .from(proofFrontiers)
    .where(
      and(
        eq(proofFrontiers.workspaceId, input.workspaceId),
        inArray(proofFrontiers.proofStateId, input.proofStateIds),
        inArray(proofFrontiers.frontierReason, [...SUPPORTED_SMART_CORRELATION_REASONS]),
      ),
    );
  return rows.length;
}

export async function loadSmartCorrelationFrontierGroups(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateIds: string[];
  },
): Promise<SmartCorrelationFrontierGroup[]> {
  if (input.proofStateIds.length === 0) return [];

  const rows = await db
    .select({
      proofStateId: proofStates.id,
      intentId: proofStates.intentId,
      ownerServiceId: proofStates.consumerServiceId,
      sourceServiceName: objects.name,
      frontierReason: proofFrontiers.frontierReason,
      frontierDetail: proofFrontiers.detail,
      intentHostHint: interactionIntents.hostHint,
      intentConfigKeys: interactionIntents.configKeys,
    })
    .from(proofStates)
    .innerJoin(proofFrontiers, eq(proofFrontiers.proofStateId, proofStates.id))
    .innerJoin(interactionIntents, eq(interactionIntents.id, proofStates.intentId))
    .leftJoin(objects, eq(objects.id, proofStates.consumerServiceId))
    .where(
      and(
        eq(proofStates.workspaceId, input.workspaceId),
        inArray(proofStates.id, input.proofStateIds),
      ),
    );

  const seeds: SmartCorrelationFrontierSeed[] = [];
  for (const row of rows) {
    if (!row.ownerServiceId || !isSupportedSmartCorrelationReason(row.frontierReason)) continue;
    const detail = asRecord(row.frontierDetail) ?? {};
    const hostHints = asStringArray(detail['hostHints']);
    const configKeys = asStringArray(detail['configKeys']);
    seeds.push({
      proofStateId: row.proofStateId,
      intentId: row.intentId,
      frontierReason: row.frontierReason,
      ownerServiceId: row.ownerServiceId,
      sourceServiceName: row.sourceServiceName ?? row.ownerServiceId,
      hostHints: hostHints.length > 0 ? hostHints : asStringArray([row.intentHostHint]),
      configKeys: configKeys.length > 0 ? configKeys : asStringArray(row.intentConfigKeys),
    });
  }

  const grouped = new Map<string, SmartCorrelationFrontierGroup>();
  for (const seed of seeds) {
    const normalizedHostHints = normalizeList(seed.hostHints);
    const normalizedConfigKeys = normalizeList(seed.configKeys);
    const groupKey = buildGroupKey({
      ownerServiceId: seed.ownerServiceId,
      normalizedHostHints,
      normalizedConfigKeys,
    });
    const existing = grouped.get(groupKey);
    if (!existing) {
      grouped.set(groupKey, {
        groupKey,
        ownerServiceId: seed.ownerServiceId,
        sourceServiceName: seed.sourceServiceName,
        normalizedHostHints,
        normalizedConfigKeys,
        proofStateIds: [seed.proofStateId],
        intentIds: [seed.intentId],
        reasons: [seed.frontierReason],
        representativeProofStateId: seed.proofStateId,
        representativeIntentId: seed.intentId,
        representativeHostHints: seed.hostHints,
        representativeConfigKeys: seed.configKeys,
      });
      continue;
    }
    if (!existing.proofStateIds.includes(seed.proofStateId)) existing.proofStateIds.push(seed.proofStateId);
    if (!existing.intentIds.includes(seed.intentId)) existing.intentIds.push(seed.intentId);
    if (!existing.reasons.includes(seed.frontierReason)) existing.reasons.push(seed.frontierReason);
  }

  return Array.from(grouped.values())
    .filter((group) => group.proofStateIds.length > 1)
    .sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

export async function resolveSmartCorrelationGroup(
  db: DbClient,
  input: ResolveSmartCorrelationGroupInput,
): Promise<ResolveSmartCorrelationGroupResult> {
  const group = input.group;
  const [serviceRows, endpointRows, existingBindings, frontierCountBefore] = await Promise.all([
    db
      .select({
        id: objects.id,
        name: objects.name,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, input.workspaceId), eq(objects.objectType, 'service'))),
    db
      .select({
        parentId: objects.parentId,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, input.workspaceId), eq(objects.objectType, 'api_endpoint'))),
    db
      .select({
        aliasKey: aliasBindings.aliasKey,
        aliasValue: aliasBindings.aliasValue,
        resolvedServiceId: aliasBindings.resolvedServiceId,
      })
      .from(aliasBindings)
      .where(
        and(
          eq(aliasBindings.workspaceId, input.workspaceId),
          eq(aliasBindings.ownerServiceId, group.ownerServiceId),
          eq(aliasBindings.status, 'ACTIVE'),
        ),
      ),
    countGroupFrontiers(db, { workspaceId: input.workspaceId, proofStateIds: group.proofStateIds }),
  ]);

  const endpointCountByServiceId = new Map<string, number>();
  for (const row of endpointRows) {
    if (!row.parentId) continue;
    endpointCountByServiceId.set(row.parentId, (endpointCountByServiceId.get(row.parentId) ?? 0) + 1);
  }
  const resolvedServiceIds = existingBindings
    .map((binding) => binding.resolvedServiceId)
    .filter((value): value is string => typeof value === 'string');
  const resolvedServiceNames = resolvedServiceIds.length === 0
    ? new Map<string, string>()
    : new Map(
      (
        await db
          .select({ id: objects.id, name: objects.name })
          .from(objects)
          .where(and(eq(objects.workspaceId, input.workspaceId), inArray(objects.id, resolvedServiceIds)))
      ).map((row) => [row.id, row.name]),
    );

  const prompt = buildSmartCorrelationPrompt(
    group,
    serviceRows.map((service) => ({
      id: service.id,
      name: service.name,
      endpointCount: endpointCountByServiceId.get(service.id) ?? 0,
    })),
    existingBindings.map((binding) => ({
      aliasKey: binding.aliasKey,
      aliasValue: binding.aliasValue,
      resolvedServiceName: binding.resolvedServiceId ? (resolvedServiceNames.get(binding.resolvedServiceId) ?? null) : null,
    })),
  );
  const generated = await input.generateFn(prompt);
  const proposal = generated.object;

  if (!proposal.resolved) {
    const llmCallId = await insertSmartLlmCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: group.representativeProofStateId,
      frontierReason: group.reasons[0] ?? 'HOST_ALIAS_UNRESOLVED',
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return {
      groupKey: group.groupKey,
      attempted: true,
      resolved: false,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      decision: 'SKIPPED',
      validationStatus: null,
      patchId: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
      frontierCountBefore,
      frontierCountAfter: frontierCountBefore,
      frontierReducedCount: 0,
    };
  }

  const decision = resolveSmartProofDecision(input.config, proposal.confidence);
  const patch = buildCorrelationPatch(group, proposal);
  if (decision === 'SKIPPED') {
    const llmCallId = await insertSmartLlmCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: group.representativeProofStateId,
      frontierReason: group.reasons[0] ?? 'HOST_ALIAS_UNRESOLVED',
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return {
      groupKey: group.groupKey,
      attempted: true,
      resolved: false,
      confidence: proposal.confidence,
      reasoning: proposal.reasoning,
      decision,
      validationStatus: null,
      patchId: null,
      llmCallId,
      tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
      frontierCountBefore,
      frontierCountAfter: frontierCountBefore,
      frontierReducedCount: 0,
    };
  }

  const patchResult = await validateAndApplyProofPatch(db, {
    workspaceId: input.workspaceId,
    proofStateId: group.representativeProofStateId,
    patchType: 'alias_binding',
    payload: patch.payload,
    sourceKind: 'smart_agent',
    runId: input.runId ?? null,
    applyMode: decision === 'PENDING_REVIEW' ? 'defer' : 'apply',
  });
  const accepted = patchResult.validationStatus === 'ACCEPTED';
  let frontierCountAfter = frontierCountBefore;
  if (accepted) {
    const intentIdsToReconcile = group.intentIds.filter((intentId) => intentId !== group.representativeIntentId);
    for (const intentId of intentIdsToReconcile) {
      await resolveInteractionIntentProof(db, {
        workspaceId: input.workspaceId,
        intentId,
      });
    }
    frontierCountAfter = await countGroupFrontiers(db, {
      workspaceId: input.workspaceId,
      proofStateIds: group.proofStateIds,
    });
  }

  const llmCallId = await insertSmartLlmCall(db, {
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    proofStateId: group.representativeProofStateId,
    frontierReason: group.reasons[0] ?? 'HOST_ALIAS_UNRESOLVED',
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

  const resolved = patchResult.validationStatus === 'ACCEPTED';
  return {
    groupKey: group.groupKey,
    attempted: true,
    resolved,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    decision: patchResult.validationStatus === 'ACCEPTED'
      ? 'ACCEPTED'
      : patchResult.validationStatus === 'PENDING'
        ? 'PENDING_REVIEW'
        : 'SKIPPED',
    validationStatus: patchResult.validationStatus,
    patchId: patchResult.patchId,
    llmCallId,
    tokensUsed: { input: generated.promptTokens, output: generated.completionTokens },
    frontierCountBefore,
    frontierCountAfter,
    frontierReducedCount: Math.max(0, frontierCountBefore - frontierCountAfter),
  };
}
