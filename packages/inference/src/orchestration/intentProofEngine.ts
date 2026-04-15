import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  aliasBindings,
  domainInferenceProfiles,
  functionSummaries,
  interactionIntents,
  objects,
  proofDependencies,
  proofFrontiers,
  proofPatches,
  proofStates,
  proofSteps,
  relationCandidates,
  routeTransforms,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  describeConfigEntries,
  describeConfigKeys,
  mergeConfigBindingBundles,
  type ConfigBindingBundle,
} from '@/relation/configBinder';
import { normalizeOptionalUuid } from '@/extraction/shared';

export type IntentProofType = 'http_call' | 'http_gateway_route' | 'db_access' | 'message_publish' | 'message_consume';
export type ProofLifecycleStatus = 'NEW' | 'RESOLVING' | 'CLOSED_ATOMIC' | 'FRONTIER' | 'REJECTED';
export type FrontierRetryStrategy = 'deterministic' | 'agent_patch' | 'manual_review';
export type ProofPatchType =
  | 'alias_binding'
  | 'function_summary_patch'
  | 'route_transform_patch'
  | 'endpoint_disambiguation'
  | 'method_path_hint'
  | 'provider_service_selection'
  | 'contradiction_challenge';
export type ProofPatchSourceKind = 'deterministic' | 'agent' | 'smart_agent' | 'manual';
export type ProofPatchValidationStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

type JsonRecord = Record<string, unknown>;

interface ProofResolutionResult {
  proofStateId: string;
  status: ProofLifecycleStatus;
  frontierReason: string | null;
  targetObjectId: string | null;
  relationType: string | null;
}

interface ValidateAndApplyProofPatchInput {
  workspaceId: string;
  proofStateId: string;
  patchType: ProofPatchType;
  payload: Record<string, unknown>;
  sourceKind: ProofPatchSourceKind;
  runId?: string | null;
  applyMode?: 'apply' | 'defer';
}

interface HttpResolutionSlots {
  methodResolved: string | null;
  externalPathResolved: string | null;
  internalPathResolved: string | null;
  providerServiceId: string | null;
  resolvedHost: string | null;
  portHints: string[];
  routeChain: string[];
  routeFamilyCompositionPaths: string[];
  hostHints: string[];
  configKeys: string[];
  contradictionReasons: string[];
  dynamicPath: boolean;
  dynamicHost: boolean;
  unsupportedPattern: boolean;
  truncated: boolean;
}

const DERIVED_BINDING_FILE_PATH = 'derived://config-binding';
const DERIVED_MESSAGE_BINDING_FILE_PATH = 'derived://message-binding';

function buildConfigBindingContext(input: {
  configKeys: string[];
  aliasHints: string[];
}): ConfigBindingBundle {
  const expandedAliasHints = uniqueSortedStrings(input.aliasHints)
    .flatMap((hint) => expandLookupCandidates(hint))
    .filter((hint) => hint.length > 0);
  const aliasEntries = uniqueSortedStrings(expandedAliasHints).map((hint) => ({
    key: hint,
    value: hint,
    sourceType: 'other' as const,
    filePath: DERIVED_BINDING_FILE_PATH,
  }));
  return mergeConfigBindingBundles(
    describeConfigKeys(input.configKeys),
    describeConfigEntries(aliasEntries),
  );
}

interface EndpointCandidateSetDetail {
  objectIds: string[];
  count: number;
  matchBasis: 'route_exact' | 'route_prefix' | 'path_shape' | 'method_exact';
}

interface AcceptedProofPatchContext {
  endpointDisambiguationId: string | null;
  methodHintOverride: string | null;
  externalPathOverride: string | null;
}

interface AcceptedPatchHints {
  endpointHintId: string | null;
  methodHintOverride: string | null;
  externalPathOverride: string | null;
  providerServiceOverride: string | null;
  contradictionChallengeReasons: string[];
}

interface ProofDependencySnapshot {
  serviceIds: string[];
  objectIds: string[];
  aliasBindingIds: string[];
  routeTransformIds: string[];
  summaryIds: string[];
}

interface ProofConfidenceBreakdown {
  confidenceProfileName: string;
  confidenceProfileVersion: string;
  summaryQuality: number;
  slotCompleteness: number;
  corroboration: number;
  matchSpecificity: number;
  contradictionPenalty: number;
  statusCap: number;
  finalConfidence: number;
}

interface EndpointIndexRecord {
  endpoint: typeof objects.$inferSelect;
  match: { method: string | null; path: string | null };
}

interface DatabaseIndexRecord {
  database: typeof objects.$inferSelect;
  tokens: Set<string>;
}

interface ChannelIndexRecord {
  channel: typeof objects.$inferSelect;
  tokens: Set<string>;
}

interface ProofConfidenceWeights {
  summaryQuality: number;
  slotCompleteness: number;
  corroborationPerSignal: number;
  corroborationCap: number;
  contradictionPenaltyPerItem: number;
  contradictionPenaltyCap: number;
}

interface HttpProofSlotWeights {
  method: number;
  externalPath: number;
  internalPath: number;
  providerService: number;
  targetObject: number;
}

interface DbProofSlotWeights {
  action: number;
  table: number;
  schema: number;
  datasource: number;
  targetObject: number;
}

interface MessageProofSlotWeights {
  channel: number;
  broker: number;
  objectType: number;
  targetObject: number;
}

interface ProofConfidenceProfileConfig {
  name: string;
  version: string;
  weights: ProofConfidenceWeights;
  slotWeights: {
    http: HttpProofSlotWeights;
    db: DbProofSlotWeights;
    message: MessageProofSlotWeights;
  };
}

export interface IntentProofWorkspaceIndex {
  workspaceId: string;
  proofConfidenceProfile: ProofConfidenceProfileConfig;
  globalRouteTransforms: Array<typeof routeTransforms.$inferSelect>;
  routeTransformsByOwnerServiceId: Map<string, Array<typeof routeTransforms.$inferSelect>>;
  providerEndpointsByServiceId: Map<string, Array<typeof objects.$inferSelect>>;
  endpointRecordsByServiceId: Map<string, EndpointIndexRecord[]>;
  databaseObjects: Array<typeof objects.$inferSelect>;
  dbTableObjects: Array<typeof objects.$inferSelect>;
  databaseIndexRecords: DatabaseIndexRecord[];
  channelObjectsByType: Map<'topic' | 'queue', Array<typeof objects.$inferSelect>>;
  channelIndexRecordsByType: Map<'topic' | 'queue', ChannelIndexRecord[]>;
}

export type IntentProofResolverContext = IntentProofWorkspaceIndex;

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ANY']);
const FUNCTION_SUMMARY_SOURCE_HASH_VERSION = 'function-summary-v3';
const HTTP_STEP_TYPES = [
  'anchorIntent',
  'hydrateFromFunctionSummary',
  'resolveHostAlias',
  'normalizeMethodAndPath',
  'applyRouteTransforms',
  'matchAtomicTarget',
  'validateContradictionsAndAmbiguity',
  'projectCandidate',
] as const;

const DEFAULT_PROOF_CONFIDENCE_PROFILE: ProofConfidenceProfileConfig = {
  name: 'intent-proof-default',
  version: 'v1',
  weights: {
    summaryQuality: 0.45,
    slotCompleteness: 0.25,
    corroborationPerSignal: 0.05,
    corroborationCap: 0.2,
    contradictionPenaltyPerItem: 0.2,
    contradictionPenaltyCap: 0.6,
  },
  slotWeights: {
    http: {
      method: 0.2,
      externalPath: 0.2,
      internalPath: 0.2,
      providerService: 0.2,
      targetObject: 0.2,
    },
    db: {
      action: 0.25,
      table: 0.25,
      schema: 0.15,
      datasource: 0.1,
      targetObject: 0.25,
    },
    message: {
      channel: 0.4,
      broker: 0.2,
      objectType: 0.15,
      targetObject: 0.25,
    },
  },
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniqueSortedStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWeight(value: unknown, fallback: number): number {
  const numeric = asNumber(value);
  return numeric === null ? fallback : clampConfidenceScore(numeric);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null))].sort();
}

function clampConfidenceScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  const direct = asRecord(value);
  if (direct) return direct;
  const encoded = asString(value);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeProofConfidenceProfile(value: unknown): ProofConfidenceProfileConfig {
  const record = parseJsonRecord(value) ?? {};
  const weights = parseJsonRecord(record['weights']) ?? {};
  const slotWeights = parseJsonRecord(record['slotWeights']) ?? {};
  const http = parseJsonRecord(slotWeights['http']) ?? {};
  const db = parseJsonRecord(slotWeights['db']) ?? {};
  const message = parseJsonRecord(slotWeights['message']) ?? {};

  return {
    name: asString(record['name']) ?? DEFAULT_PROOF_CONFIDENCE_PROFILE.name,
    version: asString(record['version']) ?? DEFAULT_PROOF_CONFIDENCE_PROFILE.version,
    weights: {
      summaryQuality: normalizeWeight(
        weights['summaryQuality'],
        DEFAULT_PROOF_CONFIDENCE_PROFILE.weights.summaryQuality,
      ),
      slotCompleteness: normalizeWeight(
        weights['slotCompleteness'],
        DEFAULT_PROOF_CONFIDENCE_PROFILE.weights.slotCompleteness,
      ),
      corroborationPerSignal: normalizeWeight(
        weights['corroborationPerSignal'],
        DEFAULT_PROOF_CONFIDENCE_PROFILE.weights.corroborationPerSignal,
      ),
      corroborationCap: normalizeWeight(
        weights['corroborationCap'],
        DEFAULT_PROOF_CONFIDENCE_PROFILE.weights.corroborationCap,
      ),
      contradictionPenaltyPerItem: normalizeWeight(
        weights['contradictionPenaltyPerItem'],
        DEFAULT_PROOF_CONFIDENCE_PROFILE.weights.contradictionPenaltyPerItem,
      ),
      contradictionPenaltyCap: normalizeWeight(
        weights['contradictionPenaltyCap'],
        DEFAULT_PROOF_CONFIDENCE_PROFILE.weights.contradictionPenaltyCap,
      ),
    },
    slotWeights: {
      http: {
        method: normalizeWeight(http['method'], DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.http.method),
        externalPath: normalizeWeight(
          http['externalPath'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.http.externalPath,
        ),
        internalPath: normalizeWeight(
          http['internalPath'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.http.internalPath,
        ),
        providerService: normalizeWeight(
          http['providerService'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.http.providerService,
        ),
        targetObject: normalizeWeight(
          http['targetObject'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.http.targetObject,
        ),
      },
      db: {
        action: normalizeWeight(db['action'], DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.db.action),
        table: normalizeWeight(db['table'], DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.db.table),
        schema: normalizeWeight(db['schema'], DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.db.schema),
        datasource: normalizeWeight(
          db['datasource'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.db.datasource,
        ),
        targetObject: normalizeWeight(
          db['targetObject'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.db.targetObject,
        ),
      },
      message: {
        channel: normalizeWeight(
          message['channel'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.message.channel,
        ),
        broker: normalizeWeight(
          message['broker'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.message.broker,
        ),
        objectType: normalizeWeight(
          message['objectType'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.message.objectType,
        ),
        targetObject: normalizeWeight(
          message['targetObject'],
          DEFAULT_PROOF_CONFIDENCE_PROFILE.slotWeights.message.targetObject,
        ),
      },
    },
  };
}

function buildZeroConfidenceBreakdown(): ProofConfidenceBreakdown {
  return {
    confidenceProfileName: DEFAULT_PROOF_CONFIDENCE_PROFILE.name,
    confidenceProfileVersion: DEFAULT_PROOF_CONFIDENCE_PROFILE.version,
    summaryQuality: 0,
    slotCompleteness: 0,
    corroboration: 0,
    matchSpecificity: 0,
    contradictionPenalty: 0,
    statusCap: 0,
    finalConfidence: 0,
  };
}

function buildProofConfidenceBreakdown(input: {
  profile: ProofConfidenceProfileConfig;
  summaryQuality: number;
  slotCompleteness: number;
  corroborationSignals: number;
  matchSpecificity: number;
  contradictionCount?: number;
  extraPenalty?: number;
  status: 'CLOSED_ATOMIC' | 'FRONTIER' | 'REJECTED';
}): ProofConfidenceBreakdown {
  const summaryQuality = clampConfidenceScore(input.summaryQuality);
  const slotCompleteness = clampConfidenceScore(input.slotCompleteness);
  const corroboration = clampConfidenceScore(
    Math.min(
      input.profile.weights.corroborationCap,
      input.corroborationSignals * input.profile.weights.corroborationPerSignal,
    ),
  );
  const matchSpecificity = clampConfidenceScore(input.matchSpecificity);
  const contradictionPenalty = clampConfidenceScore(
    Math.min(
      input.profile.weights.contradictionPenaltyCap,
      (input.contradictionCount ?? 0) * input.profile.weights.contradictionPenaltyPerItem
        + (input.extraPenalty ?? 0),
    ),
  );
  const statusCap = input.status === 'CLOSED_ATOMIC' ? 1 : 0;
  const finalConfidence = clampConfidenceScore(
    (
      summaryQuality * input.profile.weights.summaryQuality
      + slotCompleteness * input.profile.weights.slotCompleteness
      + corroboration
      + matchSpecificity
      - contradictionPenalty
    ) * statusCap,
  );

  return {
    confidenceProfileName: input.profile.name,
    confidenceProfileVersion: input.profile.version,
    summaryQuality,
    slotCompleteness,
    corroboration,
    matchSpecificity,
    contradictionPenalty,
    statusCap,
    finalConfidence,
  };
}

function computeHttpSlotCompleteness(input: {
  slotWeights: HttpProofSlotWeights;
  methodResolved: string | null;
  externalPathResolved: string | null;
  internalPathResolved: string | null;
  providerServiceId: string | null;
  targetObjectId: string | null;
}): number {
  return clampConfidenceScore(
    (input.methodResolved ? input.slotWeights.method : 0)
    + (input.externalPathResolved ? input.slotWeights.externalPath : 0)
    + (input.internalPathResolved ? input.slotWeights.internalPath : 0)
    + (input.providerServiceId ? input.slotWeights.providerService : 0)
    + (input.targetObjectId ? input.slotWeights.targetObject : 0),
  );
}

function computeDbSlotCompleteness(input: {
  slotWeights: DbProofSlotWeights;
  actionHint: string | null;
  tableHint: string | null;
  schemaHint: string | null;
  datasourceResolved: boolean;
  targetObjectId: string | null;
}): number {
  return clampConfidenceScore(
    (input.actionHint ? input.slotWeights.action : 0)
    + (input.tableHint ? input.slotWeights.table : 0)
    + (input.schemaHint ? input.slotWeights.schema : 0)
    + (input.datasourceResolved ? input.slotWeights.datasource : 0)
    + (input.targetObjectId ? input.slotWeights.targetObject : 0),
  );
}

function computeMessageSlotCompleteness(input: {
  slotWeights: MessageProofSlotWeights;
  channelHint: string | null;
  brokerResolved: boolean;
  objectType: 'topic' | 'queue';
  targetObjectId: string | null;
}): number {
  return clampConfidenceScore(
    (input.channelHint ? input.slotWeights.channel : 0)
    + (input.brokerResolved ? input.slotWeights.broker : 0)
    + (input.objectType ? input.slotWeights.objectType : 0)
    + (input.targetObjectId ? input.slotWeights.targetObject : 0),
  );
}

function normalizeIntentTypeToken(value: string): string {
  return value.trim().toLowerCase();
}

function isGatewayRouteIntentType(value: string): boolean {
  const normalized = normalizeIntentTypeToken(value);
  return normalized === 'http_gateway_route' || normalized === 'http_gateway_route_intent';
}

function buildRouteFamilyDetail(input: {
  providerServiceId: string | null;
  internalPathResolved: string | null;
  routeChain: string[];
  candidateObjectIds: string[];
  compositionPaths?: string[];
  candidateEndpointPaths?: string[];
  filteredOutReasons?: string[];
  matchBasis: EndpointCandidateSetDetail['matchBasis'];
  routeFamilyState: 'seed_only' | 'derived_children' | 'frontier';
  endpointHintId?: string | null;
}): Record<string, unknown> {
  return {
    providerServiceId: input.providerServiceId,
    internalPathResolved: input.internalPathResolved,
    routeChain: input.routeChain,
    endpointCandidateSet: {
      objectIds: input.candidateObjectIds,
      count: input.candidateObjectIds.length,
      matchBasis: input.matchBasis,
    },
    compositionPaths: [...new Set((input.compositionPaths ?? []).filter((entry) => entry.length > 0))].sort(),
    candidateEndpointPaths: [...new Set((input.candidateEndpointPaths ?? []).filter((entry) => entry.length > 0))].sort(),
    filteredOutReasons: [...new Set((input.filteredOutReasons ?? []).filter((entry) => entry.length > 0))].sort(),
    routeFamilyState: input.routeFamilyState,
    endpointHintId: input.endpointHintId ?? null,
  };
}

interface ProofDependencySeed {
  dependencyKind: string;
  dependencyKey: string;
  dependencyHash: string | null;
}

export function buildProofDependencySeeds(input: {
  intent: typeof interactionIntents.$inferSelect;
  summary: typeof functionSummaries.$inferSelect | null;
  state: typeof proofStates.$inferSelect | null;
}): ProofDependencySeed[] {
  const seeds: ProofDependencySeed[] = [];
  const stateSlot = asRecord(input.state?.slotState);
  const summaryFlags = asRecord(input.summary?.flags);
  const summaryHttp = asRecord(input.summary?.outboundHttp);
  const addSeed = (dependencyKind: string, dependencyKey: string | null | undefined, dependencyHash?: string | null) => {
    const normalizedKey = asString(dependencyKey);
    if (!normalizedKey) return;
    seeds.push({
      dependencyKind,
      dependencyKey: normalizedKey,
      dependencyHash: dependencyHash ?? null,
    });
  };

  const addNormalizedStringSeeds = (
    dependencyKind: string,
    values: Array<string | null | undefined>,
    normalize: (value: string) => string = (value) => value,
  ) => {
    for (const value of uniqueSortedStrings(values.filter((entry): entry is string => typeof entry === 'string').map(normalize))) {
      addSeed(dependencyKind, value, value);
    }
  };

  for (const configKey of asStringArray(input.intent.configKeys)) {
    addSeed('alias_binding', configKey, configKey);
  }
  addSeed('alias_binding', input.intent.hostHint, input.intent.hostHint);
  addNormalizedStringSeeds(
    'http_path_hint',
    [
      input.intent.externalPathHint,
      asString(summaryHttp?.['pathHint']),
      asString(summaryHttp?.['externalPath']),
      asString(summaryHttp?.['path']),
      asString(summaryHttp?.['url']),
      asString(input.state?.externalPathResolved),
      asString(stateSlot?.['externalPathResolved']),
      asString(stateSlot?.['pathHint']),
    ],
    normalizePath,
  );
  if (
    asBoolean(summaryFlags?.['dynamicPath'])
    || asBoolean(summaryHttp?.['dynamicPath'])
    || asBoolean(stateSlot?.['dynamicPath'])
  ) {
    addSeed('http_dynamic_path', 'dynamicPath', 'dynamicPath');
  }
  if (
    asBoolean(summaryFlags?.['dynamicHost'])
    || asBoolean(summaryHttp?.['dynamicHost'])
    || asBoolean(stateSlot?.['dynamicHost'])
  ) {
    addSeed('http_dynamic_host', 'dynamicHost', 'dynamicHost');
  }
  addSeed('function_summary_function', input.intent.sourceFunctionId, input.summary?.sourceHash ?? null);
  addSeed(
    'route_transform_owner_service',
    input.intent.sourceServiceId,
    input.state?.routeChain ? JSON.stringify(input.state.routeChain) : null,
  );
  addSeed(
    'route_transform_owner_service',
    input.state?.providerServiceId,
    input.state?.routeChain ? JSON.stringify(input.state.routeChain) : null,
  );

  return seeds.reduce<ProofDependencySeed[]>((acc, seed) => {
    if (acc.some((entry) => entry.dependencyKind === seed.dependencyKind && entry.dependencyKey === seed.dependencyKey)) {
      return acc;
    }
    acc.push(seed);
    return acc;
  }, []);
}

async function replaceProofDependencies(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateId: string;
    intent: typeof interactionIntents.$inferSelect;
    summary: typeof functionSummaries.$inferSelect | null;
  },
) {
  const stateRows = await db
    .select()
    .from(proofStates)
    .where(eq(proofStates.id, input.proofStateId))
    .limit(1);
  const state = stateRows[0] ?? null;
  const seeds = buildProofDependencySeeds({
    intent: input.intent,
    summary: input.summary,
    state,
  });

  await db.delete(proofDependencies).where(eq(proofDependencies.proofStateId, input.proofStateId));
  if (seeds.length === 0) return;

  await db.insert(proofDependencies).values(
    seeds.map((seed) => ({
      id: generateId(),
      workspaceId: input.workspaceId,
      proofStateId: input.proofStateId,
      dependencyKind: seed.dependencyKind,
      dependencyKey: seed.dependencyKey,
      dependencyHash: seed.dependencyHash,
    })),
  );
}

async function loadAcceptedProofPatchContext(
  db: DbClient,
  workspaceId: string,
  proofStateId: string,
): Promise<AcceptedProofPatchContext> {
  const rows = await db
    .select()
    .from(proofPatches)
    .where(
      and(
        eq(proofPatches.workspaceId, workspaceId),
        eq(proofPatches.proofStateId, proofStateId),
        eq(proofPatches.validationStatus, 'ACCEPTED'),
      ),
    );

  let endpointDisambiguationId: string | null = null;
  let methodHintOverride: string | null = null;
  let externalPathOverride: string | null = null;

  for (const patch of rows) {
    const payload = asRecord(patch.payload);
    if (!payload) continue;
    if (patch.patchType === 'endpoint_disambiguation') {
      endpointDisambiguationId = asString(payload['endpointId']) ?? asString(payload['targetObjectId']) ?? endpointDisambiguationId;
      continue;
    }
    if (patch.patchType === 'method_path_hint') {
      methodHintOverride = normalizeMethod(payload['method']) ?? methodHintOverride;
      externalPathOverride = asString(payload['externalPath']) ?? externalPathOverride;
    }
  }

  return {
    endpointDisambiguationId,
    methodHintOverride,
    externalPathOverride,
  };
}

function normalizeIntentType(value: string): IntentProofType {
  const normalized = normalizeIntentTypeToken(value);
  if (normalized === 'http_call' || normalized === 'http_call_intent') return 'http_call';
  if (normalized === 'http_gateway_route' || normalized === 'http_gateway_route_intent') return 'http_gateway_route';
  if (normalized === 'db_access' || normalized === 'db_access_intent') return 'db_access';
  if (normalized === 'message_publish' || normalized === 'message_publish_intent') return 'message_publish';
  if (normalized === 'message_consume' || normalized === 'message_consume_intent') return 'message_consume';
  throw new Error(`지원하지 않는 proof intent type입니다: ${value}`);
}

function inferDbRelationType(actionHint: string | null): 'read' | 'write' | null {
  if (!actionHint) return null;
  const normalized = actionHint.trim().toUpperCase();
  if (normalized === 'SELECT' || normalized === 'READ') return 'read';
  if (['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'WRITE'].includes(normalized)) return 'write';
  return null;
}

function messageObjectTypeFromSummary(summaryRecord: JsonRecord | null): 'topic' | 'queue' | null {
  const channelType = asString(summaryRecord?.['channelType'] ?? summaryRecord?.['channel_type']);
  if (channelType === 'topic' || channelType === 'queue') return channelType;
  if (asString(summaryRecord?.['queue']) !== null) return 'queue';
  if (asString(summaryRecord?.['topic']) !== null) return 'topic';
  return null;
}

function buildAliasSourceHash(payload: JsonRecord): string {
  return [
    asString(payload['bindingKind']) ?? 'property_alias',
    asString(payload['ownerServiceId']) ?? 'global',
    asString(payload['aliasKey']) ?? '',
    asString(payload['aliasValue']) ?? '',
    asString(payload['resolvedServiceId']) ?? '',
    asString(payload['resolvedHost']) ?? '',
  ].join('|');
}

function buildRouteTransformSourceHash(payload: JsonRecord): string {
  return [
    asString(payload['gatewayKind']) ?? 'custom',
    asString(payload['ownerServiceId']) ?? 'global',
    asString(payload['matchHost']) ?? '',
    asString(payload['matchPath']) ?? '',
    asString(payload['matchMode']) ?? 'exact',
    `${typeof payload['stripPrefixCount'] === 'number' ? payload['stripPrefixCount'] : ''}`,
    asString(payload['prependPrefix']) ?? '',
    asString(payload['rewriteRegex']) ?? '',
    asString(payload['rewriteReplacement']) ?? '',
    asString(payload['pathCapturePolicy']) ?? '',
    asString(payload['routeMountPrefix']) ?? '',
    asString(payload['targetServiceHint']) ?? '',
    asString(payload['targetHostAlias']) ?? '',
    asString(payload['targetPathBaseHint']) ?? '',
    `${typeof payload['priority'] === 'number' ? payload['priority'] : 0}`,
  ].join('|');
}

async function loadProofPatchValidationContext(
  db: DbClient,
  workspaceId: string,
  proofStateId: string,
): Promise<{
  proofState: typeof proofStates.$inferSelect | null;
  frontier: typeof proofFrontiers.$inferSelect | null;
  intent: typeof interactionIntents.$inferSelect | null;
}> {
  const stateRows = await db
    .select()
    .from(proofStates)
    .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.id, proofStateId)))
    .limit(1);
  const proofState = stateRows[0] ?? null;
  if (!proofState) {
    return { proofState: null, frontier: null, intent: null };
  }

  const [frontierRows, intentRows] = await Promise.all([
    db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)))
      .limit(1),
    db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.id, proofState.intentId)))
      .limit(1),
  ]);

  return {
    proofState,
    frontier: frontierRows[0] ?? null,
    intent: intentRows[0] ?? null,
  };
}

function buildFunctionSummarySourceHash(payload: JsonRecord): string {
  return [
    FUNCTION_SUMMARY_SOURCE_HASH_VERSION,
    asString(payload['functionId']) ?? '',
    JSON.stringify(payload['outboundHttp'] ?? null),
    JSON.stringify(payload['outboundDb'] ?? null),
    JSON.stringify(payload['outboundMessage'] ?? null),
    JSON.stringify(payload['signalSources'] ?? []),
    JSON.stringify(payload['provenanceEvidenceIds'] ?? payload['evidenceIds'] ?? []),
    asString(payload['extractionStrategy']) ?? 'legacy_edges_fallback',
    JSON.stringify(payload['unresolvedReasons'] ?? []),
    `${Math.max(0, Math.min(1, asNumber(payload['summaryCompleteness']) ?? 0.6))}`,
  ].join('|');
}

function normalizeLookupToken(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function normalizeServiceName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]/g, '');
}

