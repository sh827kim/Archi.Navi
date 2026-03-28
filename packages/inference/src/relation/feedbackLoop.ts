import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { domainInferenceProfiles, relationCandidates } from '@archi-navi/db';
import { asFiniteNumber, asRecord, stripCrossValidationMetadata } from './utils';

export interface RelationFeedbackConfig {
  enabled: boolean;
  minSamples: number;
  maxAdjustment: number;
}

export interface RelationFeedbackStats {
  approved: number;
  rejected: number;
  total: number;
  approvalRate: number;
  adjustment: number;
}

export interface RelationFeedbackDescriptor {
  key: string;
  lookupKeys: string[];
  legacyKey: string;
  relationType: string;
  sourceFamily: string;
  signalKind: string;
  framework: string | null;
  language: string | null;
}

export interface RelationFeedbackMetadata {
  key: string;
  sourceFamily: string;
  signalKind: string;
  baseConfidence: number;
  adjustment: number;
  adjustedConfidence: number;
  applied: boolean;
  sampleCount: number;
}

interface ProfileFeedbackState {
  config: RelationFeedbackConfig;
  adjustments: Record<string, RelationFeedbackStats>;
}

type FeedbackDbClient = Pick<DbClient, 'select' | 'insert' | 'update'>;

interface FeedbackCandidateInput {
  workspaceId: string;
  relationType: string;
  subjectObjectId: string;
  objectId: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

function isMissingFeedbackColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (code === '42703') return true;
  const message = Reflect.get(error, 'message');
  return typeof message === 'string'
    && (
      message.includes('feedback_config')
      || message.includes('feedback_adjustments')
    );
}

export const DEFAULT_RELATION_FEEDBACK_CONFIG: RelationFeedbackConfig = {
  enabled: true,
  minSamples: 10,
  maxAdjustment: 0.15,
};

const CONFIG_SOURCES = new Set(['application_yml', 'docker_compose', 'k8s_manifest', 'LLM_CONFIG']);
const DB_SOURCES = new Set(['fk_constraint', 'column_pattern', 'unique_pattern', 'index_pattern']);
const CODE_SOURCES = new Set(['CODE', 'LLM_CODE', 'LLM_BOOST']);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'unknown';
}

function normalizeOptionalKeyPart(value: unknown): string | null {
  const normalized = asNonEmptyString(value);
  return normalized ? normalizeKeyPart(normalized) : null;
}

function inferSourceFamily(metadata: Record<string, unknown>): string {
  const source = asNonEmptyString(metadata.source);
  if (source && CONFIG_SOURCES.has(source)) return 'config';
  if (source && DB_SOURCES.has(source)) return 'db';
  if (source && CODE_SOURCES.has(source)) return 'code';
  if (metadata.repoRoot || metadata.specFile) return 'config';
  if (metadata.envKey || metadata.configKey) return 'config';
  if (metadata.column || metadata.references_table || metadata.references_column) return 'db';
  if (metadata.calleeSymbol || metadata.channel || metadata.table) return 'code';
  return 'unknown';
}

function inferSignalKind(
  relationType: string,
  sourceFamily: string,
  metadata: Record<string, unknown>,
): string {
  const explicitSignalKind = asNonEmptyString(metadata.signalKind);
  if (explicitSignalKind) return normalizeKeyPart(explicitSignalKind);

  const kind = asNonEmptyString(metadata.kind);
  if (kind) return normalizeKeyPart(kind);

  const source = asNonEmptyString(metadata.source);
  const configKey = asNonEmptyString(metadata.configKey);
  const envKey = asNonEmptyString(metadata.envKey);

  if (source === 'LLM_BOOST') return 'boost_suggestion';
  if (source === 'LLM_CONFIG') return 'dependency_decl';
  if (source === 'LLM_CODE') return 'call';

  if (configKey === 'depends_on') return 'dependency_decl';
  if (configKey === 'zuul.routes.serviceId') return 'route_binding';
  if (configKey === 'spring.datasource.url' || envKey === 'DB_URL') return 'database_binding';
  if (configKey === 'spring.kafka.consumer') return 'consumer_binding';
  if (configKey === 'spring.kafka.producer' || envKey === 'KAFKA_BROKERS') return 'producer_binding';

  if (source && DB_SOURCES.has(source)) return normalizeKeyPart(source);
  if (sourceFamily === 'db') return 'schema_hint';
  if (sourceFamily === 'code') return normalizeKeyPart(relationType);
  if (sourceFamily === 'config') return normalizeKeyPart(relationType);
  return 'unknown';
}

