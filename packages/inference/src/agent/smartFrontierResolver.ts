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
  type ProofPatchType,
  type ProofPatchValidationStatus,
  validateAndApplyProofPatch,
} from '@/orchestration/intentProofEngine';
import {
  type SmartFrontierResolution,
  type SmartProofConfig,
  type SmartProofDecision,
  resolveSmartProofDecision,
} from './smartProofTypes';

type JsonRecord = Record<string, unknown>;

export const SUPPORTED_SMART_FRONTIER_REASONS = [
  'HOST_ALIAS_UNRESOLVED',
  'CONFIG_BINDING_MISSING',
  'ROUTE_FAMILY_DERIVATION_EMPTY',
  'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED',
  'METHOD_UNKNOWN',
  'ENDPOINT_MATCH_AMBIGUOUS',
] as const;

export type SupportedSmartFrontierReason = (typeof SUPPORTED_SMART_FRONTIER_REASONS)[number];

export interface SmartFrontierAvailableService {
  id: string;
  name: string;
  endpointCount: number;
}

export interface SmartFrontierCandidateEndpoint {
  id: string;
  name: string;
  method: string | null;
  path: string | null;
  serviceId: string | null;
  serviceName: string | null;
}

export interface SmartFrontierAliasBinding {
  key: string;
  value: string;
  resolvedService: string | null;
}

export interface SmartFrontierResolutionContext {
  workspaceId: string;
  proofStateId: string;
  frontierReason: SupportedSmartFrontierReason;
  sourceServiceId: string;
  intent: {
    type: string;
    sourceService: string;
    methodHint: string | null;
    pathHint: string | null;
    hostHint: string | null;
    configKeys: string[];
    targetServiceHint: string | null;
    providerHint: string | null;
    gatewayKind: string | null;
    externalRoutePattern: string | null;
  };
  proofState: {
    currentSlots: Record<string, unknown>;
    frontierDetail: Record<string, unknown>;
  };
  availableServices: SmartFrontierAvailableService[];
  aliasBindings: SmartFrontierAliasBinding[];
  candidateEndpoints: SmartFrontierCandidateEndpoint[];
}