function expandLookupCandidates(value: string): string[] {
  const normalized = normalizeLookupToken(value);
  if (normalized.length === 0) return [];
  const suffixRemoved = normalized.replace(/(?:-?base)?-?url$|(?:-?base)?-?host$|-?service$|-?client$/g, '');
  const compact = normalized.replace(/[-_.]/g, '');
  const segments = normalized.split(/[./-]+/).filter((segment) => segment.length > 0);
  const expanded = [
    normalized,
    compact,
    suffixRemoved,
    suffixRemoved.replace(/[-_.]/g, ''),
    ...segments,
  ];
  return uniqueSortedStrings(expanded);
}

function normalizeMethod(value: unknown): string | null {
  const method = asString(value)?.toUpperCase() ?? null;
  return method && HTTP_METHODS.has(method) ? method : null;
}

function extractComparablePath(path: string): string {
  let pathOnly = path.trim();
  if (pathOnly.length === 0) {
    return '';
  }

  try {
    if (/^https?:\/\//i.test(pathOnly)) {
      const url = new URL(pathOnly);
      pathOnly = url.pathname;
    } else {
      pathOnly = pathOnly.split('?')[0] ?? pathOnly;
      pathOnly = pathOnly.split('#')[0] ?? pathOnly;
    }
  } catch {
    pathOnly = pathOnly.split('?')[0] ?? pathOnly;
    pathOnly = pathOnly.split('#')[0] ?? pathOnly;
  }

  if (!pathOnly.startsWith('/')) {
    pathOnly = `/${pathOnly}`;
  }
  pathOnly = pathOnly.replace(/\/+/g, '/');
  if (pathOnly.length > 1) {
    pathOnly = pathOnly.replace(/\/+$/g, '');
  }
  return pathOnly.toLowerCase();
}

function collectProviderPathHints(input: {
  intent: typeof interactionIntents.$inferSelect;
  summaryHttp: JsonRecord | null;
  acceptedPatchHints: AcceptedPatchHints;
}): string[] {
  return uniqueSortedStrings([
    asString(input.acceptedPatchHints.externalPathOverride),
    asString(input.intent.externalPathHint),
    asString(input.summaryHttp?.['pathHint']),
    asString(input.summaryHttp?.['externalPath']),
    asString(input.summaryHttp?.['path']),
    asString(input.summaryHttp?.['url']),
  ])
    .map((value) => normalizePath(value))
    .filter((value) => value.length > 0);
}

function normalizePathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const trimmed = decoded.trim();
  if (trimmed.length === 0) return '';
  if (/^\{[^/]+\}$/.test(trimmed)) return '{*}';
  if (/^\$\{[^/]+\}$/.test(trimmed)) return '{*}';
  if (/^:[^/]+$/.test(trimmed)) return '{*}';
  return trimmed.toLowerCase();
}

function splitNormalizedPathSegments(path: string): string[] {
  const comparablePath = extractComparablePath(path);
  if (comparablePath.length === 0 || comparablePath === '/') {
    return comparablePath === '/' ? [] : [];
  }
  return comparablePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => normalizePathSegment(segment))
    .filter((segment) => segment.length > 0);
}

function isLikelyDynamicPathSegment(segment: string): boolean {
  if (segment === '{*}') return true;
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{24}$/i.test(segment)) return true;
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  return /\d/.test(segment) && /[a-z]/i.test(segment);
}

function isEndpointPathCompatible(callPath: string, endpointPath: string): boolean {
  return computeEndpointPathCompatibilityScore(callPath, endpointPath) >= 0.75;
}

function computeEndpointPathCompatibilityScore(callPath: string, endpointPath: string): number {
  const callSegments = splitNormalizedPathSegments(callPath);
  const endpointSegments = splitNormalizedPathSegments(endpointPath);
  if (callSegments.length === 0 && endpointSegments.length === 0) {
    return extractComparablePath(callPath) === extractComparablePath(endpointPath) ? 1 : 0;
  }
  if (endpointSegments.at(-1) === '{*}') {
    const prefix = endpointSegments.slice(0, -1);
    const prefixMatches = prefix.every((segment, index) => callSegments[index] === segment || segment === '{*}');
    return prefixMatches ? 0.55 : 0;
  }
  if (callSegments.length !== endpointSegments.length) {
    const delta = Math.abs(callSegments.length - endpointSegments.length);
    if (delta > 1) return 0;
  }

  const comparableLength = Math.min(callSegments.length, endpointSegments.length);
  let total = 0;
  for (let i = 0; i < endpointSegments.length; i += 1) {
    const callSegment = callSegments[i];
    const endpointSegment = endpointSegments[i];
    if (!endpointSegment) continue;
    if (!callSegment) {
      total -= 0.4;
      continue;
    }

    if (endpointSegment === '{*}') {
      if (callSegment === '{*}' || isLikelyDynamicPathSegment(callSegment)) {
        total += 0.9;
      } else {
        total += 0.5;
      }
      continue;
    }
    if (callSegment === '{*}') {
      total += 0.7;
      continue;
    }
    if (callSegment !== endpointSegment) {
      total -= 0.4;
      continue;
    }
    total += 1;
  }

  const lengthPenalty = Math.abs(callSegments.length - endpointSegments.length) * 0.2;
  return Math.max(0, (total / Math.max(1, comparableLength)) - lengthPenalty);
}

function isMethodCompatible(resolvedMethod: string, endpointMethod: string | null): boolean {
  if (!endpointMethod) return false;
  if (endpointMethod === resolvedMethod) return true;
  if (endpointMethod === 'ANY') return true;
  return false;
}

function normalizeRouteScopeKind(value: string | null): 'exact' | 'prefix' | 'regex' | null {
  return value === 'exact' || value === 'prefix' || value === 'regex' ? value : null;
}

function stripNormalizedPathPrefix(path: string, prefix: string): string | null {
  const pathSegments = splitNormalizedPathSegments(path);
  const prefixSegments = splitNormalizedPathSegments(prefix);
  if (prefixSegments.length === 0) {
    return normalizePath(path);
  }
  if (pathSegments.length < prefixSegments.length) {
    return null;
  }
  for (let i = 0; i < prefixSegments.length; i += 1) {
    if (pathSegments[i] !== prefixSegments[i]) {
      return null;
    }
  }
  return joinPathSegments(pathSegments.slice(prefixSegments.length));
}

function collectRouteFamilyCompositionPaths(input: {
  externalPathResolved: string;
  externalRoutePattern: string | null;
  internalPathResolved: string;
  transforms: Array<typeof routeTransforms.$inferSelect>;
}): string[] {
  const candidates = new Set<string>();
  const addCandidate = (value: string | null) => {
    if (!value) return;
    const normalized = normalizePath(value);
    candidates.add(normalized.length > 0 ? normalized : '/');
  };

  const addProviderRelative = (value: string | null, base: string | null) => {
    if (!value || !base) return;
    const stripped = stripNormalizedPathPrefix(value, base);
    addCandidate(stripped);
  };

  addCandidate(input.internalPathResolved);
  addCandidate(input.externalPathResolved);
  const externalRouteBase = input.externalRoutePattern
    ? trimWildcardPath(input.externalRoutePattern)
    : null;
  addCandidate(externalRouteBase);

  for (const transform of input.transforms) {
    const matchBase = trimWildcardPath(transform.matchPath);
    const prefixedMatchBase = transform.prependPrefix
      ? joinPathSegments([
          ...splitNormalizedPathSegments(transform.prependPrefix),
          ...splitNormalizedPathSegments(matchBase),
        ])
      : matchBase;
    const fromExternal = normalizePath(input.externalPathResolved);
    const withoutPrefix = transform.prependPrefix
      ? (stripNormalizedPathPrefix(fromExternal, transform.prependPrefix) ?? fromExternal)
      : fromExternal;
    addCandidate(matchBase);
    addCandidate(prefixedMatchBase);
    addCandidate(withoutPrefix);
    if (transform.prependPrefix) {
      addCandidate(stripNormalizedPathPrefix(input.internalPathResolved, transform.prependPrefix));
      addCandidate(stripNormalizedPathPrefix(prefixedMatchBase, transform.prependPrefix));
    }

    addProviderRelative(fromExternal, matchBase);
    addProviderRelative(withoutPrefix, matchBase);
    addProviderRelative(input.internalPathResolved, prefixedMatchBase);
    addProviderRelative(externalRouteBase, matchBase);
    addProviderRelative(prefixedMatchBase, prefixedMatchBase);
    addProviderRelative(matchBase, matchBase);

    if (withoutPrefix && typeof transform.stripPrefixCount === 'number' && transform.stripPrefixCount > 0) {
      addCandidate(joinPathSegments(
        splitNormalizedPathSegments(withoutPrefix).slice(transform.stripPrefixCount),
      ));
    }
  }

  return [...candidates].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function isRouteFamilyEndpointReachable(
  routeScopeKind: 'exact' | 'prefix' | 'regex' | null,
  internalPathResolved: string | string[],
  endpointPath: string,
): boolean {
  const candidatePaths = Array.isArray(internalPathResolved)
    ? internalPathResolved
    : [internalPathResolved];
  const endpointSegments = splitNormalizedPathSegments(endpointPath);

  return candidatePaths.some((candidatePath) => {
    const routeSegments = splitNormalizedPathSegments(candidatePath);

    if ((routeScopeKind ?? 'exact') === 'exact') {
      return normalizePath(endpointPath) === normalizePath(candidatePath);
    }

    if (routeSegments.length === 0) {
      return true;
    }

    if (endpointSegments.length < routeSegments.length) {
      return false;
    }

    for (let i = 0; i < routeSegments.length; i += 1) {
      if (routeSegments[i] !== endpointSegments[i]) {
        return isEndpointPathCompatible(candidatePath, endpointPath);
      }
    }

    return true;
  });
}

function normalizePath(path: string): string {
  const segments = splitNormalizedPathSegments(path);
  if (segments.length === 0) {
    const comparablePath = extractComparablePath(path);
    return comparablePath === '/' ? '/' : '';
  }
  return `/${segments.join('/')}`;
}

function extractHostFromValue(value: string | null): string | null {
  if (!value) return null;
  try {
    if (/^https?:\/\//i.test(value)) {
      return new URL(value).hostname.toLowerCase();
    }
  } catch {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (/^[a-z0-9.-]+(?::\d+)?(\/.*)?$/i.test(trimmed) && !trimmed.startsWith('/')) {
    return trimmed.split('/')[0]?.split(':')[0] ?? null;
  }
  return null;
}

function collectDatabaseTokens(database: typeof objects.$inferSelect): Set<string> {
  const metadata = asRecord(database.metadata);
  const tokens = new Set<string>();
  const pushToken = (value: unknown) => {
    const token = normalizeLookupToken(asString(value) ?? '');
    if (token.length > 0) tokens.add(token);
  };

  pushToken(database.id);
  pushToken(database.name);
  pushToken(database.displayName);
  pushToken(metadata?.['host']);
  pushToken(metadata?.['hostname']);
  pushToken(metadata?.['url']);
  pushToken(metadata?.['jdbcUrl']);
  pushToken(metadata?.['datasource']);
  pushToken(metadata?.['datasourceAlias']);
  pushToken(metadata?.['serviceId']);
  pushToken(metadata?.['ownerServiceId']);

  return tokens;
}

function collectChannelTokens(channel: typeof objects.$inferSelect): Set<string> {
  const metadata = asRecord(channel.metadata);
  const tokens = new Set<string>();
  const pushToken = (value: unknown) => {
    const token = normalizeLookupToken(asString(value) ?? '');
    if (token.length > 0) tokens.add(token);
  };

  pushToken(channel.id);
  pushToken(channel.name);
  pushToken(channel.displayName);
  pushToken(channel.parentId);
  pushToken(metadata?.['broker']);
  pushToken(metadata?.['brokerAlias']);
  pushToken(metadata?.['bootstrapServers']);
  pushToken(metadata?.['host']);
  pushToken(metadata?.['hostname']);
  pushToken(metadata?.['cluster']);
  pushToken(metadata?.['serviceId']);
  pushToken(metadata?.['ownerServiceId']);

  return tokens;
}

function findMatchingAliasBindings(
  bindings: Array<typeof aliasBindings.$inferSelect>,
  hints: string[],
): Array<typeof aliasBindings.$inferSelect> {
  const lookupKeys = new Set(
    hints
      .flatMap((entry) => expandLookupCandidates(entry))
      .filter((entry) => entry.length > 0),
  );

  if (lookupKeys.size === 0) {
    return [];
  }

  return bindings.filter((binding) => {
    const aliasKeyCandidates = expandLookupCandidates(binding.aliasKey);
    const aliasValueCandidates = expandLookupCandidates(binding.aliasValue);
    const resolvedHostCandidates = expandLookupCandidates(binding.resolvedHost ?? '');
    return (
      aliasKeyCandidates.some((candidate) => lookupKeys.has(candidate))
      || aliasValueCandidates.some((candidate) => lookupKeys.has(candidate))
      || resolvedHostCandidates.some((candidate) => lookupKeys.has(candidate))
    );
  });
}

function normalizeServiceToken(value: string | null): string | null {
  if (!value) return null;
  const host = extractHostFromValue(value);
  const source = host ?? value;
  const normalized = source.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized.length > 0 ? normalized : null;
}

function joinPathSegments(segments: string[]): string {
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function trimWildcardPath(path: string): string {
  const normalized = extractComparablePath(path);
  const wildcardIndex = normalized.indexOf('*');
  const base = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized;
  if (base.length === 0) return '/';
  return base.endsWith('/') && base.length > 1 ? base.slice(0, -1) : base;
}

function getEffectiveRouteMatchMode(
  transform: Pick<typeof routeTransforms.$inferSelect, 'matchMode' | 'matchPath'>,
): 'exact' | 'prefix' | 'regex' {
  if (transform.matchMode === 'regex') return 'regex';
  if (transform.matchMode === 'prefix') return 'prefix';
  return transform.matchPath.includes('*') ? 'prefix' : 'exact';
}

function routePathMatches(
  externalPath: string,
  transform: Pick<typeof routeTransforms.$inferSelect, 'matchPath' | 'matchMode' | 'prependPrefix'>,
): boolean {
  const normalizedExternal = normalizePath(externalPath);
  const matchMode = getEffectiveRouteMatchMode(transform);

  if (matchMode === 'regex') {
    try {
      return new RegExp(transform.matchPath).test(normalizedExternal);
    } catch {
      return false;
    }
  }

  const matchBases = new Set<string>();
  const normalizedMatch = matchMode === 'exact'
    ? normalizePath(transform.matchPath)
    : trimWildcardPath(transform.matchPath);
  matchBases.add(normalizedMatch);

  if (transform.prependPrefix) {
    matchBases.add(joinPathSegments([
      ...splitNormalizedPathSegments(transform.prependPrefix),
      ...splitNormalizedPathSegments(normalizedMatch),
    ]));
  }

  return [...matchBases].some((base) => {
    if (base === '/' || base.length === 0) return true;
    if (matchMode === 'exact') {
      return normalizedExternal === base;
    }
    return normalizedExternal === base || normalizedExternal.startsWith(`${base}/`);
  });
}

function routePathSpecificity(
  transform: Pick<typeof routeTransforms.$inferSelect, 'matchPath' | 'matchMode'>,
): number {
  const matchMode = getEffectiveRouteMatchMode(transform);
  const pathSpecificity = (matchMode === 'regex' ? extractComparablePath(transform.matchPath) : trimWildcardPath(transform.matchPath))
    .split('/')
    .filter((segment) => segment.length > 0)
    .length;
  const modeBonus = matchMode === 'exact' ? 200 : matchMode === 'regex' ? 100 : 0;
  return modeBonus + pathSpecificity;
}

function applyRouteTransformToPath(
  externalPath: string,
  transform: typeof routeTransforms.$inferSelect,
): { internalPath: string | null; error: string | null } {
  let segments = splitNormalizedPathSegments(externalPath);

  if (typeof transform.stripPrefixCount === 'number' && transform.stripPrefixCount > 0) {
    segments = segments.slice(transform.stripPrefixCount);
  }

  const prependSegments = transform.prependPrefix
    ? splitNormalizedPathSegments(transform.prependPrefix)
    : [];
  let nextPath = joinPathSegments([...prependSegments, ...segments]);

  if (transform.rewriteRegex) {
    try {
      const regex = new RegExp(transform.rewriteRegex);
      nextPath = nextPath.replace(regex, transform.rewriteReplacement ?? '');
    } catch {
      return { internalPath: null, error: 'PATH_REWRITE_CONFLICT' };
    }
  }

  const normalized = normalizePath(nextPath);
  return {
    internalPath: normalized.length > 0 ? normalized : '/',
    error: null,
  };
}

async function appendProofStep(
  db: DbClient,
  proofStateId: string,
  stepType: string,
  status: 'APPLIED' | 'FAILED' | 'SKIPPED' | 'PENDING',
  inputSnapshot: Record<string, unknown>,
  outputSnapshot: Record<string, unknown>,
  message: string,
) {
  const existingSteps = await db
    .select({ stepOrder: proofSteps.stepOrder })
    .from(proofSteps)
    .where(eq(proofSteps.proofStateId, proofStateId));

  const nextOrder = existingSteps.reduce((max, row) => Math.max(max, row.stepOrder), 0) + 1;
  await db.insert(proofSteps).values({
    id: generateId(),
    proofStateId,
    stepOrder: nextOrder,
    stepType,
    status,
    inputSnapshot,
    outputSnapshot,
    message,
  });
}

async function appendSkippedHttpSteps(
  db: DbClient,
  proofStateId: string,
  startIndex: number,
  reason: string,
) {
  for (const stepType of HTTP_STEP_TYPES.slice(startIndex)) {
    await appendProofStep(db, proofStateId, stepType, 'SKIPPED', {}, { reason }, `이전 단계 결과로 ${stepType}를 건너뛰었습니다.`);
  }
}

async function getIntentWithProofState(db: DbClient, workspaceId: string, intentId: string) {
  const intents = await db
    .select()
    .from(interactionIntents)
    .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.id, intentId)))
    .limit(1);
  const intent = intents[0];
  if (!intent) {
    throw new Error(`interaction intent를 찾을 수 없습니다: ${intentId}`);
  }

  const states = await db
    .select()
    .from(proofStates)
    .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intentId)));

  const rootProofState = states.find((state) => state.parentProofStateId === null) ?? states[0] ?? null;
  return { intent, proofState: rootProofState };
}