export function deriveRelationFeedbackDescriptor(input: {
  relationType: string;
  metadata: unknown;
}): RelationFeedbackDescriptor {
  const metadata = stripCrossValidationMetadata(input.metadata);
  const relationType = input.relationType.trim().toUpperCase();
  const sourceFamily = inferSourceFamily(metadata);
  const signalKind = inferSignalKind(input.relationType, sourceFamily, metadata);
  const legacyKey = `${relationType}:${sourceFamily}:${signalKind}`;
  const framework = sourceFamily === 'code'
    ? normalizeOptionalKeyPart(metadata.framework)
    : null;
  const language = sourceFamily === 'code'
    ? normalizeOptionalKeyPart(metadata.language)
    : null;
  const key = framework && language
    ? `${legacyKey}:${framework}:${language}`
    : legacyKey;
  const lookupKeys = key === legacyKey ? [legacyKey] : [key, legacyKey];

  return {
    key,
    lookupKeys,
    legacyKey,
    relationType,
    sourceFamily,
    signalKind,
    framework,
    language,
  };
}

export function normalizeRelationFeedbackConfig(value: unknown): RelationFeedbackConfig {
  const record = asRecord(value);
  const enabled = typeof record?.enabled === 'boolean'
    ? record.enabled
    : DEFAULT_RELATION_FEEDBACK_CONFIG.enabled;
  const minSamples = Math.max(
    0,
    Math.round(asFiniteNumber(record?.minSamples) ?? DEFAULT_RELATION_FEEDBACK_CONFIG.minSamples),
  );
  const maxAdjustment = clamp(
    asFiniteNumber(record?.maxAdjustment) ?? DEFAULT_RELATION_FEEDBACK_CONFIG.maxAdjustment,
    0,
    0.99,
  );

  return {
    enabled,
    minSamples,
    maxAdjustment,
  };
}

export function computeRelationFeedbackAdjustment(
  stats: RelationFeedbackStats | null | undefined,
  config: RelationFeedbackConfig,
): number {
  if (!config.enabled || !stats || stats.total < config.minSamples) {
    return 0;
  }

  return round4(clamp((stats.approvalRate - 0.5) * config.maxAdjustment, -config.maxAdjustment, config.maxAdjustment));
}

export function normalizeRelationFeedbackAdjustments(
  value: unknown,
  config: RelationFeedbackConfig,
): Record<string, RelationFeedbackStats> {
  const record = asRecord(value) ?? {};
  const normalizedEntries = Object.entries(record)
    .map(([key, rawValue]) => {
      const bucket = asRecord(rawValue);
      const approved = Math.max(0, Math.round(asFiniteNumber(bucket?.approved) ?? 0));
      const rejected = Math.max(0, Math.round(asFiniteNumber(bucket?.rejected) ?? 0));
      const total = Math.max(approved + rejected, Math.round(asFiniteNumber(bucket?.total) ?? approved + rejected));
      const approvalRate = total > 0
        ? round4(approved / total)
        : 0;

      const normalized: RelationFeedbackStats = {
        approved,
        rejected,
        total,
        approvalRate,
        adjustment: 0,
      };
      normalized.adjustment = computeRelationFeedbackAdjustment(normalized, config);
      return [key, normalized] as const;
    });

  return Object.fromEntries(normalizedEntries);
}

