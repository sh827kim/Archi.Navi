import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { domainCandidates, domainInferenceProfiles } from '@archi-navi/db';
import { asFiniteNumber, asRecord } from '../utils/metadata';

export interface DomainFeedbackConfig {
  enabled: boolean;
  minSamples: number;
  maxAdjustment: number;
}

export interface DomainFeedbackStats {
  approved: number;
  rejected: number;
  total: number;
  approvalRate: number;
  adjustment: number;
}

export type DomainFeedbackTrack = 'TRACK_A' | 'TRACK_B';
export type DomainFeedbackPurityBucket = 'LOW' | 'MEDIUM' | 'HIGH';

export interface DomainFeedbackDescriptor {
  key: string;
  track: 'TRACK_A';
  primaryDomainId: string;
  purityBucket: DomainFeedbackPurityBucket;
}

export interface DomainFeedbackMetadata {
  key: string;
  track: 'TRACK_A';
  primaryDomainId: string;
  purityBucket: DomainFeedbackPurityBucket;
  basePurity: number;
  adjustment: number;
  adjustedPurity: number;
  applied: boolean;
  sampleCount: number;
}

interface ProfileFeedbackState {
  config: DomainFeedbackConfig;
  adjustments: Record<string, DomainFeedbackStats>;
}

type FeedbackDbClient = Pick<DbClient, 'select' | 'insert' | 'update'>;

interface DomainFeedbackInput {
  workspaceId: string;
  primaryDomainId?: string | null;
  purity: number;
  track?: DomainFeedbackTrack;
}

export const DEFAULT_DOMAIN_FEEDBACK_CONFIG: DomainFeedbackConfig = {
  enabled: true,
  minSamples: 10,
  maxAdjustment: 0.15,
};

function isMissingDomainFeedbackColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (code === '42703') return true;
  const message = Reflect.get(error, 'message');
  return typeof message === 'string'
    && (
      message.includes('domain_feedback_config')
      || message.includes('domain_feedback_adjustments')
    );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveCandidateFeedbackPurity(candidate: typeof domainCandidates.$inferSelect): number {
  const signals = asRecord(candidate.signals);
  const feedback = asRecord(signals?.feedback);
  const basePurity = asFiniteNumber(feedback?.basePurity);
  return basePurity ?? candidate.purity;
}

export function getPurityBucket(purity: number): DomainFeedbackPurityBucket {
  if (purity >= 0.8) return 'HIGH';
  if (purity >= 0.5) return 'MEDIUM';
  return 'LOW';
}

export function deriveDomainFeedbackDescriptor(input: {
  primaryDomainId?: string | null;
  purity: number;
  track?: DomainFeedbackTrack;
}): DomainFeedbackDescriptor | null {
  if ((input.track ?? 'TRACK_A') !== 'TRACK_A') {
    return null;
  }

  const primaryDomainId = asNonEmptyString(input.primaryDomainId);
  if (!primaryDomainId) {
    return null;
  }

  const purityBucket = getPurityBucket(input.purity);
  return {
    key: `TRACK_A:${primaryDomainId}:${purityBucket}`,
    track: 'TRACK_A',
    primaryDomainId,
    purityBucket,
  };
}

export function normalizeDomainFeedbackConfig(value: unknown): DomainFeedbackConfig {
  const record = asRecord(value);
  const enabled = typeof record?.enabled === 'boolean'
    ? record.enabled
    : DEFAULT_DOMAIN_FEEDBACK_CONFIG.enabled;
  const minSamples = Math.max(
    0,
    Math.round(asFiniteNumber(record?.minSamples) ?? DEFAULT_DOMAIN_FEEDBACK_CONFIG.minSamples),
  );
  const maxAdjustment = clamp(
    asFiniteNumber(record?.maxAdjustment) ?? DEFAULT_DOMAIN_FEEDBACK_CONFIG.maxAdjustment,
    0,
    0.99,
  );

  return {
    enabled,
    minSamples,
    maxAdjustment,
  };
}