async function getAcceptedPatchHints(
  db: DbClient,
  workspaceId: string,
  proofStateId: string,
): Promise<AcceptedPatchHints> {
  const patches = await db
    .select()
    .from(proofPatches)
    .where(
      and(
        eq(proofPatches.workspaceId, workspaceId),
        eq(proofPatches.proofStateId, proofStateId),
        eq(proofPatches.validationStatus, 'ACCEPTED'),
      ),
    );

  const acceptedPatches = [...patches].reverse();
  const endpointPatch = acceptedPatches.find((patch) => patch.patchType === 'endpoint_disambiguation');
  const methodPathPatch = acceptedPatches.find((patch) => patch.patchType === 'method_path_hint');
  const providerPatch = acceptedPatches.find((patch) => patch.patchType === 'provider_service_selection');
  const contradictionPatch = acceptedPatches.find((patch) => patch.patchType === 'contradiction_challenge');
  const endpointPayload = asRecord(endpointPatch?.payload);
  const methodPathPayload = asRecord(methodPathPatch?.payload);
  const providerPayload = asRecord(providerPatch?.payload);
  const contradictionPayload = asRecord(contradictionPatch?.payload);

  return {
    endpointHintId:
      asString(endpointPayload?.['endpointId'])
      ?? asString(endpointPayload?.['targetObjectId'])
      ?? null,
    methodHintOverride: normalizeMethod(methodPathPayload?.['method']),
    externalPathOverride: asString(methodPathPayload?.['externalPath']),
    providerServiceOverride: asString(providerPayload?.['selectedServiceId']),
    contradictionChallengeReasons: asStringArray(contradictionPayload?.['challengeReasons']),
  };
}

async function validatePatchDeterministically(
  db: DbClient,
  workspaceId: string,
  proofStateId: string,
  patchType: ProofPatchType,
  payload: JsonRecord,
): Promise<string[]> {
  const errors: string[] = [];
  const { proofState, frontier, intent } = await loadProofPatchValidationContext(db, workspaceId, proofStateId);
  if (!proofState) {
    errors.push('proofStateId must reference an existing proof state');
    return errors;
  }
  if (!intent) {
    errors.push('proofStateId must reference an intent-backed proof state');
    return errors;
  }

  switch (patchType) {
    case 'endpoint_disambiguation': {
      const endpointId = asString(payload['endpointId']) ?? asString(payload['targetObjectId']);
      if (!endpointId) {
        return errors;
      }
      if (!frontier || frontier.frontierReason !== 'ENDPOINT_MATCH_AMBIGUOUS') {
        errors.push('endpoint_disambiguation requires an ENDPOINT_MATCH_AMBIGUOUS frontier');
        return errors;
      }

      const endpointRows = await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, endpointId)))
        .limit(1);
      const endpoint = endpointRows[0];
      if (!endpoint) {
        errors.push('endpointId must reference an existing object');
        return errors;
      }
      if (endpoint.objectType !== 'api_endpoint') {
        errors.push('endpointId must reference an api_endpoint object');
        return errors;
      }
      if (proofState.providerServiceId && endpoint.parentId !== proofState.providerServiceId) {
        errors.push('endpointId must belong to the resolved provider service');
      }
      const frontierDetail = asRecord(frontier.detail);
      const candidateIds = [
        ...asStringArray(frontierDetail?.['candidateObjectIds']),
        ...asStringArray(asRecord(frontierDetail?.['endpointCandidateSet'])?.['objectIds']),
      ];
      if (candidateIds.length > 0 && !candidateIds.includes(endpointId)) {
        errors.push('endpointId must belong to the ambiguous frontier candidate set');
      }

      const endpointMethodPath = getEndpointMethodPath(endpoint);
      const methodHint = normalizeMethod(payload['method']);
      const pathHint = asString(payload['path']);
      if (methodHint && endpointMethodPath.method && endpointMethodPath.method !== methodHint) {
        errors.push('endpointId method does not match patch method');
      }
      if (pathHint && endpointMethodPath.path && !isEndpointPathCompatible(pathHint, endpointMethodPath.path)) {
        errors.push('endpointId path does not match patch path');
      }
      return errors;
    }
    case 'alias_binding': {
      const ownerServiceId = asString(payload['ownerServiceId']);
      const resolvedServiceId = asString(payload['resolvedServiceId']);
      const aliasKey = asString(payload['aliasKey']);
      const aliasValue = asString(payload['aliasValue']);
      if (!frontier || !['CONFIG_BINDING_MISSING', 'HOST_ALIAS_UNRESOLVED'].includes(frontier.frontierReason)) {
        errors.push('alias_binding requires a host/config alias frontier');
        return errors;
      }
      if (ownerServiceId && ownerServiceId !== proofState.consumerServiceId) {
        errors.push('ownerServiceId must match the proof consumer service');
      }
      const frontierDetail = asRecord(frontier.detail);
      const frontierKeys = new Set(
        [
          ...asStringArray(frontierDetail?.['configKeys']),
          ...asStringArray(frontierDetail?.['hostHints']),
          intent.hostHint,
        ]
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .map((entry) => normalizeLookupToken(entry))
      );
      if (aliasKey && !frontierKeys.has(normalizeLookupToken(aliasKey))) {
        errors.push('aliasKey must reference a frontier host/config hint');
      }
      if (aliasValue) {
        const normalizedAliasValue = normalizeLookupToken(aliasValue);
        const frontierValues = new Set(
          [
            ...asStringArray(frontierDetail?.['hostHints']),
            intent.hostHint,
          ]
            .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
            .map((entry) => normalizeLookupToken(entry))
        );
        if (frontierValues.size > 0 && !frontierValues.has(normalizedAliasValue)) {
          errors.push('aliasValue must align with the unresolved host alias');
        }
      }
      if (ownerServiceId) {
        const ownerRows = await db
          .select()
          .from(objects)
          .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, ownerServiceId)))
          .limit(1);
        const owner = ownerRows[0];
        if (!owner || owner.objectType !== 'service') {
          errors.push('ownerServiceId must reference a service object');
        }
      }
      if (resolvedServiceId) {
        const resolvedRows = await db
          .select()
          .from(objects)
          .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, resolvedServiceId)))
          .limit(1);
        const resolved = resolvedRows[0];
        if (!resolved || resolved.objectType !== 'service') {
          errors.push('resolvedServiceId must reference a service object');
        } else {
          const serviceTokens = new Set(getServiceTokens(resolved));
          const hintTokens = [
            intent.targetServiceHint,
            intent.providerHint,
            intent.hostHint,
            ...asStringArray(frontierDetail?.['hostHints']),
          ]
            .map((entry) => normalizeServiceToken(asString(entry)))
            .filter((entry): entry is string => entry !== null);
          if (hintTokens.length > 0 && !hintTokens.some((token) => serviceTokens.has(token))) {
            errors.push('resolvedServiceId must align with downstream service hints');
          }
        }
      }
      return errors;
    }
    case 'function_summary_patch': {
      const functionId = asString(payload['functionId']);
      if (!functionId) return errors;
      const functionRows = await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, functionId)))
        .limit(1);
      const fn = functionRows[0];
      if (!fn || fn.objectType !== 'function') {
        errors.push('functionId must reference a function object');
        return errors;
      }

      const serviceId = asString(payload['serviceId']) ?? fn.parentId ?? null;
      if (!serviceId) {
        errors.push('serviceId must be resolvable for function_summary_patch');
        return errors;
      }

      const serviceRows = await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, serviceId)))
        .limit(1);
      const service = serviceRows[0];
      if (!service || service.objectType !== 'service') {
        errors.push('serviceId must reference a service object');
      }
      return errors;
    }
    case 'route_transform_patch': {
      const ownerServiceId = asString(payload['ownerServiceId']);
      const gatewayKind = asString(payload['gatewayKind']);
      const matchPath = asString(payload['matchPath']);
      const targetServiceHint = asString(payload['targetServiceHint']);
      const targetHostAlias = asString(payload['targetHostAlias']);
      if (!frontier || !['ROUTE_FAMILY_DERIVATION_EMPTY', 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED', 'PATH_TEMPLATE_UNKNOWN'].includes(frontier.frontierReason)) {
        errors.push('route_transform_patch requires a route frontier');
        return errors;
      }
      if (normalizeIntentType(intent.intentType) !== 'http_gateway_route') {
        errors.push('route_transform_patch requires an http_gateway_route intent');
      }
      if (!targetServiceHint && !targetHostAlias) {
        errors.push('route_transform_patch must provide targetServiceHint or targetHostAlias');
      }
      if (ownerServiceId && ownerServiceId !== intent.sourceServiceId) {
        errors.push('ownerServiceId must match the route intent source service');
      }
      if (gatewayKind && asString(intent.gatewayKind) && gatewayKind !== intent.gatewayKind) {
        errors.push('gatewayKind must match the route intent gateway kind');
      }
      if (matchPath && asString(intent.externalRoutePattern) && matchPath !== intent.externalRoutePattern) {
        errors.push('matchPath must match the route intent externalRoutePattern');
      }
      const targetHintTokens = [
        intent.targetServiceHint,
        intent.providerHint,
        intent.hostHint,
      ]
        .map((entry) => normalizeServiceToken(asString(entry)))
        .filter((entry): entry is string => entry !== null);
      if (targetServiceHint && targetHintTokens.length > 0) {
        const normalizedTargetServiceHint = normalizeServiceToken(targetServiceHint);
        if (!normalizedTargetServiceHint || !targetHintTokens.includes(normalizedTargetServiceHint)) {
          errors.push('targetServiceHint must align with route frontier hints');
        }
      }
      if (targetHostAlias && intent.hostHint) {
        if (normalizeLookupToken(targetHostAlias) !== normalizeLookupToken(intent.hostHint)) {
          errors.push('targetHostAlias must align with the route intent host hint');
        }
      }
      if (ownerServiceId) {
        const ownerRows = await db
          .select()
          .from(objects)
          .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, ownerServiceId)))
          .limit(1);
        const owner = ownerRows[0];
        if (!owner || owner.objectType !== 'service') {
          errors.push('ownerServiceId must reference a service object');
        }
      }
      const rewriteRegex = asString(payload['rewriteRegex']);
      if (rewriteRegex) {
        try {
          // validate regex syntax eagerly so deterministic patches fail before apply
          // eslint-disable-next-line no-new
          new RegExp(rewriteRegex);
        } catch {
          errors.push('rewriteRegex must be a valid regular expression');
        }
      }
      return errors;
    }
    case 'method_path_hint': {
      const methodHint = normalizeMethod(payload['method']);
      const externalPathHint = asString(payload['externalPath']);
      if (!frontier || frontier.frontierReason !== 'METHOD_UNKNOWN') {
        errors.push('method_path_hint requires a METHOD_UNKNOWN frontier');
        return errors;
      }
      if (!proofState.providerServiceId) {
        errors.push('method_path_hint requires a resolved provider service');
        return errors;
      }
      if (!methodHint || !externalPathHint) {
        return errors;
      }

      const endpointRows = await db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.workspaceId, workspaceId),
            eq(objects.objectType, 'api_endpoint'),
            eq(objects.parentId, proofState.providerServiceId),
          ),
        );
      const normalizedHintPath = normalizePath(externalPathHint);
      const hasCompatibleEndpoint = endpointRows.some((endpoint) => {
        const endpointMethodPath = getEndpointMethodPath(endpoint);
        if (endpointMethodPath.method !== methodHint) {
          return false;
        }
        return Boolean(
          endpointMethodPath.path
          && normalizedHintPath
          && isEndpointPathCompatible(normalizedHintPath, endpointMethodPath.path),
        );
      });
      if (!hasCompatibleEndpoint) {
        errors.push('method_path_hint must match at least one endpoint method and path in provider service');
      }

      return errors;
    }
    case 'provider_service_selection': {
      const selectedServiceId = asString(payload['selectedServiceId']);
      if (!frontier || frontier.frontierReason !== 'PROVIDER_SERVICE_AMBIGUOUS') {
        errors.push('provider_service_selection requires a PROVIDER_SERVICE_AMBIGUOUS frontier');
        return errors;
      }
      if (!selectedServiceId) {
        errors.push('provider_service_selection requires selectedServiceId');
        return errors;
      }
      const frontierDetail = asRecord(frontier.detail);
      const candidateProviderIds = asStringArray(frontierDetail?.['candidateProviderIds']);
      if (candidateProviderIds.length > 0 && !candidateProviderIds.includes(selectedServiceId)) {
        errors.push('selectedServiceId must belong to the ambiguous provider candidate set');
      }
      return errors;
    }
    case 'contradiction_challenge': {
      if (proofState.status !== 'CLOSED_ATOMIC') {
        errors.push('contradiction_challenge requires a CLOSED_ATOMIC proof');
        return errors;
      }
      if (asString(payload['expectedAction']) !== 'reopen_frontier') {
        errors.push('contradiction_challenge must request reopen_frontier');
      }
      if (asStringArray(payload['challengeReasons']).length === 0) {
        errors.push('contradiction_challenge requires challengeReasons');
      }
      if (proofState.confidence >= 0.65) {
        errors.push('contradiction_challenge only applies to low-confidence CLOSED_ATOMIC proofs');
      }
      return errors;
    }
  }

  return errors;
}

