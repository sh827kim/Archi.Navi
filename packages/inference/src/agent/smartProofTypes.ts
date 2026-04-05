export const SMART_FRONTIER_REASONS = [
  'HOST_ALIAS_UNRESOLVED',
  'CONFIG_BINDING_MISSING',
  'ROUTE_FAMILY_DERIVATION_EMPTY',
  'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED',
  'PROVIDER_SERVICE_AMBIGUOUS',
  'ENDPOINT_MATCH_AMBIGUOUS',
] as const;

export type SmartFrontierReason = (typeof SMART_FRONTIER_REASONS)[number];

export const SMART_FRONTIER_REASONS_SUPPORTED = [
  'HOST_ALIAS_UNRESOLVED',
  'CONFIG_BINDING_MISSING',
  'ROUTE_FAMILY_DERIVATION_EMPTY',
  'ROUTE_TO_ENDPOINT_COMPOSITION_FAILED',
] as const;

export type SupportedSmartFrontierReason = (typeof SMART_FRONTIER_REASONS_SUPPORTED)[number];

export interface SmartProofConfig {
  enabled: boolean;
  categories: {
    preResolutionEnhancement: boolean;
    frontierResolution: boolean;
    ambiguityResolution: boolean;
    crossProofCorrelation: boolean;
    contradictionDetection: boolean;
  };
  budget: {
    maxLlmCallsPerRun: number;
    maxLlmCallsPerIntent: number;
    maxInputTokensPerCall: number;
    maxTotalTokensPerRun: number;
  };
  thresholds: {
    autoAcceptConfidence: number;
    reviewConfidence: number;
    skipConfidence: number;
  };
  model?: string;
  temperature?: number;
}

export interface SmartModeSummary {
  enabled: boolean;
  llmCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  frontierResolvedByLlm: number;
  summaryEnhancedByLlm: number;
  contradictionsChallenged: number;
  autoAcceptedCount: number;
  pendingReviewCount: number;
  skippedCount: number;
  resolutionByCategory: Record<string, number>;
  resolutionByFrontierReason: Record<string, number>;
}

export interface SmartBudgetTrackerSnapshot {
  maxCalls: number;
  maxTokens: number;
  callsUsed: number;
  tokensUsed: number;
  estimatedCostUsd: number;
}

export interface SmartResolutionTokenUsage {
  input: number;
  output: number;
}

export type SmartProofDecision = 'ACCEPTED' | 'PENDING_REVIEW' | 'SKIPPED';

export interface SmartFrontierResolution {
  proofStateId: string;
  frontierReason: string;
  resolved: boolean;
  confidence: number;
  reasoning: string;
  decision: SmartProofDecision;
  llmCallId: string | null;
  patch: {
    patchType: string;
    payload: Record<string, unknown>;
    sourceKind: 'smart_agent';
  } | null;
  tokensUsed: SmartResolutionTokenUsage;
}

export function resolveSmartProofDecision(
  config: Pick<SmartProofConfig, 'thresholds'>,
  confidence: number,
): SmartProofDecision {
  if (confidence >= config.thresholds.autoAcceptConfidence) {
    return 'ACCEPTED';
  }
  if (confidence >= config.thresholds.reviewConfidence) {
    return 'PENDING_REVIEW';
  }
  return 'SKIPPED';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNumberInRange(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = asNumber(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asMaybeBoolean(value: unknown): boolean | null {
  return value === undefined ? null : value === true;
}

function normalizeSmartProofThresholds(
  input: unknown,
  defaults: SmartProofConfig['thresholds'],
): SmartProofConfig['thresholds'] {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const autoAccept = asNumberInRange(raw['autoAcceptConfidence'], 0, 1, defaults.autoAcceptConfidence);
  const reviewConfidence = asNumberInRange(
    raw['reviewConfidence'],
    0,
    autoAccept,
    Math.min(defaults.reviewConfidence, autoAccept),
  );
  const skipConfidence = asNumberInRange(
    raw['skipConfidence'],
    0,
    reviewConfidence,
    Math.min(defaults.skipConfidence, reviewConfidence),
  );

  return {
    autoAcceptConfidence: autoAccept,
    reviewConfidence,
    skipConfidence,
  };
}

export function buildDefaultSmartProofConfig(): SmartProofConfig {
  return {
    enabled: true,
    categories: {
      preResolutionEnhancement: false,
      frontierResolution: true,
      ambiguityResolution: false,
      crossProofCorrelation: false,
      contradictionDetection: false,
    },
    budget: {
      maxLlmCallsPerRun: 100,
      maxLlmCallsPerIntent: 5,
      maxInputTokensPerCall: 4000,
      maxTotalTokensPerRun: 500_000,
    },
    thresholds: {
      autoAcceptConfidence: 0.8,
      reviewConfidence: 0.5,
      skipConfidence: 0.3,
    },
    temperature: 0.1,
  };
}

export function normalizeSmartProofConfig(
  input?: boolean | SmartProofConfig | null,
): SmartProofConfig {
  if (input === true) {
    return buildDefaultSmartProofConfig();
  }

  if (!input || typeof input !== 'object') {
    return {
      ...buildDefaultSmartProofConfig(),
      enabled: false,
    };
  }

  const defaults = buildDefaultSmartProofConfig();
  const inputBudget = input.budget ?? {};
  const normalizedBudget = {
    ...defaults.budget,
    ...(inputBudget ?? {}),
    maxLlmCallsPerRun: asPositiveInteger(inputBudget.maxLlmCallsPerRun, defaults.budget.maxLlmCallsPerRun),
    maxLlmCallsPerIntent: asPositiveInteger(inputBudget.maxLlmCallsPerIntent, defaults.budget.maxLlmCallsPerIntent),
    maxInputTokensPerCall: asPositiveInteger(inputBudget.maxInputTokensPerCall, defaults.budget.maxInputTokensPerCall),
    maxTotalTokensPerRun: asPositiveInteger(inputBudget.maxTotalTokensPerRun, defaults.budget.maxTotalTokensPerRun),
  };
  const normalizedThresholds = normalizeSmartProofThresholds(input.thresholds, defaults.thresholds);
  const normalizedModel = asString(input.model);
  const defaultTemperature = typeof defaults.temperature === 'number' ? defaults.temperature : 0.1;
  const normalizedTemperature = asNumberInRange(
    typeof input.temperature === 'number' ? input.temperature : defaultTemperature,
    0,
    2,
    defaultTemperature,
  );

  return {
    ...defaults,
    ...input,
    enabled: asMaybeBoolean(input.enabled) ?? true,
    categories: {
      ...defaults.categories,
      ...(input.categories ?? {}),
    },
    budget: normalizedBudget,
    thresholds: normalizedThresholds,
    ...(normalizedModel ? { model: normalizedModel } : {}),
    temperature: normalizedTemperature,
  };
}

export function buildEmptySmartModeSummary(enabled = false): SmartModeSummary {
  return {
    enabled,
    llmCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    frontierResolvedByLlm: 0,
    summaryEnhancedByLlm: 0,
    contradictionsChallenged: 0,
    autoAcceptedCount: 0,
    pendingReviewCount: 0,
    skippedCount: 0,
    resolutionByCategory: {},
    resolutionByFrontierReason: {},
  };
}