export function computeDomainFeedbackAdjustment(
  stats: DomainFeedbackStats | null | undefined,
  config: DomainFeedbackConfig,
): number {
  if (!config.enabled || !stats || stats.total < config.minSamples) {
    return 0;
  }

  return round4(
    clamp(
      (stats.approvalRate - 0.5) * config.maxAdjustment,
      -config.maxAdjustment,
      config.maxAdjustment,
    ),
  );
}

export function normalizeDomainFeedbackAdjustments(
  value: unknown,
  config: DomainFeedbackConfig,
): Record<string, DomainFeedbackStats> {
  const record = asRecord(value) ?? {};
  const normalizedEntries = Object.entries(record)
    .map(([key, rawValue]) => {
      const bucket = asRecord(rawValue);
      const approved = Math.max(0, Math.round(asFiniteNumber(bucket?.approved) ?? 0));
      const rejected = Math.max(0, Math.round(asFiniteNumber(bucket?.rejected) ?? 0));
      const total = Math.max(
        approved + rejected,
        Math.round(asFiniteNumber(bucket?.total) ?? approved + rejected),
      );
      const approvalRate = total > 0 ? round4(approved / total) : 0;

      const normalized: DomainFeedbackStats = {
        approved,
        rejected,
        total,
        approvalRate,
        adjustment: 0,
      };
      normalized.adjustment = computeDomainFeedbackAdjustment(normalized, config);
      return [key, normalized] as const;
    });

  return Object.fromEntries(normalizedEntries);
}