async function getActiveSummaryForIntent(
  db: DbClient,
  workspaceId: string,
  intent: typeof interactionIntents.$inferSelect,
) {
  const summaryRefIds = asStringArray(intent.summaryRefs);
  if (summaryRefIds.length > 0) {
    const rows = await db
      .select()
      .from(functionSummaries)
      .where(
        and(
          eq(functionSummaries.workspaceId, workspaceId),
          eq(functionSummaries.status, 'ACTIVE'),
          inArray(functionSummaries.id, summaryRefIds),
        ),
      )
      .orderBy(desc(functionSummaries.summaryVersion), desc(functionSummaries.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  if (!intent.sourceFunctionId) return null;
  const rows = await db
    .select()
    .from(functionSummaries)
    .where(
      and(
        eq(functionSummaries.workspaceId, workspaceId),
        eq(functionSummaries.functionId, intent.sourceFunctionId),
        eq(functionSummaries.status, 'ACTIVE'),
      ),
    )
    .orderBy(desc(functionSummaries.summaryVersion), desc(functionSummaries.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertProofStateBase(
  db: DbClient,
  workspaceId: string,
  intent: typeof interactionIntents.$inferSelect,
  existing: typeof proofStates.$inferSelect | null,
) {
  const intentType = normalizeIntentType(intent.intentType);
  if (existing) {
    await db
      .update(proofStates)
      .set({
        proofType: intentType,
        status: 'RESOLVING',
        originIntentId: null,
        parentProofStateId: null,
        consumerServiceId: intent.sourceServiceId,
        sourceFunctionId: intent.sourceFunctionId ?? null,
        providerServiceId: null,
        targetObjectType: null,
        targetObjectId: null,
        methodResolved: null,
        externalPathResolved: null,
        internalPathResolved: null,
        routeChain: [],
        slotState: {},
        frontierCode: null,
        rejectedReason: null,
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0,
        updatedAt: new Date(),
      })
      .where(eq(proofStates.id, existing.id));
    return existing.id;
  }

  const proofStateId = generateId();
  await db.insert(proofStates).values({
    id: proofStateId,
    workspaceId,
    intentId: intent.id,
    originIntentId: null,
    parentProofStateId: null,
    proofType: intentType,
    status: 'RESOLVING',
    consumerServiceId: intent.sourceServiceId,
    sourceFunctionId: intent.sourceFunctionId ?? null,
  });
  return proofStateId;
}

async function clearProjectedCandidates(db: DbClient, workspaceId: string, proofStateId: string) {
  const candidates = await db
    .select({
      id: relationCandidates.id,
      status: relationCandidates.status,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(eq(relationCandidates.workspaceId, workspaceId));

  const staleIds = candidates
    .filter(
      (candidate) => candidate.status === 'PENDING'
        && asString(asRecord(candidate.metadata)?.['proofStateId']) === proofStateId,
    )
    .map((candidate) => candidate.id);

  for (const candidateId of staleIds) {
    await db.delete(relationCandidates).where(eq(relationCandidates.id, candidateId));
  }
}

async function clearProofExecutionArtifacts(db: DbClient, proofStateId: string, workspaceId: string) {
  await db.delete(proofSteps).where(eq(proofSteps.proofStateId, proofStateId));
  await db.delete(proofFrontiers).where(eq(proofFrontiers.proofStateId, proofStateId));
  await clearProjectedCandidates(db, workspaceId, proofStateId);
}

async function listChildProofStates(
  db: DbClient,
  workspaceId: string,
  parentProofStateId: string,
) {
  return db
    .select()
    .from(proofStates)
    .where(
      and(
        eq(proofStates.workspaceId, workspaceId),
        eq(proofStates.parentProofStateId, parentProofStateId),
      ),
    );
}

async function clearChildProofStates(
  db: DbClient,
  workspaceId: string,
  parentProofStateId: string,
) {
  const childStates = await listChildProofStates(db, workspaceId, parentProofStateId);
  for (const childState of childStates) {
    await clearProjectedCandidates(db, workspaceId, childState.id);
    await db.delete(proofStates).where(eq(proofStates.id, childState.id));
  }
}

async function createRouteFamilyChildProofState(
  db: DbClient,
  input: {
    workspaceId: string;
    intent: typeof interactionIntents.$inferSelect;
    parentProofStateId: string;
    providerServiceId: string;
    methodResolved: string | null;
    externalPathResolved: string | null;
    internalPathResolved: string;
    routeChain: string[];
    targetObjectId: string;
    endpointCandidateSet: EndpointCandidateSetDetail;
    contradictionReasons: string[];
    confidence: number;
  },
) {
  const childProofStateId = generateId();
  await db.insert(proofStates).values({
    id: childProofStateId,
    workspaceId: input.workspaceId,
    intentId: input.intent.id,
    originIntentId: input.intent.id,
    parentProofStateId: input.parentProofStateId,
    proofType: 'http_gateway_route',
    status: 'RESOLVING',
    consumerServiceId: input.intent.sourceServiceId,
    sourceFunctionId: input.intent.sourceFunctionId ?? null,
    providerServiceId: input.providerServiceId,
    methodResolved: input.methodResolved,
    externalPathResolved: input.externalPathResolved,
    internalPathResolved: input.internalPathResolved,
    routeChain: input.routeChain,
    slotState: {
      endpointCandidateSet: input.endpointCandidateSet,
      routeFamilyState: 'derived_children',
      contradictionReasons: input.contradictionReasons,
    },
    ambiguityCount: 0,
    contradictionCount: input.contradictionReasons.length,
    confidence: input.confidence,
  });
  return childProofStateId;
}

async function updateProofStateContext(
  db: DbClient,
  proofStateId: string,
  patch: Partial<typeof proofStates.$inferInsert>,
) {
  await db
    .update(proofStates)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(proofStates.id, proofStateId));
}

async function setFrontier(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateId: string;
    frontierReason: string;
    frontierClass: string;
    retryStrategy: FrontierRetryStrategy;
    priority: number;
    detail: Record<string, unknown>;
    ambiguityCount?: number;
    contradictionCount?: number;
    confidenceBreakdown?: ProofConfidenceBreakdown;
  },
) {
  await db
    .update(proofStates)
    .set({
      status: 'FRONTIER',
      frontierCode: input.frontierReason,
      rejectedReason: null,
      targetObjectType: null,
      targetObjectId: null,
      confidence: 0,
      confidenceBreakdown: input.confidenceBreakdown ?? buildZeroConfidenceBreakdown(),
      ambiguityCount: input.ambiguityCount ?? 0,
      contradictionCount: input.contradictionCount ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(proofStates.id, input.proofStateId));

  await db.delete(proofFrontiers).where(eq(proofFrontiers.proofStateId, input.proofStateId));
  await db.insert(proofFrontiers).values({
    proofStateId: input.proofStateId,
    workspaceId: input.workspaceId,
    frontierReason: input.frontierReason,
    frontierClass: input.frontierClass,
    detail: input.detail,
    retryStrategy: input.retryStrategy,
    priority: input.priority,
  });
  await clearProjectedCandidates(db, input.workspaceId, input.proofStateId);
}

async function setRejected(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateId: string;
    rejectedReason: string;
    contradictionCount?: number;
    detail?: Record<string, unknown>;
    confidenceBreakdown?: ProofConfidenceBreakdown;
  },
) {
  await db
    .update(proofStates)
    .set({
      status: 'REJECTED',
      frontierCode: null,
      rejectedReason: input.rejectedReason,
      targetObjectType: null,
      targetObjectId: null,
      confidence: 0,
      confidenceBreakdown: input.confidenceBreakdown ?? buildZeroConfidenceBreakdown(),
      ambiguityCount: 0,
      contradictionCount: input.contradictionCount ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(proofStates.id, input.proofStateId));
  await db.delete(proofFrontiers).where(eq(proofFrontiers.proofStateId, input.proofStateId));
  await clearProjectedCandidates(db, input.workspaceId, input.proofStateId);
}

async function closeProof(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateId: string;
    proofType: IntentProofType;
    consumerServiceId: string;
    targetObjectId: string;
    targetObjectType: 'api_endpoint' | 'db_table' | 'topic' | 'queue';
    relationType: 'call' | 'read' | 'write' | 'produce' | 'consume';
    confidence: number;
    confidenceBreakdown: ProofConfidenceBreakdown;
  },
) {
  await db
    .update(proofStates)
    .set({
      status: 'CLOSED_ATOMIC',
      targetObjectType: input.targetObjectType,
      targetObjectId: input.targetObjectId,
      frontierCode: null,
      rejectedReason: null,
      confidence: input.confidence,
      confidenceBreakdown: input.confidenceBreakdown,
      updatedAt: new Date(),
    })
    .where(eq(proofStates.id, input.proofStateId));

  await db.delete(proofFrontiers).where(eq(proofFrontiers.proofStateId, input.proofStateId));
  await clearProjectedCandidates(db, input.workspaceId, input.proofStateId);
  const existingMatchingCandidates = await db
    .select({
      status: relationCandidates.status,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, input.workspaceId),
        eq(relationCandidates.relationType, input.relationType),
        eq(relationCandidates.subjectObjectId, input.consumerServiceId),
        eq(relationCandidates.objectId, input.targetObjectId),
      ),
    );
  const hasResolvedProjection = existingMatchingCandidates.some((candidate) => {
    if (candidate.status === 'PENDING') return false;
    return asString(asRecord(candidate.metadata)?.['proofStateId']) === input.proofStateId;
  });
  if (hasResolvedProjection) return;

  await db.insert(relationCandidates).values({
    id: generateId(),
    workspaceId: input.workspaceId,
    relationType: input.relationType,
    subjectObjectId: input.consumerServiceId,
    objectId: input.targetObjectId,
    confidence: input.confidence,
    metadata: {
      source: 'intent_proof',
      proofStateId: input.proofStateId,
      proofType: input.proofType,
      queued: true,
      confidenceBreakdown: input.confidenceBreakdown,
    },
  });
}

async function applyAcceptedContradictionChallenge(
  db: DbClient,
  input: {
    workspaceId: string;
    proofStateId: string;
    contradictionChallengeReasons: string[];
  },
): Promise<ProofResolutionResult> {
  await setFrontier(db, {
    workspaceId: input.workspaceId,
    proofStateId: input.proofStateId,
    frontierReason: 'SMART_CONTRADICTION_CHALLENGED',
    frontierClass: 'CONTRADICTION',
    retryStrategy: 'manual_review',
    priority: 95,
    detail: {
      challengeReasons: input.contradictionChallengeReasons,
      source: 'contradiction_challenge',
    },
    contradictionCount: input.contradictionChallengeReasons.length,
  });
  await appendProofStep(
    db,
    input.proofStateId,
    'apply_contradiction_challenge',
    'PENDING',
    { contradictionReasons: input.contradictionChallengeReasons },
    { frontierReason: 'SMART_CONTRADICTION_CHALLENGED' },
    '허용된 contradiction challenge로 proof를 재검토 frontier로 되돌렸습니다.',
  );

  return {
    proofStateId: input.proofStateId,
    status: 'FRONTIER',
    frontierReason: 'SMART_CONTRADICTION_CHALLENGED',
    targetObjectId: null,
    relationType: null,
  };
}

function isConfigRouteOnlyHttpIntent(
  intent: typeof interactionIntents.$inferSelect,
  summaryHttp: JsonRecord | null,
): boolean {
  if (summaryHttp) return false;
  if (intent.sourceFunctionId) return false;
  return asStringArray(intent.evidenceIds).some((entry) => entry.startsWith('config:'));
}

function isRouteFamilyHttpIntent(
  intent: typeof interactionIntents.$inferSelect,
  summaryHttp: JsonRecord | null,
): boolean {
  return isGatewayRouteIntentType(intent.intentType) || isConfigRouteOnlyHttpIntent(intent, summaryHttp);
}

function getServiceTokens(service: typeof objects.$inferSelect): string[] {
  const metadata = asRecord(service.metadata);
  const values: string[] = [];
  const pushToken = (value: unknown) => {
    const normalized = normalizeServiceToken(asString(value));
    if (normalized) values.push(normalized);
  };

  pushToken(service.name);
  pushToken(service.displayName);
  pushToken(metadata?.['serviceName']);
  pushToken(metadata?.['host']);
  pushToken(metadata?.['hostname']);
  pushToken(metadata?.['baseUrl']);
  pushToken(metadata?.['url']);
  for (const entry of asStringArray(metadata?.['hosts'])) {
    pushToken(entry);
  }
  for (const entry of asStringArray(metadata?.['urls'])) {
    pushToken(entry);
  }

  return [...new Set(values)];
}

function getEndpointMethodPath(
  endpoint: typeof objects.$inferSelect,
): { method: string | null; path: string | null } {
  const metadata = asRecord(endpoint.metadata);
  const metaMethod = normalizeMethod(metadata?.['method']);
  const metaPath = asString(metadata?.['path']);
  if (metaMethod && metaPath) {
    return { method: metaMethod, path: metaPath };
  }

  const display = asString(endpoint.displayName) ?? endpoint.name;
  const match = display.match(/^([A-Z]+)\s+(.+)$/);
  if (!match) {
    return { method: null, path: null };
  }
  return {
    method: normalizeMethod(match[1]),
    path: asString(match[2]),
  };
}

function collectIndexedRouteTransforms(
  workspaceIndex: IntentProofWorkspaceIndex,
  ownerServiceIds: Array<string | null | undefined>,
): Array<typeof routeTransforms.$inferSelect> {
  const collected = new Map<string, typeof routeTransforms.$inferSelect>();
  for (const transform of workspaceIndex.globalRouteTransforms) {
    collected.set(transform.id, transform);
  }
  for (const ownerServiceId of ownerServiceIds) {
    if (!ownerServiceId) continue;
    const scopedTransforms = workspaceIndex.routeTransformsByOwnerServiceId.get(ownerServiceId) ?? [];
    for (const transform of scopedTransforms) {
      collected.set(transform.id, transform);
    }
  }
  return [...collected.values()];
}

export async function buildIntentProofResolverContext(
  db: DbClient,
  input: { workspaceId: string },
): Promise<IntentProofResolverContext> {
  const [workspaceRouteTransforms, workspaceObjects, profileRows] = await Promise.all([
    db
      .select()
      .from(routeTransforms)
      .where(eq(routeTransforms.workspaceId, input.workspaceId)),
    db
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, input.workspaceId),
          inArray(objects.objectType, ['api_endpoint', 'database', 'db_table', 'topic', 'queue']),
        ),
      ),
    db
      .select()
      .from(domainInferenceProfiles)
      .where(eq(domainInferenceProfiles.workspaceId, input.workspaceId)),
  ]);
  const defaultProfileRow =
    profileRows.find((row) => row.isDefault === true)
    ?? profileRows[0]
    ?? null;
  const proofConfidenceProfile = normalizeProofConfidenceProfile(
    (defaultProfileRow as { proofConfidenceConfig?: unknown; proof_confidence_config?: unknown } | null)?.proofConfidenceConfig
      ?? (defaultProfileRow as { proofConfidenceConfig?: unknown; proof_confidence_config?: unknown } | null)?.proof_confidence_config,
  );

  const workspaceEndpoints = workspaceObjects.filter((objectRow) => objectRow.objectType === 'api_endpoint');
  const databaseObjects = workspaceObjects.filter((objectRow) => objectRow.objectType === 'database');
  const dbTableObjects = workspaceObjects.filter((objectRow) => objectRow.objectType === 'db_table');
  const channelObjects = workspaceObjects.filter(
    (objectRow): objectRow is typeof objects.$inferSelect =>
      objectRow.objectType === 'topic' || objectRow.objectType === 'queue',
  );

  const globalRouteTransforms: Array<typeof routeTransforms.$inferSelect> = [];
  const routeTransformsByOwnerServiceId = new Map<string, Array<typeof routeTransforms.$inferSelect>>();
  for (const transform of workspaceRouteTransforms) {
    if (!transform.ownerServiceId) {
      globalRouteTransforms.push(transform);
      continue;
    }
    const scopedTransforms = routeTransformsByOwnerServiceId.get(transform.ownerServiceId) ?? [];
    scopedTransforms.push(transform);
    routeTransformsByOwnerServiceId.set(transform.ownerServiceId, scopedTransforms);
  }

  const providerEndpointsByServiceId = new Map<string, Array<typeof objects.$inferSelect>>();
  const endpointRecordsByServiceId = new Map<string, EndpointIndexRecord[]>();
  for (const endpoint of workspaceEndpoints) {
    if (!endpoint.parentId) continue;
    const providerEndpoints = providerEndpointsByServiceId.get(endpoint.parentId) ?? [];
    providerEndpoints.push(endpoint);
    providerEndpointsByServiceId.set(endpoint.parentId, providerEndpoints);

    const match = getEndpointMethodPath(endpoint);
    if (match.method === null || match.path === null) {
      continue;
    }
    const endpointRecords = endpointRecordsByServiceId.get(endpoint.parentId) ?? [];
    endpointRecords.push({
      endpoint,
      match: {
        method: match.method,
        path: normalizePath(match.path),
      },
    });
    endpointRecordsByServiceId.set(endpoint.parentId, endpointRecords);
  }

  const databaseIndexRecords = databaseObjects.map((database) => ({
    database,
    tokens: collectDatabaseTokens(database),
  }));
  const channelObjectsByType = new Map<'topic' | 'queue', Array<typeof objects.$inferSelect>>();
  const channelIndexRecordsByType = new Map<'topic' | 'queue', ChannelIndexRecord[]>();
  for (const channel of channelObjects) {
    const channelType = channel.objectType as 'topic' | 'queue';
    const channels = channelObjectsByType.get(channelType) ?? [];
    channels.push(channel);
    channelObjectsByType.set(channelType, channels);

    const channelRecords = channelIndexRecordsByType.get(channelType) ?? [];
    channelRecords.push({
      channel,
      tokens: collectChannelTokens(channel),
    });
    channelIndexRecordsByType.set(channelType, channelRecords);
  }

  return {
    workspaceId: input.workspaceId,
    proofConfidenceProfile,
    globalRouteTransforms,
    routeTransformsByOwnerServiceId,
    providerEndpointsByServiceId,
    endpointRecordsByServiceId,
    databaseObjects,
    dbTableObjects,
    databaseIndexRecords,
    channelObjectsByType,
    channelIndexRecordsByType,
  };
}

export const preloadIntentProofWorkspaceIndex = buildIntentProofResolverContext;

function extractDbIntentResource(resourceHint: string | null): { schemaHint: string | null; tableHint: string | null } {
  if (!resourceHint) {
    return { schemaHint: null, tableHint: null };
  }
  const segments = resourceHint
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length >= 2) {
    return {
      schemaHint: segments[0] ?? null,
      tableHint: segments.at(-1) ?? null,
    };
  }
  return {
    schemaHint: null,
    tableHint: segments[0] ?? null,
  };
}

function buildDbContradictionReasons(input: {
  intent: typeof interactionIntents.$inferSelect;
  outboundDb: JsonRecord | null;
  summaryFlags: JsonRecord | null;
  resolvedSchemaHint: string | null;
  resolvedTableHint: string | null;
}): string[] {
  const contradictions: string[] = [];
  const summarySchemaHint = asString(input.outboundDb?.['schema']);
  const summaryTableHint = asString(input.outboundDb?.['table']) ?? asString(input.outboundDb?.['tableName']);
  const intentResource = extractDbIntentResource(asString(input.intent.resourceHint));

  if (
    intentResource.schemaHint
    && summarySchemaHint
    && normalizeLookupToken(intentResource.schemaHint) !== normalizeLookupToken(summarySchemaHint)
  ) {
    contradictions.push('DB_SCHEMA_CONTRADICTION');
  }
  if (
    intentResource.tableHint
    && summaryTableHint
    && normalizeLookupToken(intentResource.tableHint) !== normalizeLookupToken(summaryTableHint)
  ) {
    contradictions.push('DB_TABLE_CONTRADICTION');
  }
  if (
    input.resolvedSchemaHint
    && summarySchemaHint
    && normalizeLookupToken(input.resolvedSchemaHint) !== normalizeLookupToken(summarySchemaHint)
  ) {
    contradictions.push('DB_SCHEMA_CONTRADICTION');
  }
  if (
    input.resolvedTableHint
    && summaryTableHint
    && normalizeLookupToken(input.resolvedTableHint) !== normalizeLookupToken(summaryTableHint)
  ) {
    contradictions.push('DB_TABLE_CONTRADICTION');
  }
  if (asBoolean(input.summaryFlags?.['unsupportedPattern'])) {
    contradictions.push('UNSUPPORTED_SUMMARY_CONFLICT');
  }
  if (asBoolean(input.summaryFlags?.['truncated'])) {
    contradictions.push('TRUNCATED_SUMMARY_CONFLICT');
  }

  return [...new Set(contradictions)];
}

function buildMessageContradictionReasons(input: {
  intent: typeof interactionIntents.$inferSelect;
  outboundMessage: JsonRecord | null;
  summaryFlags: JsonRecord | null;
  channelHint: string | null;
  objectType: 'topic' | 'queue';
}): string[] {
  const contradictions: string[] = [];
  const summaryTopic = asString(input.outboundMessage?.['topic']);
  const summaryQueue = asString(input.outboundMessage?.['queue']);
  const summaryObjectType = messageObjectTypeFromSummary(input.outboundMessage);
  const resourceHint = asString(input.intent.resourceHint);

  if (resourceHint) {
    const normalizedResource = normalizeLookupToken(resourceHint);
    const normalizedSummaryTopic = normalizeLookupToken(summaryTopic ?? '');
    const normalizedSummaryQueue = normalizeLookupToken(summaryQueue ?? '');
    if (
      normalizedSummaryTopic.length > 0
      && normalizedResource !== normalizedSummaryTopic
      && input.objectType === 'topic'
    ) {
      contradictions.push('MESSAGE_TARGET_CONTRADICTION');
    }
    if (
      normalizedSummaryQueue.length > 0
      && normalizedResource !== normalizedSummaryQueue
      && input.objectType === 'queue'
    ) {
      contradictions.push('MESSAGE_TARGET_CONTRADICTION');
    }
  }
  if (input.channelHint) {
    const normalizedChannelHint = normalizeLookupToken(input.channelHint);
    const summaryName = summaryTopic ?? summaryQueue ?? asString(input.outboundMessage?.['name']);
    if (
      summaryName
      && normalizedChannelHint !== normalizeLookupToken(summaryName)
    ) {
      contradictions.push('MESSAGE_TARGET_CONTRADICTION');
    }
  }
  if (summaryObjectType && summaryObjectType !== input.objectType) {
    contradictions.push('MESSAGE_CHANNEL_TYPE_CONTRADICTION');
  }
  if (asBoolean(input.summaryFlags?.['unsupportedPattern'])) {
    contradictions.push('UNSUPPORTED_SUMMARY_CONFLICT');
  }
  if (asBoolean(input.summaryFlags?.['truncated'])) {
    contradictions.push('TRUNCATED_SUMMARY_CONFLICT');
  }

  return [...new Set(contradictions)];
}

function buildProofDependencySnapshot(input: {
  intent: typeof interactionIntents.$inferSelect;
  proofState: typeof proofStates.$inferSelect | null;
  summary: typeof functionSummaries.$inferSelect | null;
  aliasBindingIds?: string[];
  routeTransformIds?: string[];
}): ProofDependencySnapshot {
  const serviceIds = [
    input.intent.sourceServiceId,
    input.proofState?.consumerServiceId ?? null,
    input.proofState?.providerServiceId ?? null,
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  const objectIds = [
    input.intent.sourceFunctionId,
    input.proofState?.targetObjectId ?? null,
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

  return {
    serviceIds: [...new Set(serviceIds)].sort(),
    objectIds: [...new Set(objectIds)].sort(),
    aliasBindingIds: [...new Set(input.aliasBindingIds ?? [])].sort(),
    routeTransformIds: [...new Set(input.routeTransformIds ?? [])].sort(),
    summaryIds: input.summary ? [input.summary.id] : [],
  };
}

async function projectRouteFamilyChildProofs(
  db: DbClient,
  input: {
    workspaceId: string;
    intent: typeof interactionIntents.$inferSelect;
    rootProofStateId: string;
    targetObjectIds: string[];
    matchBasis: EndpointCandidateSetDetail['matchBasis'];
    slots: HttpResolutionSlots;
    confidence: number;
    proofConfidenceProfile: ProofConfidenceProfileConfig;
  },
): Promise<ProofResolutionResult> {
  const endpointCandidateSet: EndpointCandidateSetDetail = {
    objectIds: input.targetObjectIds,
    count: input.targetObjectIds.length,
    matchBasis: input.matchBasis,
  };
  const confidenceBreakdown = buildProofConfidenceBreakdown({
    profile: input.proofConfidenceProfile,
    summaryQuality: input.confidence,
    slotCompleteness: computeHttpSlotCompleteness({
      slotWeights: input.proofConfidenceProfile.slotWeights.http,
      methodResolved: input.slots.methodResolved,
      externalPathResolved: input.slots.externalPathResolved,
      internalPathResolved: input.slots.internalPathResolved,
      providerServiceId: input.slots.providerServiceId,
      targetObjectId: input.targetObjectIds[0] ?? null,
    }),
    corroborationSignals:
      Number(input.intent.sourceFunctionId !== null)
      + Number(input.slots.providerServiceId !== null)
      + Number(input.slots.routeChain.length > 0),
    matchSpecificity: input.matchBasis === 'method_exact' ? 0.18 : 0.12,
    contradictionCount: input.slots.contradictionReasons.length,
    status: 'CLOSED_ATOMIC',
  });
  const childProofStateIds: string[] = [];
  for (const targetObjectId of input.targetObjectIds) {
    const childProofStateId = await createRouteFamilyChildProofState(db, {
      workspaceId: input.workspaceId,
      intent: input.intent,
      parentProofStateId: input.rootProofStateId,
      providerServiceId: input.slots.providerServiceId!,
      methodResolved: input.slots.methodResolved,
      externalPathResolved: input.slots.externalPathResolved,
      internalPathResolved: input.slots.internalPathResolved!,
      routeChain: input.slots.routeChain,
      targetObjectId,
      endpointCandidateSet,
      contradictionReasons: input.slots.contradictionReasons,
      confidence: input.confidence,
    });
    childProofStateIds.push(childProofStateId);

    await appendProofStep(
      db,
      childProofStateId,
      'anchorDerivedChildProof',
      'APPLIED',
      {
        originIntentId: input.intent.id,
        parentProofStateId: input.rootProofStateId,
      },
      {
        targetObjectId,
      },
      'Route-family seed에서 endpoint-scoped child proof를 생성했습니다.',
    );
    await appendProofStep(
      db,
      childProofStateId,
      'matchAtomicTarget',
      'APPLIED',
      {
        internalPathResolved: input.slots.internalPathResolved,
        routeChain: input.slots.routeChain,
      },
      {
        targetObjectId,
      },
      'Derived child proof를 단일 atomic endpoint에 고정했습니다.',
    );
    await appendProofStep(
      db,
      childProofStateId,
      'validateChildProofCompleteness',
      'APPLIED',
      {
        contradictionReasons: input.slots.contradictionReasons,
      },
      {
        targetObjectId,
      },
      'Derived child proof가 atomic closure 조건을 충족했습니다.',
    );
    await closeProof(db, {
      workspaceId: input.workspaceId,
      proofStateId: childProofStateId,
      proofType: 'http_gateway_route',
      consumerServiceId: input.intent.sourceServiceId,
      targetObjectId,
      targetObjectType: 'api_endpoint',
      relationType: 'call',
      confidence: confidenceBreakdown.finalConfidence,
      confidenceBreakdown,
    });
    await appendProofStep(
      db,
      childProofStateId,
      'projectCandidate',
      'APPLIED',
      {
        targetObjectId,
        confidenceBreakdown,
      },
      {
        relationType: 'call',
        targetObjectType: 'api_endpoint',
      },
      'Derived child proof만 relation candidate로 projection했습니다.',
    );
  }

  await updateProofStateContext(db, input.rootProofStateId, {
    providerServiceId: input.slots.providerServiceId,
    methodResolved: input.slots.methodResolved,
    externalPathResolved: input.slots.externalPathResolved,
    internalPathResolved: input.slots.internalPathResolved,
    routeChain: input.slots.routeChain,
    slotState: {
      hostHints: input.slots.hostHints,
      configKeys: input.slots.configKeys,
      contradictionReasons: input.slots.contradictionReasons,
      unsupportedPattern: input.slots.unsupportedPattern,
      truncated: input.slots.truncated,
      endpointCandidateSet,
      routeFamilyState: 'derived_children',
      derivedChildProofStateIds: childProofStateIds,
    },
  });
  await appendProofStep(
    db,
    input.rootProofStateId,
    'spawnEndpointScopedChildProofs',
    'APPLIED',
    {
      endpointCandidateSet: input.targetObjectIds,
    },
    {
      childProofStateIds,
      targetObjectIds: input.targetObjectIds,
    },
    'Route-family root proof에서 child proof row를 생성했습니다.',
  );
  await appendProofStep(
    db,
    input.rootProofStateId,
    'validateChildProofCompleteness',
    'APPLIED',
    {
      childProofStateIds,
    },
    {
      targetObjectIds: input.targetObjectIds,
    },
    'Route-family root proof는 child proof closure 결과를 기록했습니다.',
  );
  await appendProofStep(
    db,
    input.rootProofStateId,
    'projectClosedAtomicChildren',
    'APPLIED',
    {
      childProofStateIds,
    },
    {
      targetObjectIds: input.targetObjectIds,
      relationType: 'call',
    },
    'Route-family root proof는 직접 projection하지 않고 child proof projection만 기록했습니다.',
  );

  return {
    proofStateId: childProofStateIds[0]!,
    status: 'CLOSED_ATOMIC',
    frontierReason: null,
    targetObjectId: input.targetObjectIds[0]!,
    relationType: 'call',
  };
}

async function resolveHttpIntent(
  db: DbClient,
  workspaceId: string,
  intent: typeof interactionIntents.$inferSelect,
  proofStateId: string,
  summary: typeof functionSummaries.$inferSelect | null,
  acceptedPatchHints: AcceptedPatchHints,
  resolverContext?: IntentProofResolverContext,
): Promise<ProofResolutionResult> {
  const summaryHttp = asRecord(summary?.outboundHttp);
  const summaryFlags = asRecord(summary?.flags);
  const routeFamilyMode = normalizeIntentType(intent.intentType) === 'http_gateway_route';
  const routeFamilyIntent = routeFamilyMode || isRouteFamilyHttpIntent(intent, summaryHttp);
  const routeScopeKind = normalizeRouteScopeKind(intent.routeScopeKind) ?? 'exact';
  const slots: HttpResolutionSlots = {
    methodResolved: null,
    externalPathResolved: null,
    internalPathResolved: null,
    providerServiceId: null,
    resolvedHost: null,
    portHints: [],
    routeChain: [],
    routeFamilyCompositionPaths: [],
    hostHints: [],
    configKeys: [],
    contradictionReasons: [],
    dynamicPath: false,
    dynamicHost: false,
    unsupportedPattern: asBoolean(summaryFlags?.['unsupportedPattern']),
    truncated: asBoolean(summaryFlags?.['truncated']),
  };

  await appendProofStep(
    db,
    proofStateId,
    'anchorIntent',
    'APPLIED',
    {
      workspaceId,
      intentType: intent.intentType,
      sourceServiceId: intent.sourceServiceId,
    },
    {},
    'HTTP intent anchor를 확인했습니다.',
  );

  const hostHints = [
    asString(intent.hostHint),
    asString(summaryHttp?.['hostAlias']),
    asString(summaryHttp?.['host']),
    extractHostFromValue(asString(summaryHttp?.['url'])),
  ].filter((entry): entry is string => entry !== null);
  const configKeys = [
    ...asStringArray(intent.configKeys),
    ...asStringArray(summaryHttp?.['configKeys']),
    ...asStringArray(summary?.aliasHints),
  ];
  slots.hostHints = [...new Set(hostHints)];
  slots.configKeys = [...new Set(configKeys)];
  const configBindingBundle = buildConfigBindingContext({
    configKeys: slots.configKeys,
    aliasHints: asStringArray(summary?.aliasHints),
  });
  slots.hostHints = uniqueSortedStrings([
    ...slots.hostHints,
    ...configBindingBundle.descriptors.flatMap((binding) => binding.hostHints),
  ]);
  slots.portHints = uniqueSortedStrings([
    ...slots.portHints,
    ...configBindingBundle.descriptors.flatMap((binding) => binding.portHints),
  ]);
  slots.dynamicPath =
    asBoolean(summaryFlags?.['dynamicPath'])
    || asBoolean(summaryHttp?.['dynamicPath'])
    || false;
  slots.dynamicHost =
    asBoolean(summaryFlags?.['dynamicHost'])
    || asBoolean(summaryHttp?.['dynamicHost'])
    || false;

  await appendProofStep(
    db,
    proofStateId,
    'hydrateFromFunctionSummary',
    'APPLIED',
    {
      methodHint: intent.methodHint,
      externalPathHint: intent.externalPathHint,
      hostHint: intent.hostHint,
    },
    {
      hostHints: slots.hostHints,
      configKeys: slots.configKeys,
      portHints: slots.portHints,
      configBindingSummary: configBindingBundle.summary,
      configBindingUnresolvedReasons: configBindingBundle.unresolved.map((entry) => entry.reason),
      extractionStrategy: summary?.extractionStrategy ?? null,
      summaryCompleteness: summary?.summaryCompleteness ?? null,
      signalSources: asStringArray(summary?.signalSources),
      unsupportedPattern: slots.unsupportedPattern,
      truncated: slots.truncated,
      dynamicPath: slots.dynamicPath,
      dynamicHost: slots.dynamicHost,
    },
    'HTTP summary와 hint를 기반으로 resolver 슬롯을 보강했습니다.',
  );

  const services = await db
    .select()
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));
  const serviceById = new Map(services.map((service) => [service.id, service]));

  const activeAliasBindings = await db
    .select()
    .from(aliasBindings)
    .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.status, 'ACTIVE')));
  const scopedBindings = activeAliasBindings.filter(
    (binding) => binding.ownerServiceId === null || binding.ownerServiceId === intent.sourceServiceId,
  );
  const bindingMatches = findMatchingAliasBindings(scopedBindings, [...slots.hostHints, ...slots.configKeys]);
  const lookupKeys = new Set(
    [...slots.hostHints, ...slots.configKeys]
      .flatMap((entry) => expandLookupCandidates(entry))
      .filter((entry) => entry.length > 0),
  );

  const candidateProviderIds = new Set<string>();
  const candidateHosts = new Set<string>();
  for (const binding of bindingMatches) {
    if (binding.resolvedServiceId) candidateProviderIds.add(binding.resolvedServiceId);
    if (binding.resolvedHost) candidateHosts.add(binding.resolvedHost.toLowerCase());
  }

  const directServiceMatches = services.filter((service) => {
    const tokens = new Set(getServiceTokens(service));
    return [...lookupKeys]
      .flatMap((entry) => expandLookupCandidates(entry))
      .map((entry) => normalizeServiceToken(entry))
      .filter((entry): entry is string => entry !== null)
      .some((entry) => tokens.has(entry));
  });
  for (const service of directServiceMatches) {
    candidateProviderIds.add(service.id);
  }

  if (candidateProviderIds.size === 0 && candidateHosts.size > 0) {
    for (const service of services) {
      const tokens = new Set(getServiceTokens(service));
      if ([...candidateHosts].map((host) => normalizeServiceToken(host)).some((host) => host && tokens.has(host))) {
        candidateProviderIds.add(service.id);
      }
    }
  }

  if (candidateProviderIds.size === 0) {
    const providerPathHints = collectProviderPathHints({
      intent,
      summaryHttp,
      acceptedPatchHints,
    });
    if (providerPathHints.length > 0) {
      const allEndpoints = resolverContext
        ? [...resolverContext.providerEndpointsByServiceId.values()].flat()
        : await db
          .select()
          .from(objects)
          .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'api_endpoint')));
      const endpointPathMatches = allEndpoints
        .map((endpoint) => ({ endpoint, match: getEndpointMethodPath(endpoint) }))
        .filter((row) =>
          row.endpoint.parentId !== null
          && row.endpoint.parentId !== intent.sourceServiceId
          && row.match.path !== null
          && providerPathHints.some((pathHint) => computeEndpointPathCompatibilityScore(pathHint, row.match.path!) >= 0.75),
        );
      const providerScores = new Map<string, number>();
      for (const row of endpointPathMatches) {
        const providerId = row.endpoint.parentId;
        if (!providerId || !row.match.path) continue;
        const methodScore = isMethodCompatible(slots.methodResolved ?? 'ANY', row.match.method) ? 0.3 : 0;
        const pathScore = Math.max(...providerPathHints.map((pathHint) => computeEndpointPathCompatibilityScore(pathHint, row.match.path!)));
        const totalScore = pathScore + methodScore;
        providerScores.set(providerId, Math.max(providerScores.get(providerId) ?? 0, totalScore));
      }
      const rankedProviders = [...providerScores.entries()].sort((a, b) => b[1] - a[1]);
      const topProvider = rankedProviders[0] ?? null;
      const secondProvider = rankedProviders[1] ?? null;
      if (topProvider && (!secondProvider || topProvider[1] - secondProvider[1] >= 0.2) && topProvider[1] >= 0.9) {
        candidateProviderIds.add(topProvider[0]);
        await appendProofStep(
          db,
          proofStateId,
          'resolveHostAlias',
          'APPLIED',
          {
            hostHints: slots.hostHints,
            configKeys: slots.configKeys,
            portHints: slots.portHints,
          },
          {
            providerServiceId: topProvider[0],
            resolutionMode: 'path_only_endpoint_inventory',
            pathHints: providerPathHints,
            providerScores: Object.fromEntries(rankedProviders),
          },
          'Host/config alias가 부족한 경우 endpoint inventory path 힌트로 provider service를 보강했습니다.',
        );
      }
    }
  }

  if (
    acceptedPatchHints.providerServiceOverride
    && candidateProviderIds.has(acceptedPatchHints.providerServiceOverride)
  ) {
    candidateProviderIds.clear();
    candidateProviderIds.add(acceptedPatchHints.providerServiceOverride);
  }

  if (candidateProviderIds.size > 1) {
    await updateProofStateContext(db, proofStateId, {
      slotState: {
        hostHints: slots.hostHints,
        configKeys: slots.configKeys,
        portHints: slots.portHints,
        configBindingSummary: configBindingBundle.summary,
        configBindingUnresolvedReasons: configBindingBundle.unresolved.map((entry) => entry.reason),
      },
    });
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      frontierClass: 'ALIAS',
      retryStrategy: 'manual_review',
      priority: 100,
      ambiguityCount: candidateProviderIds.size,
      detail: { candidateProviderIds: [...candidateProviderIds], hostHints: slots.hostHints, portHints: slots.portHints },
    });
    await appendProofStep(
      db,
      proofStateId,
      'resolveHostAlias',
      'FAILED',
      { hostHints: slots.hostHints, configKeys: slots.configKeys, portHints: slots.portHints },
      { candidateProviderIds: [...candidateProviderIds] },
      '복수 provider service가 매칭되어 frontier로 전이했습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 3, 'PROVIDER_SERVICE_AMBIGUOUS');
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    };
  }

  const resolvedProviderId = [...candidateProviderIds][0] ?? null;
  if (!resolvedProviderId) {
    const frontierReason =
      slots.dynamicHost || slots.dynamicPath
        ? 'DYNAMIC_URI_UNRESOLVED'
        : (
            slots.hostHints.length === 0
            && slots.configKeys.length === 0
            && (
              slots.externalPathResolved
              || asString(intent.externalPathHint)
            )
          )
          ? 'PATH_ONLY_TARGET_UNRESOLVED'
          : (slots.configKeys.length > 0 ? 'CONFIG_BINDING_MISSING' : 'HOST_ALIAS_UNRESOLVED');
    await updateProofStateContext(db, proofStateId, {
      slotState: {
        hostHints: slots.hostHints,
        configKeys: slots.configKeys,
        dynamicPath: slots.dynamicPath,
        dynamicHost: slots.dynamicHost,
        portHints: slots.portHints,
        configBindingSummary: configBindingBundle.summary,
        configBindingUnresolvedReasons: configBindingBundle.unresolved.map((entry) => entry.reason),
      },
    });
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason,
      frontierClass: 'ALIAS',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: { hostHints: slots.hostHints, configKeys: slots.configKeys, portHints: slots.portHints },
    });
    await appendProofStep(
      db,
      proofStateId,
      'resolveHostAlias',
      'FAILED',
      { hostHints: slots.hostHints, configKeys: slots.configKeys, portHints: slots.portHints },
      { frontierReason },
      'Host alias를 provider service로 닫지 못했습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 3, frontierReason);
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason,
      targetObjectId: null,
      relationType: null,
    };
  }

  slots.providerServiceId = resolvedProviderId;
  slots.resolvedHost =
    [...candidateHosts][0]
    ?? extractHostFromValue(asString(summaryHttp?.['url']))
    ?? asString(intent.hostHint);
  await updateProofStateContext(db, proofStateId, {
    providerServiceId: slots.providerServiceId,
    slotState: {
      hostHints: slots.hostHints,
      configKeys: slots.configKeys,
      resolvedHost: slots.resolvedHost,
      portHints: slots.portHints,
      configBindingSummary: configBindingBundle.summary,
      configBindingUnresolvedReasons: configBindingBundle.unresolved.map((entry) => entry.reason),
    },
  });
  await appendProofStep(
    db,
    proofStateId,
    'resolveHostAlias',
    'APPLIED',
    { hostHints: slots.hostHints, configKeys: slots.configKeys, portHints: slots.portHints },
    { providerServiceId: slots.providerServiceId, resolvedHost: slots.resolvedHost },
    'Host alias를 provider service로 고정했습니다.',
  );

  const hintedMethod = acceptedPatchHints.methodHintOverride ?? normalizeMethod(intent.methodHint);
  const summaryMethod = normalizeMethod(summaryHttp?.['method']);
  const methodResolved = hintedMethod ?? summaryMethod;
  if (hintedMethod && summaryMethod && hintedMethod !== summaryMethod) {
    slots.contradictionReasons.push('METHOD_CONTRADICTION');
  }

  const hintedPath = acceptedPatchHints.externalPathOverride ?? asString(intent.externalPathHint);
  const summaryPathSource =
    asString(summaryHttp?.['externalPath'])
    ?? asString(summaryHttp?.['path'])
    ?? asString(summaryHttp?.['url']);
  const summaryPath = summaryPathSource ? normalizePath(summaryPathSource) : null;
  const externalPathResolved = hintedPath ? normalizePath(hintedPath) : summaryPath;
  if (hintedPath && summaryPath && normalizePath(hintedPath) !== summaryPath) {
    slots.contradictionReasons.push('PATH_CONTRADICTION');
  }

  if (!externalPathResolved) {
    const frontierReason = slots.dynamicPath ? 'DYNAMIC_URI_UNRESOLVED' : 'PATH_TEMPLATE_UNKNOWN';
    await updateProofStateContext(db, proofStateId, {
      providerServiceId: slots.providerServiceId,
      methodResolved,
      slotState: {
        hostHints: slots.hostHints,
        configKeys: slots.configKeys,
        dynamicPath: slots.dynamicPath,
        dynamicHost: slots.dynamicHost,
      },
    });
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason,
      frontierClass: 'METHOD_PATH',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: { externalPathHint: intent.externalPathHint, outboundHttp: summaryHttp },
    });
    await appendProofStep(
      db,
      proofStateId,
      'normalizeMethodAndPath',
      'FAILED',
      { externalPathHint: intent.externalPathHint, summaryPath: summaryPathSource },
      { frontierReason },
      'HTTP path를 정규화하지 못했습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 4, frontierReason);
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason,
      targetObjectId: null,
      relationType: null,
    };
  }

  slots.methodResolved = methodResolved;
  slots.externalPathResolved = externalPathResolved;
  await updateProofStateContext(db, proofStateId, {
    providerServiceId: slots.providerServiceId,
    methodResolved: slots.methodResolved,
    externalPathResolved: slots.externalPathResolved,
    slotState: {
      hostHints: slots.hostHints,
      configKeys: slots.configKeys,
      contradictionReasons: slots.contradictionReasons,
      dynamicPath: slots.dynamicPath,
      dynamicHost: slots.dynamicHost,
      unsupportedPattern: slots.unsupportedPattern,
      truncated: slots.truncated,
    },
  });
  await appendProofStep(
    db,
    proofStateId,
    'normalizeMethodAndPath',
    'APPLIED',
    {
      methodHint: intent.methodHint,
      externalPathHint: intent.externalPathHint,
      summaryMethod: summaryHttp?.['method'] ?? null,
      summaryPath: summaryPathSource,
    },
    {
      methodResolved: slots.methodResolved,
      externalPathResolved: slots.externalPathResolved,
      contradictionReasons: slots.contradictionReasons,
    },
    'HTTP method/path를 resolver 입력 슬롯으로 정규화했습니다.',
  );

  const allRouteTransforms = resolverContext
    ? collectIndexedRouteTransforms(resolverContext, [intent.sourceServiceId, slots.providerServiceId])
    : await db
      .select()
      .from(routeTransforms)
      .where(eq(routeTransforms.workspaceId, workspaceId));
  const providerService = serviceById.get(slots.providerServiceId);
  const providerServiceName = providerService?.name ?? null;
  const providerServiceAliases = new Set(
    activeAliasBindings
      .filter((binding) => binding.resolvedServiceId === slots.providerServiceId)
      .flatMap((binding) => [binding.aliasKey, binding.aliasValue])
      .map((entry) => normalizeLookupToken(entry))
      .filter((entry) => entry.length > 0),
  );
  if (providerServiceName) {
    providerServiceAliases.add(normalizeLookupToken(providerServiceName));
    providerServiceAliases.add(normalizeServiceName(providerServiceName));
  }
  const routeCandidates = allRouteTransforms.filter((transform) => {
    const ownerMatches = transform.ownerServiceId === null
      || transform.ownerServiceId === intent.sourceServiceId
      || transform.ownerServiceId === slots.providerServiceId;
    const targetMatches = !transform.targetServiceHint
      || providerServiceAliases.has(normalizeLookupToken(transform.targetServiceHint))
      || providerServiceAliases.has(normalizeServiceName(transform.targetServiceHint));
    if (!ownerMatches && !targetMatches) {
      return false;
    }
    if (transform.matchHost && slots.resolvedHost && normalizeLookupToken(transform.matchHost) !== normalizeLookupToken(slots.resolvedHost)) {
      return false;
    }
    if (transform.targetServiceHint && !targetMatches) {
      return false;
    }
    if (transform.targetHostAlias && slots.hostHints.length > 0) {
      const targetAlias = normalizeLookupToken(transform.targetHostAlias);
      if (!slots.hostHints.some((hint) => normalizeLookupToken(hint) === targetAlias)) {
        return false;
      }
    }
    return true;
  });

  let currentPath = slots.externalPathResolved!;
  const appliedRouteIds: string[] = [];
  const appliedTransforms: Array<typeof routeTransforms.$inferSelect> = [];
  const visitedTransforms = new Set<string>();
  let routeIterations = 0;

  while (routeIterations < 5) {
    const matchingTransforms = routeCandidates
      .filter((transform) => !visitedTransforms.has(transform.id) && routePathMatches(currentPath, transform))
      .sort((left, right) => {
        if (right.priority !== left.priority) return right.priority - left.priority;
        const specificityDiff = routePathSpecificity(right) - routePathSpecificity(left);
        if (specificityDiff !== 0) return specificityDiff;
        return left.id.localeCompare(right.id);
      });

    if (matchingTransforms.length === 0) {
      break;
    }

    const topPriority = matchingTransforms[0]!.priority;
    const topSpecificity = routePathSpecificity(matchingTransforms[0]!);
    const tiedTransforms = matchingTransforms.filter(
      (transform) => transform.priority === topPriority && routePathSpecificity(transform) === topSpecificity,
    );
    const topResults = tiedTransforms.map((transform) => ({
      transform,
      applied: applyRouteTransformToPath(currentPath, transform),
    }));

    const failedTransform = topResults.find((result) => result.applied.error || !result.applied.internalPath);
    if (failedTransform) {
      await setFrontier(db, {
        workspaceId,
        proofStateId,
        frontierReason: 'PATH_REWRITE_CONFLICT',
        frontierClass: 'ROUTE',
        retryStrategy: 'manual_review',
        priority: 90,
        detail: {
          routeTransformId: failedTransform.transform.id,
          externalPath: currentPath,
        },
      });
      await appendProofStep(
        db,
        proofStateId,
        'applyRouteTransforms',
        'FAILED',
        { externalPath: currentPath, routeTransformIds: tiedTransforms.map((transform) => transform.id) },
        { frontierReason: 'PATH_REWRITE_CONFLICT' },
        'Route rewrite를 안정적으로 적용하지 못했습니다.',
      );
      await appendSkippedHttpSteps(db, proofStateId, 5, 'PATH_REWRITE_CONFLICT');
      return {
        proofStateId,
        status: 'FRONTIER',
        frontierReason: 'PATH_REWRITE_CONFLICT',
        targetObjectId: null,
        relationType: null,
      };
    }

    const distinctPaths = [...new Set(topResults.map((result) => result.applied.internalPath!))];
    if (distinctPaths.length > 1) {
      await setFrontier(db, {
        workspaceId,
        proofStateId,
        frontierReason: 'PATH_REWRITE_CONFLICT',
        frontierClass: 'ROUTE',
        retryStrategy: 'manual_review',
        priority: 90,
        detail: {
          externalPath: currentPath,
          transformedPaths: distinctPaths,
          routeTransformIds: tiedTransforms.map((transform) => transform.id),
        },
      });
      await appendProofStep(
        db,
        proofStateId,
        'applyRouteTransforms',
        'FAILED',
        { externalPath: currentPath, routeTransformIds: tiedTransforms.map((transform) => transform.id) },
        { transformedPaths: distinctPaths },
        '동일 우선순위 route transform이 상충하는 내부 경로를 만들었습니다.',
      );
      await appendSkippedHttpSteps(db, proofStateId, 5, 'PATH_REWRITE_CONFLICT');
      return {
        proofStateId,
        status: 'FRONTIER',
        frontierReason: 'PATH_REWRITE_CONFLICT',
        targetObjectId: null,
        relationType: null,
      };
    }

    const selected = topResults[0]!;
    visitedTransforms.add(selected.transform.id);
    appliedRouteIds.push(selected.transform.id);
    appliedTransforms.push(selected.transform);
    routeIterations += 1;
    if (selected.applied.internalPath === currentPath) {
      break;
    }
    currentPath = selected.applied.internalPath!;
  }

  slots.internalPathResolved = currentPath;
  slots.routeChain = appliedRouteIds;
  if (routeFamilyIntent) {
    slots.routeFamilyCompositionPaths = collectRouteFamilyCompositionPaths({
      externalPathResolved: slots.externalPathResolved!,
      externalRoutePattern: intent.externalRoutePattern,
      internalPathResolved: slots.internalPathResolved,
      transforms: appliedTransforms,
    });
  }
  await updateProofStateContext(db, proofStateId, {
    providerServiceId: slots.providerServiceId,
    methodResolved: slots.methodResolved,
    externalPathResolved: slots.externalPathResolved,
    internalPathResolved: slots.internalPathResolved,
    routeChain: slots.routeChain,
    slotState: {
      hostHints: slots.hostHints,
      configKeys: slots.configKeys,
      contradictionReasons: slots.contradictionReasons,
      unsupportedPattern: slots.unsupportedPattern,
      truncated: slots.truncated,
      routeFamilyCompositionPaths: slots.routeFamilyCompositionPaths,
    },
  });
  await appendProofStep(
    db,
    proofStateId,
    'applyRouteTransforms',
    'APPLIED',
    { externalPathResolved: slots.externalPathResolved, routeTransformIds: routeCandidates.map((transform) => transform.id) },
    { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
    'Route transform을 적용해 내부 경로를 결정했습니다.',
  );

  const providerEndpoints = resolverContext
    ? (slots.providerServiceId ? (resolverContext.providerEndpointsByServiceId.get(slots.providerServiceId) ?? []) : [])
    : await db
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'api_endpoint'),
          eq(objects.parentId, slots.providerServiceId),
        ),
      );
  if (providerEndpoints.length === 0) {
    const detail = (routeFamilyMode || isRouteFamilyHttpIntent(intent, summaryHttp))
      ? buildRouteFamilyDetail({
          providerServiceId: slots.providerServiceId,
          internalPathResolved: slots.internalPathResolved,
          routeChain: slots.routeChain,
          candidateObjectIds: [],
          compositionPaths: slots.routeFamilyCompositionPaths,
          filteredOutReasons: ['NO_PROVIDER_ENDPOINTS'],
          matchBasis: 'path_shape',
          routeFamilyState: 'frontier',
        })
      : { providerServiceId: slots.providerServiceId };
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'PROVIDER_ENDPOINT_INDEX_EMPTY',
      frontierClass: 'TARGET',
      retryStrategy: 'deterministic',
      priority: 70,
      detail,
    });
    await appendProofStep(
      db,
      proofStateId,
      'matchAtomicTarget',
      'FAILED',
      { providerServiceId: slots.providerServiceId },
      { frontierReason: 'PROVIDER_ENDPOINT_INDEX_EMPTY' },
      'Provider service 하위의 endpoint 인덱스가 비어 있습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 6, 'PROVIDER_ENDPOINT_INDEX_EMPTY');
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'PROVIDER_ENDPOINT_INDEX_EMPTY',
      targetObjectId: null,
      relationType: null,
    };
  }

  const targetEndpointRecords = resolverContext
    ? (slots.providerServiceId ? (resolverContext.endpointRecordsByServiceId.get(slots.providerServiceId) ?? []) : [])
    : providerEndpoints
      .map((endpoint) => ({ endpoint, match: getEndpointMethodPath(endpoint) }))
      .filter((row) => row.match.method !== null && row.match.path !== null);

  if (!slots.methodResolved) {
    if (routeFamilyIntent) {
      const pathOnlyMatches = targetEndpointRecords.filter((row) =>
        isRouteFamilyEndpointReachable(
          routeScopeKind,
          slots.routeFamilyCompositionPaths.length > 0 ? slots.routeFamilyCompositionPaths : slots.internalPathResolved!,
          row.match.path!,
        ),
      );
      const endpointHintId = acceptedPatchHints.endpointHintId;
      const hintedRouteFamilyMatches = endpointHintId
        ? pathOnlyMatches.filter((row) => row.endpoint.id === endpointHintId)
        : [];
      const selectedRouteFamilyMatches = hintedRouteFamilyMatches.length > 0
        ? hintedRouteFamilyMatches
        : pathOnlyMatches;
      const matchBasis: EndpointCandidateSetDetail['matchBasis'] =
        routeScopeKind === 'exact' ? 'route_exact' : 'route_prefix';

      await appendProofStep(
        db,
        proofStateId,
        'deriveReachableEndpointSet',
        'APPLIED',
        { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
        buildRouteFamilyDetail({
          providerServiceId: slots.providerServiceId,
          internalPathResolved: slots.internalPathResolved,
          routeChain: slots.routeChain,
          candidateObjectIds: pathOnlyMatches.map((row) => row.endpoint.id),
          compositionPaths: slots.routeFamilyCompositionPaths,
          candidateEndpointPaths: pathOnlyMatches.map((row) => normalizePath(row.match.path!)),
          filteredOutReasons: pathOnlyMatches.length === 0 ? ['FAMILY_PREFIX_NOT_COMPOSED'] : [],
          matchBasis,
          routeFamilyState: pathOnlyMatches.length > 0 ? 'derived_children' : 'frontier',
          endpointHintId,
        }),
        'Config-only gateway route에서 도달 가능한 endpoint 집합을 계산했습니다.',
      );

      const selectedRouteFamilyPathKeys = new Set(
        selectedRouteFamilyMatches.map((row) => normalizePath(row.match.path!)),
      );
      const hasDistinctRouteFamilyChildren =
        selectedRouteFamilyMatches.length > 0
        && selectedRouteFamilyPathKeys.size === selectedRouteFamilyMatches.length;

      if (selectedRouteFamilyMatches.length === 1) {
        const targetEndpoint = selectedRouteFamilyMatches[0]!.endpoint;
        await appendProofStep(
          db,
          proofStateId,
          'matchAtomicTarget',
          'APPLIED',
          { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
          { targetObjectId: targetEndpoint.id, methodResolution: 'path_only_route_family' },
          'Config-only gateway route를 path-only endpoint target으로 매칭했습니다.',
        );
        return projectRouteFamilyChildProofs(db, {
          workspaceId,
          intent,
          rootProofStateId: proofStateId,
          targetObjectIds: [targetEndpoint.id],
          matchBasis,
          slots,
          confidence: 0.72,
          proofConfidenceProfile: resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE,
        });
      }

      if (selectedRouteFamilyMatches.length === 0) {
        const frontierReason = pathOnlyMatches.length === 0
          ? 'ROUTE_FAMILY_DERIVATION_EMPTY'
          : 'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED';
        const detail = buildRouteFamilyDetail({
          providerServiceId: slots.providerServiceId,
          internalPathResolved: slots.internalPathResolved,
          routeChain: slots.routeChain,
          candidateObjectIds: pathOnlyMatches.map((row) => row.endpoint.id),
          compositionPaths: slots.routeFamilyCompositionPaths,
          candidateEndpointPaths: pathOnlyMatches.map((row) => normalizePath(row.match.path!)),
          filteredOutReasons: pathOnlyMatches.length === 0 ? ['FAMILY_PREFIX_NOT_COMPOSED'] : [],
          matchBasis,
          routeFamilyState: 'frontier',
          endpointHintId,
        });
        await updateProofStateContext(db, proofStateId, {
          slotState: {
            hostHints: slots.hostHints,
            configKeys: slots.configKeys,
            endpointCandidateSet: detail['endpointCandidateSet'],
            routeFamilyState: detail['routeFamilyState'],
            routeFamilyCompositionPaths: detail['compositionPaths'],
          },
        });
        await setFrontier(db, {
          workspaceId,
          proofStateId,
          frontierReason,
          frontierClass: 'ROUTE',
          retryStrategy: 'agent_patch',
          priority: 85,
          detail,
        });
        await appendProofStep(
          db,
          proofStateId,
          'spawnEndpointScopedChildProofs',
          'FAILED',
          { endpointCandidateSet: pathOnlyMatches.map((row) => row.endpoint.id), endpointHintId },
          { frontierReason },
          'Route-family endpoint 집합에서 유효한 child proof를 만들지 못했습니다.',
        );
        await appendProofStep(
          db,
          proofStateId,
          'matchAtomicTarget',
          'FAILED',
          { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
          { frontierReason },
          'Config-only gateway route를 atomic endpoint까지 좁히지 못했습니다.',
        );
        await appendSkippedHttpSteps(db, proofStateId, 6, frontierReason);
        return {
          proofStateId,
          status: 'FRONTIER',
          frontierReason,
          targetObjectId: null,
          relationType: null,
        };
      }

      if (hasDistinctRouteFamilyChildren) {
        const targetObjectIds = selectedRouteFamilyMatches.map((row) => row.endpoint.id);
        await appendProofStep(
          db,
          proofStateId,
          'matchAtomicTarget',
          'APPLIED',
          { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
          { targetObjectIds, methodResolution: 'path_only_route_family_family' },
          'Config-only gateway route를 bounded endpoint family로 파생했습니다.',
        );
        return projectRouteFamilyChildProofs(db, {
          workspaceId,
          intent,
          rootProofStateId: proofStateId,
          targetObjectIds,
          matchBasis,
          slots,
          confidence: 0.72,
          proofConfidenceProfile: resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE,
        });
      }

      const frontierReason = selectedRouteFamilyMatches.length === targetEndpointRecords.length
        ? 'ROUTE_FAMILY_TOO_BROAD'
        : 'ENDPOINT_SET_OPEN';
      const detail = buildRouteFamilyDetail({
        providerServiceId: slots.providerServiceId,
        internalPathResolved: slots.internalPathResolved,
        routeChain: slots.routeChain,
        candidateObjectIds: selectedRouteFamilyMatches.map((row) => row.endpoint.id),
        compositionPaths: slots.routeFamilyCompositionPaths,
        candidateEndpointPaths: selectedRouteFamilyMatches.map((row) => normalizePath(row.match.path!)),
        matchBasis,
        routeFamilyState: 'frontier',
        endpointHintId,
      });
      await updateProofStateContext(db, proofStateId, {
        slotState: {
          hostHints: slots.hostHints,
          configKeys: slots.configKeys,
          endpointCandidateSet: detail['endpointCandidateSet'],
          routeFamilyState: detail['routeFamilyState'],
          routeFamilyCompositionPaths: detail['compositionPaths'],
        },
      });
      await setFrontier(db, {
        workspaceId,
        proofStateId,
        frontierReason,
        frontierClass: 'TARGET',
        retryStrategy: 'manual_review',
        priority: frontierReason === 'ROUTE_FAMILY_TOO_BROAD' ? 90 : 88,
        ambiguityCount: selectedRouteFamilyMatches.length,
        detail,
      });
      await appendProofStep(
        db,
        proofStateId,
        'spawnEndpointScopedChildProofs',
        'FAILED',
        { endpointCandidateSet: selectedRouteFamilyMatches.map((row) => row.endpoint.id), endpointHintId },
        { frontierReason },
        'Route-family endpoint 집합이 단일 child proof로 닫히지 않았습니다.',
      );
      await appendProofStep(
        db,
        proofStateId,
        'matchAtomicTarget',
        'FAILED',
        { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
        { frontierReason, candidateObjectIds: selectedRouteFamilyMatches.map((row) => row.endpoint.id) },
        'Config-only gateway route는 endpoint set frontier로 유지됩니다.',
      );
      await appendSkippedHttpSteps(db, proofStateId, 6, frontierReason);
      return {
        proofStateId,
        status: 'FRONTIER',
        frontierReason,
        targetObjectId: null,
        relationType: null,
      };
    }

    await updateProofStateContext(db, proofStateId, {
      providerServiceId: slots.providerServiceId,
      slotState: {
        hostHints: slots.hostHints,
        configKeys: slots.configKeys,
      },
    });
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'METHOD_UNKNOWN',
      frontierClass: 'METHOD_PATH',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: { methodHint: intent.methodHint, outboundHttp: summaryHttp },
    });
    await appendProofStep(
      db,
      proofStateId,
      'matchAtomicTarget',
      'FAILED',
      { externalPathResolved: slots.externalPathResolved, internalPathResolved: slots.internalPathResolved },
      { frontierReason: 'METHOD_UNKNOWN' },
      'HTTP method를 결정하지 못했습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 6, 'METHOD_UNKNOWN');
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'METHOD_UNKNOWN',
      targetObjectId: null,
      relationType: null,
    };
  }

  const routeFamilyMethodMatches = routeFamilyIntent
    ? targetEndpointRecords.filter(
        (row) =>
          isMethodCompatible(slots.methodResolved!, row.match.method)
          && isRouteFamilyEndpointReachable(
            routeScopeKind,
            slots.routeFamilyCompositionPaths.length > 0 ? slots.routeFamilyCompositionPaths : slots.internalPathResolved!,
            row.match.path!,
          ),
      )
    : [];
  const exactMatches = routeFamilyIntent
    ? routeFamilyMethodMatches
    : targetEndpointRecords.filter(
        (row) =>
          isMethodCompatible(slots.methodResolved!, row.match.method)
          && normalizePath(row.match.path!) === slots.internalPathResolved,
      );
  const compatibleMatches = routeFamilyIntent
    ? routeFamilyMethodMatches
    : (
      exactMatches.length > 0
        ? exactMatches
        : targetEndpointRecords.filter(
            (row) =>
              isMethodCompatible(slots.methodResolved!, row.match.method)
              && computeEndpointPathCompatibilityScore(slots.internalPathResolved!, row.match.path!) >= 0.75,
          )
    );

  const endpointHintId = acceptedPatchHints.endpointHintId;
  const hintedMatches = endpointHintId
    ? compatibleMatches.filter((row) => row.endpoint.id === endpointHintId)
    : [];
  const selectedMatches = hintedMatches.length > 0 ? hintedMatches : compatibleMatches;

  if (selectedMatches.length === 0) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'PROVIDER_ENDPOINT_NOT_FOUND',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        providerServiceId: slots.providerServiceId,
        methodResolved: slots.methodResolved,
        internalPathResolved: slots.internalPathResolved,
        rejectedEndpointCandidates: targetEndpointRecords.map((row) => ({
          endpointId: row.endpoint.id,
          endpointMethod: row.match.method,
          endpointPath: row.match.path,
          methodCompatible: isMethodCompatible(slots.methodResolved!, row.match.method),
          pathCompatibilityScore: row.match.path
            ? computeEndpointPathCompatibilityScore(slots.internalPathResolved!, row.match.path)
            : 0,
        })),
      },
    });
    await appendProofStep(
      db,
      proofStateId,
      'matchAtomicTarget',
      'FAILED',
      { methodResolved: slots.methodResolved, internalPathResolved: slots.internalPathResolved },
      { frontierReason: 'PROVIDER_ENDPOINT_NOT_FOUND' },
      '단일 provider endpoint를 찾지 못했습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 6, 'PROVIDER_ENDPOINT_NOT_FOUND');
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'PROVIDER_ENDPOINT_NOT_FOUND',
      targetObjectId: null,
      relationType: null,
    };
  }

  const routeFamilyPathKeys = new Set(selectedMatches.map((row) => normalizePath(row.match.path!)));
  const canDeriveRouteFamilyChildren =
    routeFamilyIntent
    && selectedMatches.length > 1
    && routeFamilyPathKeys.size === selectedMatches.length;

  if (canDeriveRouteFamilyChildren) {
    await updateProofStateContext(db, proofStateId, {
      providerServiceId: slots.providerServiceId,
      methodResolved: slots.methodResolved,
      externalPathResolved: slots.externalPathResolved,
      internalPathResolved: slots.internalPathResolved,
      routeChain: slots.routeChain,
      ambiguityCount: 0,
      contradictionCount: 0,
    });
    await appendProofStep(
      db,
      proofStateId,
      'validateContradictionsAndAmbiguity',
      'APPLIED',
      { contradictionReasons: slots.contradictionReasons },
      { targetObjectIds: selectedMatches.map((row) => row.endpoint.id) },
      'Contradiction/ambiguity 검증을 통과했고 bounded endpoint family derivation이 가능합니다.',
    );
    await appendProofStep(
      db,
      proofStateId,
      'deriveReachableEndpointSet',
      'APPLIED',
      { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
      buildRouteFamilyDetail({
        providerServiceId: slots.providerServiceId,
        internalPathResolved: slots.internalPathResolved,
        routeChain: slots.routeChain,
        candidateObjectIds: selectedMatches.map((row) => row.endpoint.id),
        compositionPaths: slots.routeFamilyCompositionPaths,
        candidateEndpointPaths: selectedMatches.map((row) => normalizePath(row.match.path!)),
        matchBasis: routeFamilyIntent && routeScopeKind !== 'exact' ? 'route_prefix' : 'method_exact',
        routeFamilyState: 'derived_children',
        endpointHintId,
      }),
      'Route-family root proof에서 bounded endpoint family를 child proof로 전개했습니다.',
    );
    return projectRouteFamilyChildProofs(db, {
      workspaceId,
      intent,
      rootProofStateId: proofStateId,
      targetObjectIds: selectedMatches.map((row) => row.endpoint.id),
      matchBasis: routeFamilyIntent && routeScopeKind !== 'exact' ? 'route_prefix' : 'method_exact',
      slots,
      confidence: summary?.confidence ?? 0.9,
      proofConfidenceProfile: resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE,
    });
  }

  if (selectedMatches.length > 1) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 95,
      ambiguityCount: compatibleMatches.length,
      detail: {
        providerServiceId: slots.providerServiceId,
        methodResolved: slots.methodResolved,
        internalPathResolved: slots.internalPathResolved,
        candidateObjectIds: selectedMatches.map((row) => row.endpoint.id),
      },
    });
    await appendProofStep(
      db,
      proofStateId,
      'matchAtomicTarget',
      'FAILED',
      { methodResolved: slots.methodResolved, internalPathResolved: slots.internalPathResolved },
      { candidateObjectIds: selectedMatches.map((row) => row.endpoint.id), endpointHintId },
      '복수 endpoint가 동일 점수로 매칭되어 frontier로 전이했습니다.',
    );
    await appendSkippedHttpSteps(db, proofStateId, 6, 'ENDPOINT_MATCH_AMBIGUOUS');
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    };
  }

  const targetEndpoint = selectedMatches[0]!.endpoint;
  await appendProofStep(
    db,
    proofStateId,
    'matchAtomicTarget',
    'APPLIED',
    { methodResolved: slots.methodResolved, internalPathResolved: slots.internalPathResolved },
    { targetObjectId: targetEndpoint.id },
    'Provider endpoint를 단일 atomic target으로 매칭했습니다.',
  );

  if (slots.unsupportedPattern) {
    slots.contradictionReasons.push('UNSUPPORTED_SUMMARY_CONFLICT');
  }
  if (slots.truncated && !summaryHttp) {
    slots.contradictionReasons.push('TRUNCATED_SUMMARY_CONFLICT');
  }

  if (slots.contradictionReasons.length > 0) {
    const rejectedReason = slots.contradictionReasons[0]!;
    await setRejected(db, {
      workspaceId,
      proofStateId,
      rejectedReason,
      contradictionCount: slots.contradictionReasons.length,
    });
    await appendProofStep(
      db,
      proofStateId,
      'validateContradictionsAndAmbiguity',
      'FAILED',
      { contradictionReasons: slots.contradictionReasons },
      { rejectedReason },
      '치명적 contradiction으로 proof를 거절했습니다.',
    );
    await appendProofStep(
      db,
      proofStateId,
      'projectCandidate',
      'SKIPPED',
      {},
      { reason: rejectedReason },
      'REJECTED proof는 relation candidate를 생성하지 않습니다.',
    );
    return {
      proofStateId,
      status: 'REJECTED',
      frontierReason: rejectedReason,
      targetObjectId: null,
      relationType: null,
    };
  }

  await updateProofStateContext(db, proofStateId, {
    providerServiceId: slots.providerServiceId,
    methodResolved: slots.methodResolved,
    externalPathResolved: slots.externalPathResolved,
    internalPathResolved: slots.internalPathResolved,
    routeChain: slots.routeChain,
    ambiguityCount: 0,
    contradictionCount: 0,
  });
  await appendProofStep(
    db,
    proofStateId,
    'validateContradictionsAndAmbiguity',
    'APPLIED',
    { contradictionReasons: slots.contradictionReasons },
    { targetObjectId: targetEndpoint.id },
    'Contradiction/ambiguity 검증을 통과했습니다.',
  );

  if (routeFamilyIntent) {
    await appendProofStep(
      db,
      proofStateId,
      'deriveReachableEndpointSet',
      'APPLIED',
      { internalPathResolved: slots.internalPathResolved, routeChain: slots.routeChain },
      buildRouteFamilyDetail({
        providerServiceId: slots.providerServiceId,
        internalPathResolved: slots.internalPathResolved,
        routeChain: slots.routeChain,
        candidateObjectIds: selectedMatches.map((row) => row.endpoint.id),
        compositionPaths: slots.routeFamilyCompositionPaths,
        candidateEndpointPaths: selectedMatches.map((row) => normalizePath(row.match.path!)),
        matchBasis: routeFamilyIntent && routeScopeKind !== 'exact' ? 'route_prefix' : 'method_exact',
        routeFamilyState: 'derived_children',
        endpointHintId,
      }),
      'Route-family root proof에서 endpoint-scoped child proof 후보를 계산했습니다.',
    );
    return projectRouteFamilyChildProofs(db, {
      workspaceId,
      intent,
      rootProofStateId: proofStateId,
      targetObjectIds: [targetEndpoint.id],
      matchBasis: routeFamilyIntent && routeScopeKind !== 'exact' ? 'route_prefix' : 'method_exact',
      slots,
      confidence: summary?.confidence ?? 0.9,
      proofConfidenceProfile: resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE,
    });
  }

  const proofConfidenceProfile = resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE;
  const httpConfidenceBreakdown = buildProofConfidenceBreakdown({
    profile: proofConfidenceProfile,
    summaryQuality: summary?.confidence ?? 0.4,
    slotCompleteness: computeHttpSlotCompleteness({
      slotWeights: proofConfidenceProfile.slotWeights.http,
      methodResolved: slots.methodResolved,
      externalPathResolved: slots.externalPathResolved,
      internalPathResolved: slots.internalPathResolved,
      providerServiceId: slots.providerServiceId,
      targetObjectId: targetEndpoint.id,
    }),
    corroborationSignals:
      Number(summary !== null)
      + Number(bindingMatches.length > 0)
      + Number(slots.routeChain.length > 0)
      + Number(endpointHintId !== null),
    matchSpecificity: exactMatches.length > 0 ? 0.2 : 0.12,
    contradictionCount: slots.contradictionReasons.length,
    extraPenalty: Number(slots.unsupportedPattern) * 0.15 + Number(slots.truncated && !summaryHttp) * 0.1,
    status: 'CLOSED_ATOMIC',
  });
  await closeProof(db, {
    workspaceId,
    proofStateId,
    proofType: 'http_call',
    consumerServiceId: intent.sourceServiceId,
    targetObjectId: targetEndpoint.id,
    targetObjectType: 'api_endpoint',
    relationType: 'call',
    confidence: httpConfidenceBreakdown.finalConfidence,
    confidenceBreakdown: httpConfidenceBreakdown,
  });
  await appendProofStep(
    db,
    proofStateId,
    'projectCandidate',
    'APPLIED',
    { targetObjectId: targetEndpoint.id },
    { relationType: 'call', confidenceBreakdown: httpConfidenceBreakdown },
    'CLOSED_ATOMIC proof를 relation candidate로 projection했습니다.',
  );

  return {
    proofStateId,
    status: 'CLOSED_ATOMIC',
    frontierReason: null,
    targetObjectId: targetEndpoint.id,
    relationType: 'call',
  };
}