export interface SmartAliasBindingProposal {
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

export interface SmartRouteTransformProposal {
  patchType: 'route_transform_patch';
  resolved: boolean;
  confidence: number;
  reasoning: string;
  routeTransform: {
    gatewayKind: string | null;
    matchPath: string | null;
    targetServiceHint: string | null;
    targetHostAlias: string | null;
    priority: number | null;
  } | null;
}

export interface SmartEndpointDisambiguationProposal {
  patchType: 'endpoint_disambiguation';
  resolved: boolean;
  confidence: number;
  reasoning: string;
  endpointSelection: {
    endpointId: string | null;
    method: string | null;
    path: string | null;
  } | null;
}

export interface SmartMethodPathHintProposal {
  patchType: 'method_path_hint';
  resolved: boolean;
  confidence: number;
  reasoning: string;
  methodPathHint: {
    method: string | null;
    externalPath: string | null;
  } | null;
}

export type SmartPatchProposal =
  | SmartAliasBindingProposal
  | SmartRouteTransformProposal
  | SmartEndpointDisambiguationProposal
  | SmartMethodPathHintProposal;

export interface SmartGenerateResolutionResult<T> {
  model: string;
  promptTokens: number;
  completionTokens: number;
  object: T;
}

export type GenerateSmartResolutionFn<T> = (
  prompt: string,
) => Promise<SmartGenerateResolutionResult<T>>;

export interface ResolveSmartFrontierInput {
  workspaceId: string;
  proofStateId: string;
  runId?: string | null;
  config: SmartProofConfig;
  generateFn: GenerateSmartResolutionFn<SmartPatchProposal>;
}

export interface ResolveSmartFrontierResult extends SmartFrontierResolution {
  attempted: boolean;
  frontierReason: string;
  validationStatus: ProofPatchValidationStatus | null;
  errors: string[];
  resolution: Awaited<ReturnType<typeof validateAndApplyProofPatch>>['resolution'] | null;
  llmCallId: string | null;
  decision: SmartProofDecision;
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

function getEndpointMetadata(value: unknown): { method: string | null; path: string | null } {
  const metadata = asRecord(value);
  return {
    method: asString(metadata?.['method']),
    path: asString(metadata?.['path']),
  };
}

export function isSupportedSmartFrontierReason(
  reason: string | null,
): reason is SupportedSmartFrontierReason {
  return typeof reason === 'string'
    && (SUPPORTED_SMART_FRONTIER_REASONS as readonly string[]).includes(reason);
}

function supportsAliasBindingPatch(reason: SupportedSmartFrontierReason): boolean {
  return reason === 'HOST_ALIAS_UNRESOLVED' || reason === 'CONFIG_BINDING_MISSING';
}

function supportsRouteTransformPatch(reason: SupportedSmartFrontierReason): boolean {
  return reason === 'ROUTE_FAMILY_DERIVATION_EMPTY' || reason === 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED';
}

function supportsMethodPathPatch(reason: SupportedSmartFrontierReason): boolean {
  return reason === 'METHOD_UNKNOWN';
}

function supportsEndpointDisambiguationPatch(reason: SupportedSmartFrontierReason): boolean {
  return reason === 'ENDPOINT_MATCH_AMBIGUOUS';
}

export function buildHostAliasResolutionPrompt(ctx: SmartFrontierResolutionContext): string {
  const configKeys = ctx.intent.configKeys.length > 0 ? ctx.intent.configKeys.join(', ') : 'none';
  const availableServices = ctx.availableServices.length > 0
    ? ctx.availableServices.map((service) => `- ${service.name} (${service.endpointCount} endpoints)`).join('\n')
    : 'none';
  const existingAliasBindings = ctx.aliasBindings.length > 0
    ? ctx.aliasBindings.map((binding) => `- ${binding.key} = ${binding.value} -> ${binding.resolvedService ?? 'unresolved'}`).join('\n')
    : 'none';

  return [
    'You are resolving a microservice dependency for the Smart Proof Engine.',
    `Frontier reason: ${ctx.frontierReason}`,
    'Respond with patchType=alias_binding.',
    `Source service: ${ctx.intent.sourceService}`,
    `HTTP method hint: ${ctx.intent.methodHint ?? 'unknown'}`,
    `Path hint: ${ctx.intent.pathHint ?? 'unknown'}`,
    `Host hint: ${ctx.intent.hostHint ?? 'none'}`,
    `Config keys: ${configKeys}`,
    'Available services:',
    availableServices,
    'Existing alias bindings:',
    existingAliasBindings,
    'Task:',
    'Determine the single most likely target service for this outbound dependency.',
    'If confidence is too low, return resolved=false.',
  ].join('\n');
}

export function buildRouteTransformResolutionPrompt(ctx: SmartFrontierResolutionContext): string {
  const availableServices = ctx.availableServices.length > 0
    ? ctx.availableServices.map((service) => `- ${service.name} (${service.endpointCount} endpoints)`).join('\n')
    : 'none';

  return [
    'You are resolving a gateway route frontier for the Smart Proof Engine.',
    `Frontier reason: ${ctx.frontierReason}`,
    'Respond with patchType=route_transform_patch.',
    `Gateway kind: ${ctx.intent.gatewayKind ?? 'unknown'}`,
    `Source service: ${ctx.intent.sourceService}`,
    `Match path hint: ${ctx.intent.externalRoutePattern ?? ctx.intent.pathHint ?? 'unknown'}`,
    `Target service hint: ${ctx.intent.targetServiceHint ?? 'none'}`,
    `Provider hint: ${ctx.intent.providerHint ?? 'none'}`,
    `Host hint: ${ctx.intent.hostHint ?? 'none'}`,
    'Available services:',
    availableServices,
    'Task:',
    'Propose the minimal route transform needed to make this gateway route resolvable.',
    'If confidence is too low, return resolved=false.',
  ].join('\n');
}

export function buildEndpointDisambiguationPrompt(ctx: SmartFrontierResolutionContext): string {
  const candidateEndpoints = ctx.candidateEndpoints.length > 0
    ? ctx.candidateEndpoints
      .map((endpoint) => `- ${endpoint.id}: ${endpoint.method ?? 'UNKNOWN'} ${endpoint.path ?? endpoint.name} (${endpoint.serviceName ?? endpoint.serviceId ?? 'unknown service'})`)
      .join('\n')
    : 'none';

  return [
    'You are resolving an ambiguous endpoint frontier for the Smart Proof Engine.',
    `Frontier reason: ${ctx.frontierReason}`,
    'Respond with patchType=endpoint_disambiguation.',
    `Source service: ${ctx.intent.sourceService}`,
    `Provider hint: ${ctx.intent.providerHint ?? ctx.intent.targetServiceHint ?? 'none'}`,
    `HTTP method hint: ${ctx.intent.methodHint ?? 'unknown'}`,
    `Path hint: ${ctx.intent.pathHint ?? 'unknown'}`,
    'Candidate endpoints:',
    candidateEndpoints,
    'Task:',
    'Select the single best endpoint from the candidate set. If the frontier cannot be resolved confidently, return resolved=false.',
  ].join('\n');
}

export function buildMethodPathHintPrompt(ctx: SmartFrontierResolutionContext): string {
  const candidateEndpoints = ctx.candidateEndpoints.length > 0
    ? ctx.candidateEndpoints
      .map((endpoint) => `- ${endpoint.method ?? 'UNKNOWN'} ${endpoint.path ?? endpoint.name}`)
      .join('\n')
    : 'none';

  return [
    'You are resolving an HTTP method/path frontier for the Smart Proof Engine.',
    `Frontier reason: ${ctx.frontierReason}`,
    'Respond with patchType=method_path_hint.',
    `Source service: ${ctx.intent.sourceService}`,
    `Current method hint: ${ctx.intent.methodHint ?? 'unknown'}`,
    `Current path hint: ${ctx.intent.pathHint ?? 'unknown'}`,
    `Provider hint: ${ctx.intent.providerHint ?? ctx.intent.targetServiceHint ?? 'none'}`,
    'Candidate endpoints:',
    candidateEndpoints,
    'Task:',
    'Infer the most likely HTTP method and external path. If confidence is too low, return resolved=false.',
  ].join('\n');
}

export function buildSmartFrontierPrompt(ctx: SmartFrontierResolutionContext): string {
  if (supportsAliasBindingPatch(ctx.frontierReason)) {
    return buildHostAliasResolutionPrompt(ctx);
  }
  if (supportsRouteTransformPatch(ctx.frontierReason)) {
    return buildRouteTransformResolutionPrompt(ctx);
  }
  if (supportsEndpointDisambiguationPatch(ctx.frontierReason)) {
    return buildEndpointDisambiguationPrompt(ctx);
  }
  if (supportsMethodPathPatch(ctx.frontierReason)) {
    return buildMethodPathHintPrompt(ctx);
  }
  return [
    'You are resolving a Smart Proof Engine frontier.',
    `Frontier reason: ${ctx.frontierReason}`,
    'If there is not enough information, return resolved=false.',
  ].join('\n');
}

export function buildSmartAliasBindingPatch(
  ctx: SmartFrontierResolutionContext,
  proposal: SmartAliasBindingProposal,
): NonNullable<SmartFrontierResolution['patch']> {
  const aliasKey = proposal.aliasBinding?.aliasKey ?? ctx.intent.configKeys[0] ?? ctx.intent.hostHint ?? 'smart.alias';
  const aliasValue = proposal.aliasBinding?.aliasValue ?? ctx.intent.hostHint ?? aliasKey;

  return {
    patchType: 'alias_binding',
    payload: {
      ownerServiceId: ctx.sourceServiceId,
      bindingKind: proposal.aliasBinding?.bindingKind ?? 'property_alias',
      aliasKey,
      aliasValue,
      resolvedServiceId: proposal.selectedServiceId,
      confidence: proposal.confidence,
      evidenceIds: [`smart-agent:${ctx.frontierReason}`],
    },
    sourceKind: 'smart_agent',
  };
}

export function buildSmartRouteTransformPatch(
  ctx: SmartFrontierResolutionContext,
  proposal: SmartRouteTransformProposal,
): NonNullable<SmartFrontierResolution['patch']> {
  return {
    patchType: 'route_transform_patch',
    payload: {
      ownerServiceId: ctx.sourceServiceId,
      gatewayKind: proposal.routeTransform?.gatewayKind ?? ctx.intent.gatewayKind,
      matchPath: proposal.routeTransform?.matchPath ?? ctx.intent.externalRoutePattern ?? ctx.intent.pathHint,
      targetServiceHint: proposal.routeTransform?.targetServiceHint ?? ctx.intent.targetServiceHint ?? ctx.intent.providerHint,
      targetHostAlias: proposal.routeTransform?.targetHostAlias ?? ctx.intent.hostHint,
      priority: proposal.routeTransform?.priority ?? 100,
      evidenceIds: [`smart-agent:${ctx.frontierReason}`],
    },
    sourceKind: 'smart_agent',
  };
}

export function buildSmartEndpointDisambiguationPatch(
  _ctx: SmartFrontierResolutionContext,
  proposal: SmartEndpointDisambiguationProposal,
): NonNullable<SmartFrontierResolution['patch']> {
  return {
    patchType: 'endpoint_disambiguation',
    payload: {
      endpointId: proposal.endpointSelection?.endpointId,
      method: proposal.endpointSelection?.method,
      path: proposal.endpointSelection?.path,
      confidence: proposal.confidence,
      evidenceIds: ['smart-agent:ENDPOINT_MATCH_AMBIGUOUS'],
    },
    sourceKind: 'smart_agent',
  };
}

export function buildSmartMethodPathHintPatch(
  _ctx: SmartFrontierResolutionContext,
  proposal: SmartMethodPathHintProposal,
): NonNullable<SmartFrontierResolution['patch']> {
  return {
    patchType: 'method_path_hint',
    payload: {
      method: proposal.methodPathHint?.method,
      externalPath: proposal.methodPathHint?.externalPath,
      confidence: proposal.confidence,
      evidenceIds: ['smart-agent:METHOD_UNKNOWN'],
    },
    sourceKind: 'smart_agent',
  };
}

export function buildSmartPatchFromProposal(
  ctx: SmartFrontierResolutionContext,
  proposal: SmartPatchProposal,
): NonNullable<SmartFrontierResolution['patch']> | null {
  if (proposal.patchType === 'alias_binding' && supportsAliasBindingPatch(ctx.frontierReason)) {
    return buildSmartAliasBindingPatch(ctx, proposal);
  }
  if (proposal.patchType === 'route_transform_patch' && supportsRouteTransformPatch(ctx.frontierReason)) {
    return buildSmartRouteTransformPatch(ctx, proposal);
  }
  if (proposal.patchType === 'endpoint_disambiguation' && supportsEndpointDisambiguationPatch(ctx.frontierReason)) {
    return buildSmartEndpointDisambiguationPatch(ctx, proposal);
  }
  if (proposal.patchType === 'method_path_hint' && supportsMethodPathPatch(ctx.frontierReason)) {
    return buildSmartMethodPathHintPatch(ctx, proposal);
  }
  return null;
}

async function loadSmartFrontierResolutionContext(
  db: DbClient,
  workspaceId: string,
  proofStateId: string,
): Promise<SmartFrontierResolutionContext | null> {
  const [stateRow, frontierRow] = await Promise.all([
    db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.id, proofStateId)))
      .limit(1),
    db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)))
      .limit(1),
  ]);

  const state = stateRow[0];
  const frontier = frontierRow[0];
  if (!state || state.status !== 'FRONTIER' || !frontier || !isSupportedSmartFrontierReason(frontier.frontierReason)) {
    return null;
  }

  const intentRows = await db
    .select()
    .from(interactionIntents)
    .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.id, state.intentId)))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) return null;

  const [serviceRows, endpointRows, bindingRows] = await Promise.all([
    db
      .select({
        id: objects.id,
        name: objects.name,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service'))),
    db
      .select({
        id: objects.id,
        name: objects.name,
        parentId: objects.parentId,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'api_endpoint'))),
    db
      .select({
        aliasKey: aliasBindings.aliasKey,
        aliasValue: aliasBindings.aliasValue,
        resolvedServiceId: aliasBindings.resolvedServiceId,
      })
      .from(aliasBindings)
      .where(
        and(
          eq(aliasBindings.workspaceId, workspaceId),
          eq(aliasBindings.ownerServiceId, intent.sourceServiceId),
          eq(aliasBindings.status, 'ACTIVE'),
        ),
      ),
  ]);

  const endpointCountByService = new Map<string, number>();
  for (const endpoint of endpointRows) {
    if (!endpoint.parentId) continue;
    endpointCountByService.set(endpoint.parentId, (endpointCountByService.get(endpoint.parentId) ?? 0) + 1);
  }

  const serviceIds = bindingRows
    .map((binding) => binding.resolvedServiceId)
    .filter((value): value is string => typeof value === 'string');
  const resolvedServiceNames = serviceIds.length === 0
    ? new Map<string, string>()
    : new Map((
      await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, serviceIds)))
    ).map((row) => [row.id, row.name]));

  const frontierDetail = asRecord(frontier.detail) ?? {};
  const endpointCandidateSet = asRecord(frontierDetail['endpointCandidateSet']);
  const explicitCandidateEndpointIds = [
    ...asStringArray(frontierDetail['candidateObjectIds']),
    ...asStringArray(endpointCandidateSet?.['objectIds']),
  ];
  const shouldUseProviderEndpointFallback =
    (state.providerServiceId && (frontier.frontierReason === 'METHOD_UNKNOWN' || frontier.frontierReason === 'ENDPOINT_MATCH_AMBIGUOUS'))
    && explicitCandidateEndpointIds.length === 0;
  const fallbackCandidateEndpointIds = shouldUseProviderEndpointFallback
      ? endpointRows
        .filter((endpoint) => endpoint.parentId === state.providerServiceId)
        .map((endpoint) => endpoint.id)
      : [];
  const candidateEndpointIds = explicitCandidateEndpointIds.length > 0
    ? explicitCandidateEndpointIds
    : fallbackCandidateEndpointIds;
  const candidateEndpoints = candidateEndpointIds.length === 0
    ? []
    : endpointRows
      .filter((endpoint) => candidateEndpointIds.includes(endpoint.id))
      .map((endpoint) => {
        const endpointMetadata = getEndpointMetadata(endpoint.metadata);
        const serviceId = endpoint.parentId ?? null;
        return {
          id: endpoint.id,
          name: endpoint.name,
          method: endpointMetadata.method,
          path: endpointMetadata.path,
          serviceId,
          serviceName: serviceId ? (serviceRows.find((service) => service.id === serviceId)?.name ?? null) : null,
        };
      });

  return {
    workspaceId,
    proofStateId,
    frontierReason: frontier.frontierReason,
    sourceServiceId: intent.sourceServiceId,
    intent: {
      type: intent.intentType,
      sourceService: serviceRows.find((service) => service.id === intent.sourceServiceId)?.name ?? intent.sourceServiceId,
      methodHint: intent.methodHint,
      pathHint: intent.externalPathHint,
      hostHint: intent.hostHint,
      configKeys: asStringArray(intent.configKeys),
      targetServiceHint: asString(intent.targetServiceHint),
      providerHint: asString(intent.providerHint),
      gatewayKind: asString(intent.gatewayKind),
      externalRoutePattern: asString(intent.externalRoutePattern),
    },
    proofState: {
      currentSlots: asRecord(state.slotState) ?? {},
      frontierDetail,
    },
    availableServices: serviceRows.map((service) => ({
      id: service.id,
      name: service.name,
      endpointCount: endpointCountByService.get(service.id) ?? 0,
    })),
    aliasBindings: bindingRows.map((binding) => ({
      key: binding.aliasKey,
      value: binding.aliasValue,
      resolvedService: binding.resolvedServiceId ? (resolvedServiceNames.get(binding.resolvedServiceId) ?? null) : null,
    })),
    candidateEndpoints,
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
    response: SmartPatchProposal;
    generated: SmartGenerateResolutionResult<SmartPatchProposal>;
    accepted: boolean | null;
    patchId?: string | null | undefined;
  },
): Promise<string> {
  const id = generateId();
  await db.insert(smartProofLlmCalls).values({
    id,
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    proofStateId: input.proofStateId,
    callCategory: 'frontier_resolution',
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

function buildUnsupportedResult(input: ResolveSmartFrontierInput): ResolveSmartFrontierResult {
  return {
    proofStateId: input.proofStateId,
    frontierReason: 'UNSUPPORTED',
    attempted: false,
    resolved: false,
    decision: 'SKIPPED',
    patch: null,
    llmCallId: null,
    confidence: 0,
    reasoning: '지원하지 않는 frontier 입니다.',
    tokensUsed: { input: 0, output: 0 },
    validationStatus: null,
    errors: [],
    resolution: null,
  };
}

function buildSkippedResult(
  input: ResolveSmartFrontierInput,
  ctx: SmartFrontierResolutionContext,
  generated: SmartGenerateResolutionResult<SmartPatchProposal>,
  proposal: SmartPatchProposal,
  llmCallId: string,
): ResolveSmartFrontierResult {
  return {
    proofStateId: input.proofStateId,
    frontierReason: ctx.frontierReason,
    attempted: true,
    resolved: false,
    decision: 'SKIPPED',
    patch: null,
    llmCallId,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    tokensUsed: {
      input: generated.promptTokens,
      output: generated.completionTokens,
    },
    validationStatus: null,
    errors: [],
    resolution: null,
  };
}

export async function resolveSmartFrontier(
  db: DbClient,
  input: ResolveSmartFrontierInput,
): Promise<ResolveSmartFrontierResult> {
  const ctx = await loadSmartFrontierResolutionContext(db, input.workspaceId, input.proofStateId);
  if (!ctx) {
    return buildUnsupportedResult(input);
  }

  const prompt = buildSmartFrontierPrompt(ctx);
  const generated = await input.generateFn(prompt);
  const proposal = generated.object;

  if (!proposal.resolved) {
    const llmCallId = await insertSmartLlmCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return buildSkippedResult(input, ctx, generated, proposal, llmCallId);
  }

  const disposition = resolveSmartProofDecision(input.config, proposal.confidence);
  const patch = buildSmartPatchFromProposal(ctx, proposal);

  if (disposition === 'SKIPPED' || !patch) {
    const llmCallId = await insertSmartLlmCall(db, {
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proofStateId: input.proofStateId,
      frontierReason: ctx.frontierReason,
      prompt,
      response: proposal,
      generated,
      accepted: false,
    });
    return buildSkippedResult(input, ctx, generated, proposal, llmCallId);
  }

  const patchResult = await validateAndApplyProofPatch(db, {
    workspaceId: input.workspaceId,
    proofStateId: input.proofStateId,
    patchType: patch.patchType as ProofPatchType,
    payload: patch.payload,
    sourceKind: 'smart_agent',
    runId: input.runId ?? null,
    applyMode: disposition === 'PENDING_REVIEW' ? 'defer' : 'apply',
  });

  let decision: SmartProofDecision;
  if (patchResult.validationStatus === 'ACCEPTED') {
    decision = 'ACCEPTED';
  } else if (patchResult.validationStatus === 'PENDING') {
    decision = 'PENDING_REVIEW';
  } else {
    decision = 'SKIPPED';
  }

  const llmCallId = await insertSmartLlmCall(db, {
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
    decision,
    patch,
    llmCallId,
    confidence: proposal.confidence,
    reasoning: proposal.reasoning,
    tokensUsed: {
      input: generated.promptTokens,
      output: generated.completionTokens,
    },
    validationStatus: patchResult.validationStatus,
    errors: patchResult.errors,
    resolution: patchResult.resolution,
  };
}