async function loadWorkspaceFeedbackState(
  db: FeedbackDbClient,
  workspaceId: string,
): Promise<ProfileFeedbackState> {
  let profile: { feedbackConfig: unknown; feedbackAdjustments: unknown } | undefined;
  try {
    [profile] = await db
      .select({
        feedbackConfig: domainInferenceProfiles.feedbackConfig,
        feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments,
      })
      .from(domainInferenceProfiles)
      .where(
        and(
          eq(domainInferenceProfiles.workspaceId, workspaceId),
          eq(domainInferenceProfiles.isDefault, true),
        ),
      )
      .limit(1);
  } catch (error) {
    if (!isMissingFeedbackColumnError(error)) {
      throw error;
    }
    return {
      config: DEFAULT_RELATION_FEEDBACK_CONFIG,
      adjustments: {},
    };
  }

  const config = normalizeRelationFeedbackConfig(profile?.feedbackConfig);
  return {
    config,
    adjustments: normalizeRelationFeedbackAdjustments(profile?.feedbackAdjustments, config),
  };
}

async function ensureDefaultWorkspaceProfile(
  db: FeedbackDbClient,
  workspaceId: string,
): Promise<{
  id: string;
  feedbackConfig: unknown;
  feedbackAdjustments: unknown;
  supportsFeedbackColumns: boolean;
}> {
  try {
    const [existingDefault] = await db
      .select({
        id: domainInferenceProfiles.id,
        feedbackConfig: domainInferenceProfiles.feedbackConfig,
        feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments,
      })
      .from(domainInferenceProfiles)
      .where(
        and(
          eq(domainInferenceProfiles.workspaceId, workspaceId),
          eq(domainInferenceProfiles.isDefault, true),
        ),
      )
      .limit(1);
    if (existingDefault) return { ...existingDefault, supportsFeedbackColumns: true };

    const [existingAny] = await db
      .select({
        id: domainInferenceProfiles.id,
        feedbackConfig: domainInferenceProfiles.feedbackConfig,
        feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments,
      })
      .from(domainInferenceProfiles)
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId))
      .limit(1);
    if (existingAny) {
      await db
        .update(domainInferenceProfiles)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(domainInferenceProfiles.id, existingAny.id));
      return { ...existingAny, supportsFeedbackColumns: true };
    }

    const [created] = await db
      .insert(domainInferenceProfiles)
      .values({
        workspaceId,
        name: 'default',
        kind: 'NAMED',
        isDefault: true,
        feedbackConfig: DEFAULT_RELATION_FEEDBACK_CONFIG,
        feedbackAdjustments: {},
      })
      .returning({
        id: domainInferenceProfiles.id,
        feedbackConfig: domainInferenceProfiles.feedbackConfig,
        feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments,
      });

    if (!created) {
      throw new Error('default inference profile not found');
    }

    return { ...created, supportsFeedbackColumns: true };
  } catch (error) {
    if (!isMissingFeedbackColumnError(error)) {
      throw error;
    }
  }

  const [legacyDefault] = await db
    .select({
      id: domainInferenceProfiles.id,
    })
    .from(domainInferenceProfiles)
    .where(
      and(
        eq(domainInferenceProfiles.workspaceId, workspaceId),
        eq(domainInferenceProfiles.isDefault, true),
      ),
    )
    .limit(1);
  if (legacyDefault) {
    return {
      ...legacyDefault,
      feedbackConfig: DEFAULT_RELATION_FEEDBACK_CONFIG,
      feedbackAdjustments: {},
      supportsFeedbackColumns: false,
    };
  }

  const [legacyAny] = await db
    .select({
      id: domainInferenceProfiles.id,
    })
    .from(domainInferenceProfiles)
    .where(eq(domainInferenceProfiles.workspaceId, workspaceId))
    .limit(1);
  if (legacyAny) {
    await db
      .update(domainInferenceProfiles)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(domainInferenceProfiles.id, legacyAny.id));
    return {
      ...legacyAny,
      feedbackConfig: DEFAULT_RELATION_FEEDBACK_CONFIG,
      feedbackAdjustments: {},
      supportsFeedbackColumns: false,
    };
  }

  const [createdLegacy] = await db
    .insert(domainInferenceProfiles)
    .values({
      workspaceId,
      name: 'default',
      kind: 'NAMED',
      isDefault: true,
    })
    .returning({
      id: domainInferenceProfiles.id,
    });

  if (!createdLegacy) {
    throw new Error('default inference profile not found');
  }

  return {
    ...createdLegacy,
    feedbackConfig: DEFAULT_RELATION_FEEDBACK_CONFIG,
    feedbackAdjustments: {},
    supportsFeedbackColumns: false,
  };
}