async function resolveDbIntent(
  db: DbClient,
  workspaceId: string,
  intent: typeof interactionIntents.$inferSelect,
  proofStateId: string,
  summary: typeof functionSummaries.$inferSelect | null,
  resolverContext?: IntentProofResolverContext,
): Promise<ProofResolutionResult> {
  const proofConfidenceProfile = resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE;
  const outboundDb = asRecord(summary?.outboundDb);
  const summaryFlags = asRecord(summary?.flags);
  const actionHint = asString(intent.methodHint) ?? asString(outboundDb?.['action']);
  const relationType = inferDbRelationType(actionHint);
  const connectionHints = [...new Set([
    asString(intent.hostHint),
    ...asStringArray(intent.configKeys),
    asString(outboundDb?.['connectionAlias']),
    asString(outboundDb?.['datasource']),
    asString(outboundDb?.['datasourceAlias']),
    ...asStringArray(summary?.aliasHints),
  ].filter((entry): entry is string => entry !== null))];
  const dbConfigBindingBundle = buildConfigBindingContext({
    configKeys: connectionHints,
    aliasHints: [asString(intent.hostHint), ...asStringArray(summary?.aliasHints)].filter((entry): entry is string => entry !== null),
  });
  const enrichedConnectionHints = uniqueSortedStrings([
    ...connectionHints,
    ...dbConfigBindingBundle.descriptors.flatMap((binding) => binding.hostHints),
    ...dbConfigBindingBundle.descriptors.flatMap((binding) => binding.portHints),
  ]);
  const resourceHintRaw =
    asString(intent.resourceHint)
    ?? asString(outboundDb?.['table'])
    ?? asString(outboundDb?.['tableName']);
  const schemaHint =
    asString(outboundDb?.['schema']) ?? (resourceHintRaw?.includes('.') ? resourceHintRaw.split('.')[0] ?? null : null);
  const tableHint = resourceHintRaw?.includes('.') ? (resourceHintRaw.split('.').at(-1) ?? null) : resourceHintRaw;
  const contradictionReasons = buildDbContradictionReasons({
    intent,
    outboundDb,
    summaryFlags,
    resolvedSchemaHint: schemaHint,
    resolvedTableHint: tableHint,
  });

  await appendProofStep(
    db,
      proofStateId,
      'hydrate_summary',
      'APPLIED',
      { intentId: intent.id },
      {
        actionHint,
        schemaHint,
        tableHint,
        connectionHints: enrichedConnectionHints,
        portHints: uniqueSortedStrings(dbConfigBindingBundle.descriptors.flatMap((binding) => binding.portHints)),
        configBindingSummary: dbConfigBindingBundle.summary,
        configBindingUnresolvedReasons: dbConfigBindingBundle.unresolved.map((entry) => entry.reason),
        extractionStrategy: summary?.extractionStrategy ?? null,
        summaryCompleteness: summary?.summaryCompleteness ?? null,
        signalSources: asStringArray(summary?.signalSources),
      },
      'DB intent 슬롯을 요약과 hint로 보강했습니다.',
    );

  const activeDbBindings = await db
    .select()
    .from(aliasBindings)
    .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.status, 'ACTIVE')));
  const dbBindingMatches = findMatchingAliasBindings(activeDbBindings, enrichedConnectionHints);
  await appendProofStep(
    db,
    proofStateId,
    'resolve_datasource_schema',
    dbBindingMatches.length > 0 ? 'APPLIED' : 'SKIPPED',
    { connectionHints: enrichedConnectionHints, portHints: uniqueSortedStrings(dbConfigBindingBundle.descriptors.flatMap((binding) => binding.portHints)) },
    {
      resolvedServiceIds: dbBindingMatches.map((binding) => binding.resolvedServiceId).filter((entry) => entry !== null),
      resolvedHosts: dbBindingMatches.map((binding) => binding.resolvedHost).filter((entry) => entry !== null),
    },
    dbBindingMatches.length > 0
      ? 'DB datasource alias를 alias binding으로 해석했습니다.'
      : 'DB datasource alias 해석에 사용할 binding이 없습니다.',
  );

  if (!relationType || !tableHint) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: !relationType ? 'DB_ACTION_UNKNOWN' : 'DB_TABLE_UNRESOLVED',
      frontierClass: !relationType ? 'SUMMARY' : 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: { actionHint, schemaHint, tableHint },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: !relationType ? 'DB_ACTION_UNKNOWN' : 'DB_TABLE_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    };
  }

  const dbTableObjects = resolverContext
    ? resolverContext.dbTableObjects
    : await db
      .select()
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'db_table')));
  const databaseIndexRecords = resolverContext
    ? resolverContext.databaseIndexRecords
    : (
      await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'database')))
    ).map((database) => ({
      database,
      tokens: collectDatabaseTokens(database),
    }));
  const narrowedDatabaseIds = new Set<string>();
  for (const binding of dbBindingMatches) {
    for (const databaseRecord of databaseIndexRecords) {
      if (
        (binding.resolvedServiceId && databaseRecord.tokens.has(normalizeLookupToken(binding.resolvedServiceId)))
        || (binding.resolvedHost && databaseRecord.tokens.has(normalizeLookupToken(binding.resolvedHost)))
      ) {
        narrowedDatabaseIds.add(databaseRecord.database.id);
      }
    }
  }
  const candidateTables = narrowedDatabaseIds.size > 0
    ? dbTableObjects.filter((row) => row.parentId !== null && narrowedDatabaseIds.has(row.parentId))
    : dbTableObjects;
  const normalizedTableHint = tableHint.toLowerCase();
  const matchingTables = candidateTables.filter((row) => row.name.trim().toLowerCase() === normalizedTableHint);
  const exactSchemaMatches = schemaHint
    ? matchingTables.filter((row) => asString(asRecord(row.metadata)?.['schema'])?.toLowerCase() === schemaHint.toLowerCase())
    : matchingTables;

  if (schemaHint === null && matchingTables.length > 1) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'DB_SCHEMA_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'manual_review',
      priority: 100,
      detail: { tableHint, candidateObjectIds: matchingTables.map((row) => row.id) },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'DB_SCHEMA_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    };
  }

  if (exactSchemaMatches.length === 0) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'DB_TABLE_UNRESOLVED',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: { tableHint, schemaHint },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'DB_TABLE_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    };
  }

  if (exactSchemaMatches.length > 1) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'TABLE_MATCH_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'manual_review',
      priority: 90,
      detail: { tableHint, schemaHint, candidateObjectIds: exactSchemaMatches.map((row) => row.id) },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'TABLE_MATCH_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    };
  }

  const target = exactSchemaMatches[0]!;
  await appendProofStep(
    db,
    proofStateId,
    'match_db_table',
    'APPLIED',
    { tableHint, schemaHint },
    { targetObjectId: target.id },
    'DB table과 intent를 단일 target으로 매칭했습니다.',
  );
  if (contradictionReasons.length > 0) {
    const rejectedReason = contradictionReasons[0]!;
    await setRejected(db, {
      workspaceId,
      proofStateId,
      rejectedReason,
      contradictionCount: contradictionReasons.length,
      detail: { contradictionReasons },
    });
    await appendProofStep(
      db,
      proofStateId,
      'validate_db_contradictions',
      'FAILED',
      { schemaHint, tableHint, contradictionReasons },
      { rejectedReason },
      'DB contradiction 검증에서 proof를 거절했습니다.',
    );
    return {
      proofStateId,
      status: 'REJECTED',
      frontierReason: rejectedReason,
      targetObjectId: null,
      relationType: null,
    };
  }
  await appendProofStep(
    db,
    proofStateId,
    'validate_db_contradictions',
    'APPLIED',
    { schemaHint, tableHint, contradictionReasons },
    { targetObjectId: target.id },
    'DB contradiction 검증을 통과했습니다.',
  );
  const dbConfidenceBreakdown = buildProofConfidenceBreakdown({
    profile: proofConfidenceProfile,
    summaryQuality: summary?.confidence ?? 0.4,
    slotCompleteness: computeDbSlotCompleteness({
      slotWeights: proofConfidenceProfile.slotWeights.db,
      actionHint,
      tableHint,
      schemaHint,
      datasourceResolved: dbBindingMatches.length > 0,
      targetObjectId: target.id,
    }),
    corroborationSignals: Number(summary !== null) + Number(dbBindingMatches.length > 0) + Number(schemaHint !== null),
    matchSpecificity: exactSchemaMatches.length === 1 ? 0.18 : 0.1,
    contradictionCount: contradictionReasons.length,
    status: 'CLOSED_ATOMIC',
  });
  await closeProof(db, {
    workspaceId,
    proofStateId,
    proofType: 'db_access',
    consumerServiceId: intent.sourceServiceId,
    targetObjectId: target.id,
    targetObjectType: 'db_table',
    relationType,
    confidence: dbConfidenceBreakdown.finalConfidence,
    confidenceBreakdown: dbConfidenceBreakdown,
  });
  await appendProofStep(
    db,
    proofStateId,
    'projectCandidate',
    'APPLIED',
    { targetObjectId: target.id },
    { relationType, confidenceBreakdown: dbConfidenceBreakdown },
    'CLOSED_ATOMIC DB proof를 relation candidate로 projection했습니다.',
  );
  return {
    proofStateId,
    status: 'CLOSED_ATOMIC',
    frontierReason: null,
    targetObjectId: target.id,
    relationType,
  };
}