async function loadWorkspaceFeedbackState(
  db: FeedbackDbClient,
  workspaceId: string,
): Promise<ProfileFeedbackState> {
  let profile: { domainFeedbackConfig: unknown; domainFeedbackAdjustments: unknown } | undefined;
  try {
    [profile] = await db
      .select({
        domainFeedbackConfig: domainInferenceProfiles.domainFeedbackConfig,
        domainFeedbackAdjustments: domainInferenceProfiles.domainFeedbackAdjustments,
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
    if (!isMissingDomainFeedbackColumnError(error)) {
      throw error;
    }
    return {
      config: DEFAULT_DOMAIN_FEEDBACK_CONFIG,
      adjustments: {},
    };
  }

  const config = normalizeDomainFeedbackConfig(profile?.domainFeedbackConfig);
  return {
    config,
    adjustments: normalizeDomainFeedbackAdjustments(profile?.domainFeedbackAdjustments, config),
  };
}

async function ensureDefaultWorkspaceProfile(
  db: FeedbackDbClient,
  workspaceId: string,
): Promise<{
  id: string;
  domainFeedbackConfig: unknown;
  domainFeedbackAdjustments: unknown;
  supportsFeedbackColumns: boolean;
}> {
  try {
    const [existingDefault] = await db
      .select({
        id: domainInferenceProfiles.id,
        domainFeedbackConfig: domainInferenceProfiles.domainFeedbackConfig,
        domainFeedbackAdjustments: domainInferenceProfiles.domainFeedbackAdjustments,
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
        domainFeedbackConfig: domainInferenceProfiles.domainFeedbackConfig,
        domainFeedbackAdjustments: domainInferenceProfiles.domainFeedbackAdjustments,
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
        domainFeedbackConfig: DEFAULT_DOMAIN_FEEDBACK_CONFIG,
        domainFeedbackAdjustments: {},
      })
      .returning({
        id: domainInferenceProfiles.id,
        domainFeedbackConfig: domainInferenceProfiles.domainFeedbackConfig,
        domainFeedbackAdjustments: domainInferenceProfiles.domainFeedbackAdjustments,
      });

    if (!created) {
      throw new Error('default inference profile not found');
    }

    return { ...created, supportsFeedbackColumns: true };
  } catch (error) {
    if (!isMissingDomainFeedbackColumnError(error)) {
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
      domainFeedbackConfig: DEFAULT_DOMAIN_FEEDBACK_CONFIG,
      domainFeedbackAdjustments: {},
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
      domainFeedbackConfig: DEFAULT_DOMAIN_FEEDBACK_CONFIG,
      domainFeedbackAdjustments: {},
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
    domainFeedbackConfig: DEFAULT_DOMAIN_FEEDBACK_CONFIG,
    domainFeedbackAdjustments: {},
    supportsFeedbackColumns: false,
  };
}

export async function applyDomainFeedbackToSeedCandidate(
  db: FeedbackDbClient,
  input: DomainFeedbackInput,
): Promise<{ purity: number; feedback: DomainFeedbackMetadata | null }> {
  const descriptor = deriveDomainFeedbackDescriptor({
    purity: input.purity,
    ...(input.track ? { track: input.track } : {}),
    ...(input.primaryDomainId === undefined
      ? {}
      : { primaryDomainId: input.primaryDomainId }),
  });
  if (!descriptor) {
    return {
      purity: input.purity,
      feedback: null,
    };
  }

  const feedbackState = await loadWorkspaceFeedbackState(db, input.workspaceId);
  const stats = feedbackState.adjustments[descriptor.key];
  const adjustment = computeDomainFeedbackAdjustment(stats, feedbackState.config);
  const adjustedPurity = round4(clamp(input.purity + adjustment, 0, 1));

  return {
    purity: adjustedPurity,
    feedback: {
      key: descriptor.key,
      track: descriptor.track,
      primaryDomainId: descriptor.primaryDomainId,
      purityBucket: descriptor.purityBucket,
      basePurity: input.purity,
      adjustment,
      adjustedPurity,
      applied: adjustment !== 0,
      sampleCount: stats?.total ?? 0,
    },
  };
}

export async function accumulateDomainCandidateFeedback(
  db: FeedbackDbClient,
  candidate: typeof domainCandidates.$inferSelect,
  action: 'APPROVED' | 'REJECTED',
  options?: { track?: DomainFeedbackTrack },
): Promise<DomainFeedbackStats | null> {
  const feedbackPurity = resolveCandidateFeedbackPurity(candidate);
  const descriptor = deriveDomainFeedbackDescriptor({
    purity: feedbackPurity,
    track: options?.track ?? 'TRACK_A',
    ...(candidate.primaryDomainId === undefined
      ? {}
      : { primaryDomainId: candidate.primaryDomainId }),
  });
  if (!descriptor) {
    return null;
  }

  const profile = await ensureDefaultWorkspaceProfile(db, candidate.workspaceId);
  if (!profile.supportsFeedbackColumns) {
    return null;
  }
  const config = normalizeDomainFeedbackConfig(profile.domainFeedbackConfig);
  const adjustments = normalizeDomainFeedbackAdjustments(
    profile.domainFeedbackAdjustments,
    config,
  );
  const current = adjustments[descriptor.key] ?? {
    approved: 0,
    rejected: 0,
    total: 0,
    approvalRate: 0,
    adjustment: 0,
  };
  const next: DomainFeedbackStats = {
    approved: current.approved + (action === 'APPROVED' ? 1 : 0),
    rejected: current.rejected + (action === 'REJECTED' ? 1 : 0),
    total: current.total + 1,
    approvalRate: 0,
    adjustment: 0,
  };
  next.approvalRate = round4(next.total > 0 ? next.approved / next.total : 0);
  next.adjustment = computeDomainFeedbackAdjustment(next, config);

  await db
    .update(domainInferenceProfiles)
    .set({
      domainFeedbackAdjustments: {
        ...adjustments,
        [descriptor.key]: next,
      },
      updatedAt: new Date(),
    })
    .where(eq(domainInferenceProfiles.id, profile.id));

  return next;
}