export async function applyFeedbackToRelationCandidateInput(
  db: FeedbackDbClient,
  input: FeedbackCandidateInput,
): Promise<FeedbackCandidateInput> {
  const baseMetadata = stripCrossValidationMetadata(input.metadata);
  const descriptor = deriveRelationFeedbackDescriptor({
    relationType: input.relationType,
    metadata: baseMetadata,
  });
  const feedbackState = await loadWorkspaceFeedbackState(db, input.workspaceId);
  const stats = descriptor.lookupKeys
    .map((key) => feedbackState.adjustments[key])
    .find((bucket) => bucket);
  const adjustment = computeRelationFeedbackAdjustment(stats, feedbackState.config);
  const adjustedConfidence = round4(clamp(input.confidence + adjustment, 0.1, 0.99));
  const feedback: RelationFeedbackMetadata = {
    key: descriptor.key,
    sourceFamily: descriptor.sourceFamily,
    signalKind: descriptor.signalKind,
    baseConfidence: input.confidence,
    adjustment,
    adjustedConfidence,
    applied: adjustment !== 0,
    sampleCount: stats?.total ?? 0,
  };

  return {
    ...input,
    confidence: adjustedConfidence,
    metadata: {
      ...baseMetadata,
      feedback,
    },
  };
}

export async function accumulateRelationCandidateFeedback(
  db: FeedbackDbClient,
  candidate: typeof relationCandidates.$inferSelect,
  action: 'APPROVED' | 'REJECTED',
): Promise<RelationFeedbackStats | null> {
  const profile = await ensureDefaultWorkspaceProfile(db, candidate.workspaceId);
  if (!profile.supportsFeedbackColumns) {
    return null;
  }
  const config = normalizeRelationFeedbackConfig(profile.feedbackConfig);
  const adjustments = normalizeRelationFeedbackAdjustments(profile.feedbackAdjustments, config);
  const descriptor = deriveRelationFeedbackDescriptor({
    relationType: candidate.relationType,
    metadata: candidate.metadata,
  });
  const current = adjustments[descriptor.key] ?? {
    approved: 0,
    rejected: 0,
    total: 0,
    approvalRate: 0,
    adjustment: 0,
  };
  const next: RelationFeedbackStats = {
    approved: current.approved + (action === 'APPROVED' ? 1 : 0),
    rejected: current.rejected + (action === 'REJECTED' ? 1 : 0),
    total: current.total + 1,
    approvalRate: 0,
    adjustment: 0,
  };
  next.approvalRate = round4(next.total > 0 ? next.approved / next.total : 0);
  next.adjustment = computeRelationFeedbackAdjustment(next, config);

  try {
    await db
      .update(domainInferenceProfiles)
      .set({
        feedbackAdjustments: {
          ...adjustments,
          [descriptor.key]: next,
        },
        updatedAt: new Date(),
      })
      .where(eq(domainInferenceProfiles.id, profile.id));
  } catch (error) {
    if (isMissingFeedbackColumnError(error)) {
      return null;
    }
    throw error;
  }

  return next;
}