async function resolveMessageIntent(
  db: DbClient,
  workspaceId: string,
  intent: typeof interactionIntents.$inferSelect,
  proofStateId: string,
  summary: typeof functionSummaries.$inferSelect | null,
  resolverContext?: IntentProofResolverContext,
): Promise<ProofResolutionResult> {
  const proofConfidenceProfile = resolverContext?.proofConfidenceProfile ?? DEFAULT_PROOF_CONFIDENCE_PROFILE;
  const outboundMessage = asRecord(summary?.outboundMessage);
  const brokerHints = [...new Set([
    asString(intent.hostHint),
    ...asStringArray(intent.configKeys),
    asString(outboundMessage?.['broker']),
    asString(outboundMessage?.['brokerAlias']),
    asString(outboundMessage?.['bootstrapServers']),
    ...asStringArray(summary?.aliasHints),
  ].filter((entry): entry is string => entry !== null))];
  const channelHint =
    asString(intent.resourceHint)
    ?? asString(outboundMessage?.['topic'])
    ?? asString(outboundMessage?.['queue'])
    ?? asString(outboundMessage?.['name']);
  const objectType = messageObjectTypeFromSummary(outboundMessage) ?? 'topic';
  const channelBindingKey = objectType === 'queue' ? 'message.queue' : 'message.topic';
  const messageConfigBindingBundle = buildConfigBindingContext({
    configKeys: brokerHints,
    aliasHints: [asString(intent.hostHint), ...asStringArray(summary?.aliasHints)].filter((entry): entry is string => entry !== null),
  });
  const messageChannelBundle = mergeConfigBindingBundles(
    messageConfigBindingBundle,
    describeConfigEntries(
      uniqueSortedStrings([
        channelHint,
        asString(outboundMessage?.['topic']),
        asString(outboundMessage?.['queue']),
        asString(outboundMessage?.['name']),
      ]).map((value) => ({
        key: channelBindingKey,
        value,
        sourceType: 'other' as const,
        filePath: DERIVED_MESSAGE_BINDING_FILE_PATH,
      })),
    ),
  );
  const enrichedBrokerHints = uniqueSortedStrings([
    ...brokerHints,
    ...messageChannelBundle.descriptors.flatMap((binding) => binding.hostHints),
    ...messageChannelBundle.descriptors.flatMap((binding) => binding.portHints),
    ...messageChannelBundle.descriptors.flatMap((binding) => binding.messageTopicHints),
    ...messageChannelBundle.descriptors.flatMap((binding) => binding.messageQueueHints),
  ]);
  const relationType = normalizeIntentType(intent.intentType) === 'message_consume' ? 'consume' : 'produce';

  await appendProofStep(
    db,
    proofStateId,
    'hydrate_summary',
    'APPLIED',
    { intentId: intent.id },
    {
      channelHint,
      objectType,
      brokerHints: enrichedBrokerHints,
      portHints: uniqueSortedStrings(messageChannelBundle.descriptors.flatMap((binding) => binding.portHints)),
      configBindingSummary: messageChannelBundle.summary,
      configBindingUnresolvedReasons: messageChannelBundle.unresolved.map((entry) => entry.reason),
      extractionStrategy: summary?.extractionStrategy ?? null,
      summaryCompleteness: summary?.summaryCompleteness ?? null,
      signalSources: asStringArray(summary?.signalSources),
    },
    '메시지 intent 슬롯을 요약과 hint로 보강했습니다.',
  );

  const activeBrokerBindings = await db
    .select()
    .from(aliasBindings)
    .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.status, 'ACTIVE')));
  const brokerBindingMatches = findMatchingAliasBindings(activeBrokerBindings, enrichedBrokerHints);
  await appendProofStep(
    db,
    proofStateId,
    'resolve_broker_binding',
    brokerBindingMatches.length > 0 ? 'APPLIED' : 'SKIPPED',
    { brokerHints: enrichedBrokerHints, portHints: uniqueSortedStrings(messageChannelBundle.descriptors.flatMap((binding) => binding.portHints)) },
    {
      resolvedServiceIds: brokerBindingMatches.map((binding) => binding.resolvedServiceId).filter((entry) => entry !== null),
      resolvedHosts: brokerBindingMatches.map((binding) => binding.resolvedHost).filter((entry) => entry !== null),
    },
    brokerBindingMatches.length > 0
      ? '메시지 broker alias를 alias binding으로 해석했습니다.'
      : '메시지 broker alias 해석에 사용할 binding이 없습니다.',
  );

  if (!channelHint) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'MESSAGE_TARGET_UNRESOLVED',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        objectType,
        portHints: uniqueSortedStrings(messageChannelBundle.descriptors.flatMap((binding) => binding.portHints)),
      },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'MESSAGE_TARGET_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    };
  }

  const candidateObjects = resolverContext
    ? (resolverContext.channelObjectsByType.get(objectType) ?? [])
    : await db
      .select()
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, objectType)));
  const channelIndexRecords = resolverContext
    ? (resolverContext.channelIndexRecordsByType.get(objectType) ?? [])
    : candidateObjects.map((channel) => ({
      channel,
      tokens: collectChannelTokens(channel),
    }));
  const narrowedChannelIds = new Set<string>();
  for (const binding of brokerBindingMatches) {
    for (const channelRecord of channelIndexRecords) {
      if (
        (binding.resolvedServiceId && channelRecord.tokens.has(normalizeLookupToken(binding.resolvedServiceId)))
        || (binding.resolvedHost && channelRecord.tokens.has(normalizeLookupToken(binding.resolvedHost)))
      ) {
        narrowedChannelIds.add(channelRecord.channel.id);
      }
    }
  }
  const candidateChannels = narrowedChannelIds.size > 0
    ? candidateObjects.filter((row) => narrowedChannelIds.has(row.id))
    : candidateObjects;
  const matches = candidateChannels.filter((row) => {
    const metadata = asRecord(row.metadata);
    const objectName = row.name.trim().toLowerCase();
    const normalizedHint = channelHint.toLowerCase();
    return objectName === normalizedHint
      || asString(metadata?.['topic'])?.toLowerCase() === normalizedHint
      || asString(metadata?.['queue'])?.toLowerCase() === normalizedHint
      || asString(metadata?.['name'])?.toLowerCase() === normalizedHint;
  });

  if (matches.length === 0) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'MESSAGE_TARGET_UNRESOLVED',
      frontierClass: 'TARGET',
      retryStrategy: 'agent_patch',
      priority: 80,
      detail: {
        channelHint,
        objectType,
        portHints: uniqueSortedStrings(messageChannelBundle.descriptors.flatMap((binding) => binding.portHints)),
      },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'MESSAGE_TARGET_UNRESOLVED',
      targetObjectId: null,
      relationType: null,
    };
  }

  if (matches.length > 1) {
    await setFrontier(db, {
      workspaceId,
      proofStateId,
      frontierReason: 'TOPIC_MATCH_AMBIGUOUS',
      frontierClass: 'TARGET',
      retryStrategy: 'manual_review',
      priority: 90,
      detail: {
        channelHint,
        objectType,
        candidateObjectIds: matches.map((row) => row.id),
        portHints: uniqueSortedStrings(messageChannelBundle.descriptors.flatMap((binding) => binding.portHints)),
      },
    });
    return {
      proofStateId,
      status: 'FRONTIER',
      frontierReason: 'TOPIC_MATCH_AMBIGUOUS',
      targetObjectId: null,
      relationType: null,
    };
  }

  const target = matches[0]!;
  await appendProofStep(
    db,
    proofStateId,
    'match_message_target',
    'APPLIED',
    { channelHint, objectType },
    { targetObjectId: target.id },
    '메시지 topic/queue와 intent를 단일 target으로 매칭했습니다.',
  );
  const messageConfidenceBreakdown = buildProofConfidenceBreakdown({
    profile: proofConfidenceProfile,
    summaryQuality: summary?.confidence ?? 0.4,
    slotCompleteness: computeMessageSlotCompleteness({
      slotWeights: proofConfidenceProfile.slotWeights.message,
      channelHint,
      brokerResolved: brokerBindingMatches.length > 0,
      objectType,
      targetObjectId: target.id,
    }),
    corroborationSignals: Number(summary !== null) + Number(brokerBindingMatches.length > 0) + Number(channelHint !== null),
    matchSpecificity: matches.length === 1 ? 0.18 : 0.1,
    status: 'CLOSED_ATOMIC',
  });
  await closeProof(db, {
    workspaceId,
    proofStateId,
    proofType: normalizeIntentType(intent.intentType),
    consumerServiceId: intent.sourceServiceId,
    targetObjectId: target.id,
    targetObjectType: objectType,
    relationType,
    confidence: messageConfidenceBreakdown.finalConfidence,
    confidenceBreakdown: messageConfidenceBreakdown,
  });
  await appendProofStep(
    db,
    proofStateId,
    'projectCandidate',
    'APPLIED',
    { targetObjectId: target.id },
    { relationType, confidenceBreakdown: messageConfidenceBreakdown },
    'CLOSED_ATOMIC message proof를 relation candidate로 projection했습니다.',
  );
  return {
    proofStateId,
    status: 'CLOSED_ATOMIC',
    frontierReason: null,
    targetObjectId: target.id,
    relationType,
  };
}

export async function resolveInteractionIntentProof(
  db: DbClient,
  input: {
    workspaceId: string;
    intentId: string;
    resolverContext?: IntentProofResolverContext;
    workspaceIndex?: IntentProofResolverContext;
  },
): Promise<ProofResolutionResult> {
  const resolverContext =
    input.resolverContext
    ?? input.workspaceIndex
    ?? await buildIntentProofResolverContext(db, { workspaceId: input.workspaceId });
  const { intent, proofState } = await getIntentWithProofState(db, input.workspaceId, input.intentId);
  const proofStateId = await upsertProofStateBase(db, input.workspaceId, intent, proofState);
  const summary = await getActiveSummaryForIntent(db, input.workspaceId, intent);
  const acceptedPatchHints = await getAcceptedPatchHints(db, input.workspaceId, proofStateId);
  const normalizedType = normalizeIntentType(intent.intentType);

  await clearChildProofStates(db, input.workspaceId, proofStateId);
  await clearProofExecutionArtifacts(db, proofStateId, input.workspaceId);

  await db
    .update(interactionIntents)
    .set({
      status: 'RESOLVING',
      updatedAt: new Date(),
    })
    .where(eq(interactionIntents.id, intent.id));

  const result =
    normalizedType === 'http_gateway_route'
      ? await resolveHttpIntent(db, input.workspaceId, intent, proofStateId, summary, acceptedPatchHints, resolverContext)
      : normalizedType === 'http_call'
      ? await resolveHttpIntent(db, input.workspaceId, intent, proofStateId, summary, acceptedPatchHints, resolverContext)
      : normalizedType === 'db_access'
        ? await resolveDbIntent(db, input.workspaceId, intent, proofStateId, summary, resolverContext)
        : await resolveMessageIntent(db, input.workspaceId, intent, proofStateId, summary, resolverContext);

  const finalResult =
    result.status === 'CLOSED_ATOMIC' && acceptedPatchHints.contradictionChallengeReasons.length > 0
      ? await applyAcceptedContradictionChallenge(db, {
          workspaceId: input.workspaceId,
          proofStateId,
          contradictionChallengeReasons: acceptedPatchHints.contradictionChallengeReasons,
        })
      : result;

  await db
    .update(interactionIntents)
    .set({
      status: finalResult.status,
      updatedAt: new Date(),
    })
    .where(eq(interactionIntents.id, intent.id));

  await replaceProofDependencies(db, {
    workspaceId: input.workspaceId,
    proofStateId,
    intent,
    summary,
  });

  return finalResult;
}

export async function resolveWorkspaceInteractionIntents(
  db: DbClient,
  input: {
    workspaceId: string;
    concurrency?: number;
  },
): Promise<ProofResolutionResult[]> {
  const resolverContext = await buildIntentProofResolverContext(db, { workspaceId: input.workspaceId });
  const intents = await db
    .select({ id: interactionIntents.id })
    .from(interactionIntents)
    .where(eq(interactionIntents.workspaceId, input.workspaceId))
    .orderBy(asc(interactionIntents.createdAt), asc(interactionIntents.id));

  const maxConcurrency = normalizeIntentResolutionConcurrency(input.concurrency);
  const results: ProofResolutionResult[] = [];

  if (maxConcurrency === 1) {
    for (const intent of intents) {
      results.push(await resolveInteractionIntentProof(db, {
        workspaceId: input.workspaceId,
        intentId: intent.id,
        resolverContext,
      }));
    }
    return results;
  }

  const indexedIntents = intents.map((intent, index) => ({ index, intentId: intent.id }));
  const orderedResults = new Array<ProofResolutionResult>(indexedIntents.length);

  for (let batchStart = 0; batchStart < indexedIntents.length; batchStart += maxConcurrency) {
    const batch = indexedIntents.slice(batchStart, batchStart + maxConcurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ index, intentId }) => {
        const result = await resolveInteractionIntentProof(db, {
          workspaceId: input.workspaceId,
          intentId,
          resolverContext,
        });
        return { index, result };
      }),
    );
    for (const { index, result } of batchResults) {
      orderedResults[index] = result;
    }
  }

  return orderedResults;
}

export function normalizeIntentResolutionConcurrency(concurrency?: number): number {
  const requestedConcurrency =
    concurrency === undefined ? 1 : Math.max(1, Math.floor(concurrency));
  return Math.max(1, Math.min(requestedConcurrency, 8));
}

function validateProofPatchPayload(
  patchType: ProofPatchType,
  payload: JsonRecord,
): { status: ProofPatchValidationStatus; errors: string[] } {
  const errors: string[] = [];

  switch (patchType) {
    case 'alias_binding':
      if (!asString(payload['aliasKey'])) errors.push('aliasKey is required');
      if (!asString(payload['aliasValue'])) errors.push('aliasValue is required');
      if (!asString(payload['resolvedServiceId']) && !asString(payload['resolvedHost'])) {
        errors.push('resolvedServiceId or resolvedHost is required');
      }
      break;
    case 'function_summary_patch':
      if (!asString(payload['functionId'])) errors.push('functionId is required');
      if (!asRecord(payload['outboundHttp']) && !asRecord(payload['outboundDb']) && !asRecord(payload['outboundMessage'])) {
        errors.push('at least one outbound payload is required');
      }
      break;
    case 'route_transform_patch':
      if (!asString(payload['gatewayKind'])) errors.push('gatewayKind is required');
      if (!asString(payload['matchPath'])) errors.push('matchPath is required');
      if (!asString(payload['targetServiceHint']) && !asString(payload['targetHostAlias'])) {
        errors.push('targetServiceHint or targetHostAlias is required');
      }
      break;
    case 'endpoint_disambiguation':
      if (!asString(payload['endpointId']) && !asString(payload['targetObjectId'])) {
        errors.push('endpointId or targetObjectId is required');
      }
      break;
    case 'method_path_hint':
      if (!normalizeMethod(payload['method'])) errors.push('method is required');
      if (!asString(payload['externalPath'])) errors.push('externalPath is required');
      break;
    case 'provider_service_selection':
      if (!asString(payload['selectedServiceId'])) errors.push('selectedServiceId is required');
      break;
    case 'contradiction_challenge':
      if (asString(payload['expectedAction']) !== 'reopen_frontier') {
        errors.push('expectedAction must be reopen_frontier');
      }
      if (asStringArray(payload['challengeReasons']).length === 0) {
        errors.push('challengeReasons is required');
      }
      break;
  }

  return { status: errors.length === 0 ? 'ACCEPTED' : 'REJECTED', errors };
}

async function applyAcceptedPatch(
  db: DbClient,
  input: ValidateAndApplyProofPatchInput,
  payload: JsonRecord,
) {
  switch (input.patchType) {
    case 'alias_binding':
      await db.insert(aliasBindings).values({
        id: generateId(),
        workspaceId: input.workspaceId,
        createdRunId: normalizeOptionalUuid(input.runId),
        updatedRunId: normalizeOptionalUuid(input.runId),
        bindingKind: asString(payload['bindingKind']) ?? 'property_alias',
        ownerServiceId: asString(payload['ownerServiceId']),
        aliasKey: asString(payload['aliasKey'])!,
        aliasValue: asString(payload['aliasValue'])!,
        resolvedServiceId: asString(payload['resolvedServiceId']),
        resolvedHost: asString(payload['resolvedHost']),
        confidence: Number(payload['confidence'] ?? 0.8),
        sourceHash: buildAliasSourceHash(payload),
        evidenceIds: asStringArray(payload['evidenceIds']),
      });
      break;
    case 'function_summary_patch': {
      const functionId = asString(payload['functionId'])!;
      const existing = await db
        .select()
        .from(functionSummaries)
        .where(
          and(
            eq(functionSummaries.workspaceId, input.workspaceId),
            eq(functionSummaries.functionId, functionId),
            eq(functionSummaries.status, 'ACTIVE'),
          ),
        );
      const nextVersion = existing.reduce((max, row) => Math.max(max, row.summaryVersion), 0) + 1;
      for (const summary of existing) {
        await db
          .update(functionSummaries)
          .set({ status: 'SUPERSEDED', updatedAt: new Date() })
          .where(eq(functionSummaries.id, summary.id));
      }
      await db.insert(functionSummaries).values({
        id: generateId(),
        workspaceId: input.workspaceId,
        createdRunId: normalizeOptionalUuid(input.runId),
        updatedRunId: normalizeOptionalUuid(input.runId),
        functionId,
        serviceId:
          asString(payload['serviceId'])
          ?? existing[0]?.serviceId
          ?? (() => {
            throw new Error('serviceId is required for function_summary_patch');
          })(),
        summaryVersion: nextVersion,
        summaryKind: asString(payload['summaryKind']) ?? 'mixed',
        outboundHttp: asRecord(payload['outboundHttp']),
        outboundDb: asRecord(payload['outboundDb']),
        outboundMessage: asRecord(payload['outboundMessage']),
        callChainHints: asStringArray(payload['callChainHints']),
        aliasHints: asStringArray(payload['aliasHints']),
        signalSources: asStringArray(payload['signalSources']).length > 0
          ? asStringArray(payload['signalSources'])
          : ['manual_patch'],
        provenanceEvidenceIds: asStringArray(payload['provenanceEvidenceIds'] ?? payload['evidenceIds']),
        extractionStrategy:
          asString(payload['extractionStrategy']) ?? existing[0]?.extractionStrategy ?? 'legacy_edges_fallback',
        unresolvedReasons: asStringArray(payload['unresolvedReasons']),
        summaryCompleteness: Math.max(0, Math.min(1, asNumber(payload['summaryCompleteness']) ?? 0.6)),
        flags: asRecord(payload['flags']) ?? {},
        confidence: Number(payload['confidence'] ?? existing[0]?.confidence ?? 0.9),
        sourceHash: buildFunctionSummarySourceHash(payload),
      });
      break;
    }
    case 'route_transform_patch':
      await db.insert(routeTransforms).values({
        id: generateId(),
        workspaceId: input.workspaceId,
        createdRunId: normalizeOptionalUuid(input.runId),
        updatedRunId: normalizeOptionalUuid(input.runId),
        gatewayKind: asString(payload['gatewayKind'])!,
        ownerServiceId: asString(payload['ownerServiceId']),
        matchHost: asString(payload['matchHost']),
        matchPath: asString(payload['matchPath'])!,
        matchMode: asString(payload['matchMode']) ?? 'exact',
        stripPrefixCount: typeof payload['stripPrefixCount'] === 'number' ? payload['stripPrefixCount'] : null,
        prependPrefix: asString(payload['prependPrefix']),
        rewriteRegex: asString(payload['rewriteRegex']),
        rewriteReplacement: asString(payload['rewriteReplacement']),
        pathCapturePolicy: asString(payload['pathCapturePolicy']),
        routeMountPrefix: asString(payload['routeMountPrefix']),
        targetServiceHint: asString(payload['targetServiceHint']),
        targetHostAlias: asString(payload['targetHostAlias']),
        targetPathBaseHint: asString(payload['targetPathBaseHint']),
        priority: typeof payload['priority'] === 'number' ? payload['priority'] : 0,
        evidenceIds: asStringArray(payload['evidenceIds']),
        sourceHash: buildRouteTransformSourceHash(payload),
      });
      break;
    case 'endpoint_disambiguation':
      break;
    case 'method_path_hint':
      break;
    case 'provider_service_selection':
      break;
    case 'contradiction_challenge':
      break;
  }
}

export async function validateAndApplyProofPatch(
  db: DbClient,
  input: ValidateAndApplyProofPatchInput,
) {
  const payload = input.payload as JsonRecord;
  const validation = validateProofPatchPayload(input.patchType, payload);
  const deterministicErrors = validation.status === 'ACCEPTED'
    ? await validatePatchDeterministically(
        db,
        input.workspaceId,
        input.proofStateId,
        input.patchType,
        payload,
      )
    : [];
  const finalErrors = [...validation.errors, ...deterministicErrors];
  const finalStatus: ProofPatchValidationStatus = finalErrors.length === 0 ? 'ACCEPTED' : 'REJECTED';
  const applyMode = input.applyMode ?? 'apply';
  const storedStatus: ProofPatchValidationStatus =
    finalStatus === 'ACCEPTED' && applyMode === 'defer'
      ? 'PENDING'
      : finalStatus;
  const patchId = generateId();

  await db.insert(proofPatches).values({
    id: patchId,
    workspaceId: input.workspaceId,
    proofStateId: input.proofStateId,
    patchType: input.patchType,
    payload,
    sourceKind: input.sourceKind,
    validationStatus: storedStatus,
    evidenceIds: asStringArray(payload['evidenceIds']),
  });

  if (storedStatus === 'REJECTED' || storedStatus === 'PENDING') {
    await appendProofStep(
      db,
      input.proofStateId,
      'validate_patch',
      storedStatus === 'REJECTED' ? 'FAILED' : 'PENDING',
      { patchType: input.patchType },
      { errors: finalErrors },
      storedStatus === 'REJECTED' ? '유효하지 않은 patch를 거절했습니다.' : '수동 검토 대기 중인 patch를 저장했습니다.',
    );
    return { patchId, validationStatus: storedStatus, errors: finalErrors, resolution: null };
  }

  if (applyMode === 'defer' && finalStatus === 'ACCEPTED') {
    return { patchId, validationStatus: storedStatus, errors: finalErrors, resolution: null };
  }

  await applyAcceptedPatch(db, input, payload);
  const stateRows = await db
    .select()
    .from(proofStates)
    .where(eq(proofStates.id, input.proofStateId))
    .limit(1);
  const state = stateRows[0];
  if (!state) throw new Error(`proof state를 찾을 수 없습니다: ${input.proofStateId}`);

  const resolution = await resolveInteractionIntentProof(db, {
    workspaceId: input.workspaceId,
    intentId: state.intentId,
  });
  await appendProofStep(
    db,
    input.proofStateId,
    'apply_patch',
    'APPLIED',
    { patchType: input.patchType },
    { patchId },
    '허용된 patch를 저장하고 proof를 재평가했습니다.',
  );
  return { patchId, validationStatus: finalStatus, errors: finalErrors, resolution };
}
