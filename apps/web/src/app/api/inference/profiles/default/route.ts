/**
 * /api/inference/profiles/default
 * - GET: 워크스페이스 기본 추론 프로필 조회 (없으면 생성)
 * - PUT: 워크스페이스 기본 추론 프로필 갱신
 */
import { and, eq, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { domainInferenceProfiles, getDb } from '@archi-navi/db';

const DEFAULT_PROFILE_NAME = 'default';

interface CrossValidationConfig {
  enabled: boolean;
  boostFactor: number;
  penaltyFactor: number;
}

const DEFAULT_CROSS_VALIDATION_CONFIG: CrossValidationConfig = {
  enabled: true,
  boostFactor: 0.3,
  penaltyFactor: 0.85,
};

interface FeedbackConfig {
  enabled: boolean;
  minSamples: number;
  maxAdjustment: number;
}

interface FeedbackStats {
  approved: number;
  rejected: number;
  total: number;
  approvalRate: number;
  adjustment: number;
}

interface FeedbackSummary {
  totalKeys: number;
  eligibleKeys: number;
  approvedCount: number;
  rejectedCount: number;
  totalSamples: number;
}

interface FeedbackEntry {
  key: string;
  approved: number;
  rejected: number;
  total: number;
  approvalRate: number;
  adjustment: number;
  eligible: boolean;
}

const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  minSamples: 10,
  maxAdjustment: 0.15,
};

interface ProfileResponse {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  isDefault: boolean | null;
  wCode: number | null;
  wDb: number | null;
  wMsg: number | null;
  secondaryThreshold: number | null;
  minClusterSize: number | null;
  resolution: number | null;
  edgeWCall: number | null;
  edgeWRw: number | null;
  edgeWMsg: number | null;
  enabledLayers: unknown;
  crossValidation?: unknown;
  feedbackConfig?: unknown;
  feedbackAdjustments?: unknown;
  domainFeedbackConfig?: unknown;
  domainFeedbackAdjustments?: unknown;
}

interface UpdateProfileBody {
  workspaceId?: string;
  wCode?: number;
  wDb?: number;
  wMsg?: number;
  secondaryThreshold?: number;
  minClusterSize?: number;
  resolution?: number | null;
  edgeWCall?: number;
  edgeWRw?: number;
  edgeWMsg?: number;
  enabledLayers?: string[];
  crossValidation?: Partial<CrossValidationConfig>;
  relationFeedbackConfig?: Partial<FeedbackConfig>;
  domainFeedbackConfig?: Partial<FeedbackConfig>;
  resetRelationFeedback?: boolean;
  resetDomainFeedback?: boolean;
}

function isMissingColumnError(error: unknown, columns: string[]): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (code === '42703') return true;
  const message = Reflect.get(error, 'message');
  return typeof message === 'string' && columns.some((column) => message.includes(column));
}

function asCrossValidationConfig(value: unknown): CrossValidationConfig {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    enabled: typeof record['enabled'] === 'boolean'
      ? record['enabled']
      : DEFAULT_CROSS_VALIDATION_CONFIG.enabled,
    boostFactor: isFiniteNumber(record['boostFactor'])
      ? clamp(record['boostFactor'], 0, 1)
      : DEFAULT_CROSS_VALIDATION_CONFIG.boostFactor,
    penaltyFactor: isFiniteNumber(record['penaltyFactor'])
      ? clamp(record['penaltyFactor'], 0, 1)
      : DEFAULT_CROSS_VALIDATION_CONFIG.penaltyFactor,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asFeedbackConfig(value: unknown): FeedbackConfig {
  const record = asRecord(value);

  return {
    enabled: typeof record['enabled'] === 'boolean'
      ? record['enabled']
      : DEFAULT_FEEDBACK_CONFIG.enabled,
    minSamples: isFiniteNumber(record['minSamples'])
      ? Math.round(clamp(record['minSamples'], 1, 10_000))
      : DEFAULT_FEEDBACK_CONFIG.minSamples,
    maxAdjustment: isFiniteNumber(record['maxAdjustment'])
      ? clamp(record['maxAdjustment'], 0, 1)
      : DEFAULT_FEEDBACK_CONFIG.maxAdjustment,
  };
}

function normalizeFeedbackStats(
  value: unknown,
  config: FeedbackConfig,
): FeedbackStats {
  const record = asRecord(value);
  const approved = isFiniteNumber(record['approved'])
    ? Math.max(0, Math.round(record['approved']))
    : 0;
  const rejected = isFiniteNumber(record['rejected'])
    ? Math.max(0, Math.round(record['rejected']))
    : 0;
  const total = approved + rejected;
  const approvalRate = total > 0 ? approved / total : 0;
  const adjustment = total >= config.minSamples
    ? clamp((approvalRate - 0.5) * config.maxAdjustment, -config.maxAdjustment, config.maxAdjustment)
    : 0;

  return {
    approved,
    rejected,
    total,
    approvalRate,
    adjustment,
  };
}

function asFeedbackAdjustments(
  value: unknown,
  config: FeedbackConfig,
): Record<string, FeedbackStats> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, entry]) => [key, normalizeFeedbackStats(entry, config)]),
  );
}

function buildFeedbackSummary(
  adjustments: Record<string, FeedbackStats>,
  config: FeedbackConfig,
): FeedbackSummary {
  const entries = Object.values(adjustments);

  return {
    totalKeys: entries.length,
    eligibleKeys: entries.filter((entry) => entry.total >= config.minSamples).length,
    approvedCount: entries.reduce((sum, entry) => sum + entry.approved, 0),
    rejectedCount: entries.reduce((sum, entry) => sum + entry.rejected, 0),
    totalSamples: entries.reduce((sum, entry) => sum + entry.total, 0),
  };
}

function buildFeedbackEntries(
  adjustments: Record<string, FeedbackStats>,
  config: FeedbackConfig,
): FeedbackEntry[] {
  return Object.entries(adjustments)
    .map(([key, entry]) => ({
      key,
      approved: entry.approved,
      rejected: entry.rejected,
      total: entry.total,
      approvalRate: entry.approvalRate,
      adjustment: entry.adjustment,
      eligible: entry.total >= config.minSamples,
    }))
    .sort((left, right) => {
      if (right.total !== left.total) return right.total - left.total;
      const adjustmentDiff = Math.abs(right.adjustment) - Math.abs(left.adjustment);
      if (adjustmentDiff !== 0) return adjustmentDiff;
      return left.key.localeCompare(right.key);
    });
}

function toPublicProfile(
  row: ProfileResponse,
  options?: { includeFeedbackEntries?: boolean },
) {
  const crossValidation = asCrossValidationConfig(row.crossValidation);
  const relationFeedbackConfig = asFeedbackConfig(row.feedbackConfig);
  const relationFeedbackAdjustments = asFeedbackAdjustments(
    row.feedbackAdjustments,
    relationFeedbackConfig,
  );
  const relationFeedbackSummary = buildFeedbackSummary(
    relationFeedbackAdjustments,
    relationFeedbackConfig,
  );
  const domainFeedbackConfig = asFeedbackConfig(row.domainFeedbackConfig);
  const domainFeedbackAdjustments = asFeedbackAdjustments(
    row.domainFeedbackAdjustments,
    domainFeedbackConfig,
  );
  const domainFeedbackSummary = buildFeedbackSummary(
    domainFeedbackAdjustments,
    domainFeedbackConfig,
  );
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    kind: row.kind,
    isDefault: row.isDefault ?? false,
    wCode: row.wCode ?? 0.5,
    wDb: row.wDb ?? 0.3,
    wMsg: row.wMsg ?? 0.2,
    secondaryThreshold: row.secondaryThreshold ?? 0.25,
    minClusterSize: row.minClusterSize ?? 3,
    resolution: row.resolution ?? 1.0,
    edgeWCall: row.edgeWCall ?? 1.0,
    edgeWRw: row.edgeWRw ?? 0.8,
    edgeWMsg: row.edgeWMsg ?? 0.6,
    enabledLayers: Array.isArray(row.enabledLayers)
      ? (row.enabledLayers as unknown[]).filter((v): v is string => typeof v === 'string')
      : ['call', 'db', 'msg', 'code'],
    crossValidation,
    relationFeedbackConfig,
    relationFeedbackSummary,
    domainFeedbackConfig,
    domainFeedbackSummary,
    ...(options?.includeFeedbackEntries
      ? {
          relationFeedbackEntries: buildFeedbackEntries(
            relationFeedbackAdjustments,
            relationFeedbackConfig,
          ),
          domainFeedbackEntries: buildFeedbackEntries(
            domainFeedbackAdjustments,
            domainFeedbackConfig,
          ),
        }
      : {}),
  };
}

async function selectProfileJsonState(
  db: Awaited<ReturnType<typeof getDb>>,
  profileId: string,
): Promise<{
  crossValidation: unknown;
  feedbackConfig: unknown;
  feedbackAdjustments: unknown;
  domainFeedbackConfig: unknown;
  domainFeedbackAdjustments: unknown;
}> {
  try {
    const state = await db.execute<{
      cross_validation: unknown;
      feedback_config: unknown;
      feedback_adjustments: unknown;
      domain_feedback_config: unknown;
      domain_feedback_adjustments: unknown;
    }>(sql`
      select
        cross_validation,
        feedback_config,
        feedback_adjustments,
        domain_feedback_config,
        domain_feedback_adjustments
      from domain_inference_profiles
      where id = ${profileId}
      limit 1
    `);

    return {
      crossValidation: state.rows[0]?.cross_validation,
      feedbackConfig: state.rows[0]?.feedback_config,
      feedbackAdjustments: state.rows[0]?.feedback_adjustments,
      domainFeedbackConfig: state.rows[0]?.domain_feedback_config,
      domainFeedbackAdjustments: state.rows[0]?.domain_feedback_adjustments,
    };
  } catch (error) {
    if (!isMissingColumnError(error, ['domain_feedback_config', 'domain_feedback_adjustments'])) {
      throw error;
    }
  }

  try {
    const relationState = await db.execute<{
      cross_validation: unknown;
      feedback_config: unknown;
      feedback_adjustments: unknown;
    }>(sql`
      select
        cross_validation,
        feedback_config,
        feedback_adjustments
      from domain_inference_profiles
      where id = ${profileId}
      limit 1
    `);

    return {
      crossValidation: relationState.rows[0]?.cross_validation,
      feedbackConfig: relationState.rows[0]?.feedback_config,
      feedbackAdjustments: relationState.rows[0]?.feedback_adjustments,
      domainFeedbackConfig: undefined,
      domainFeedbackAdjustments: undefined,
    };
  } catch (error) {
    if (!isMissingColumnError(error, ['feedback_config', 'feedback_adjustments'])) {
      throw error;
    }
  }

  try {
    const crossValidation = await db.execute<{ cross_validation: unknown }>(sql`
      select cross_validation
      from domain_inference_profiles
      where id = ${profileId}
      limit 1
    `);

    return {
      crossValidation: crossValidation.rows[0]?.cross_validation,
      feedbackConfig: undefined,
      feedbackAdjustments: undefined,
      domainFeedbackConfig: undefined,
      domainFeedbackAdjustments: undefined,
    };
  } catch (error) {
    if (!isMissingColumnError(error, ['cross_validation'])) {
      throw error;
    }
    return {
      crossValidation: undefined,
      feedbackConfig: undefined,
      feedbackAdjustments: undefined,
      domainFeedbackConfig: undefined,
      domainFeedbackAdjustments: undefined,
    };
  }
}

async function selectDefaultProfile(workspaceId: string): Promise<ProfileResponse | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(domainInferenceProfiles)
    .where(
      and(
        eq(domainInferenceProfiles.workspaceId, workspaceId),
        eq(domainInferenceProfiles.isDefault, true),
      ),
    )
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;

  const state = await selectProfileJsonState(db, row.id);

  return {
    ...row,
    crossValidation: state.crossValidation,
    feedbackConfig: state.feedbackConfig,
    feedbackAdjustments: state.feedbackAdjustments,
    domainFeedbackConfig: state.domainFeedbackConfig,
    domainFeedbackAdjustments: state.domainFeedbackAdjustments,
  };
}

async function selectAnyProfile(workspaceId: string): Promise<ProfileResponse | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(domainInferenceProfiles)
    .where(eq(domainInferenceProfiles.workspaceId, workspaceId))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;

  const state = await selectProfileJsonState(db, row.id);

  return {
    ...row,
    crossValidation: state.crossValidation,
    feedbackConfig: state.feedbackConfig,
    feedbackAdjustments: state.feedbackAdjustments,
    domainFeedbackConfig: state.domainFeedbackConfig,
    domainFeedbackAdjustments: state.domainFeedbackAdjustments,
  };
}

async function ensureDefaultProfile(workspaceId: string): Promise<ProfileResponse> {
  const db = await getDb();
  const existingDefault = await selectDefaultProfile(workspaceId);
  if (existingDefault) return existingDefault;

  const existingAny = await selectAnyProfile(workspaceId);
  if (existingAny) {
    await db
      .update(domainInferenceProfiles)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(domainInferenceProfiles.id, existingAny.id));
    const promoted = await selectDefaultProfile(workspaceId);
    if (promoted) return promoted;
  }

  await db.insert(domainInferenceProfiles).values({
    workspaceId,
    name: DEFAULT_PROFILE_NAME,
    kind: 'NAMED',
    isDefault: true,
  });

  const created = await selectDefaultProfile(workspaceId);
  if (!created) {
    throw new Error('기본 추론 프로필 생성에 실패했습니다.');
  }
  return created;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shouldIncludeFeedbackEntries(req: NextRequest): boolean {
  return req.nextUrl.searchParams.get('includeFeedbackEntries') === 'true';
}

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const includeFeedbackEntries = shouldIncludeFeedbackEntries(req);
    const profile = await ensureDefaultProfile(workspaceId);
    return NextResponse.json(toPublicProfile(profile, { includeFeedbackEntries }));
  } catch (error) {
    console.error('[GET /api/inference/profiles/default]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const includeFeedbackEntries = shouldIncludeFeedbackEntries(req);
    const body = (await req.json().catch(() => ({}))) as UpdateProfileBody;
    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const db = await getDb();

    const current = await ensureDefaultProfile(workspaceId);

    const wCode = isFiniteNumber(body.wCode) ? clamp(body.wCode, 0, 1) : (current.wCode ?? 0.5);
    const wDb = isFiniteNumber(body.wDb) ? clamp(body.wDb, 0, 1) : (current.wDb ?? 0.3);
    const wMsg = isFiniteNumber(body.wMsg) ? clamp(body.wMsg, 0, 1) : (current.wMsg ?? 0.2);
    const weightSum = wCode + wDb + wMsg;
    if (Math.abs(weightSum - 1) > 0.001) {
      return NextResponse.json(
        { error: `가중치 합계가 ${weightSum.toFixed(2)}입니다. 합이 1.00이어야 합니다.` },
        { status: 400 },
      );
    }

    const secondaryThreshold = isFiniteNumber(body.secondaryThreshold)
      ? clamp(body.secondaryThreshold, 0, 1)
      : (current.secondaryThreshold ?? 0.25);
    const minClusterSize = isFiniteNumber(body.minClusterSize)
      ? Math.round(clamp(body.minClusterSize, 2, 50))
      : (current.minClusterSize ?? 3);
    const resolution = body.resolution === null
      ? null
      : isFiniteNumber(body.resolution)
        ? clamp(body.resolution, 0.1, 10)
        : current.resolution;
    const edgeWCall = isFiniteNumber(body.edgeWCall)
      ? clamp(body.edgeWCall, 0, 10)
      : (current.edgeWCall ?? 1.0);
    const edgeWRw = isFiniteNumber(body.edgeWRw)
      ? clamp(body.edgeWRw, 0, 10)
      : (current.edgeWRw ?? 0.8);
    const edgeWMsg = isFiniteNumber(body.edgeWMsg)
      ? clamp(body.edgeWMsg, 0, 10)
      : (current.edgeWMsg ?? 0.6);
    const enabledLayers =
      Array.isArray(body.enabledLayers) && body.enabledLayers.length > 0
        ? body.enabledLayers
        : Array.isArray(current.enabledLayers)
          ? (current.enabledLayers as unknown[]).filter((v): v is string => typeof v === 'string')
          : ['call', 'db', 'msg', 'code'];
    const crossValidationInput = body.crossValidation ?? {};
    const currentCrossValidation = asCrossValidationConfig(current.crossValidation);
    const crossValidation = {
      enabled: typeof crossValidationInput.enabled === 'boolean'
        ? crossValidationInput.enabled
        : currentCrossValidation.enabled,
      boostFactor: isFiniteNumber(crossValidationInput.boostFactor)
        ? clamp(crossValidationInput.boostFactor, 0, 1)
        : currentCrossValidation.boostFactor,
      penaltyFactor: isFiniteNumber(crossValidationInput.penaltyFactor)
        ? clamp(crossValidationInput.penaltyFactor, 0, 1)
        : currentCrossValidation.penaltyFactor,
    };
    const resetRelationFeedback = body.resetRelationFeedback === true;
    const resetDomainFeedback = body.resetDomainFeedback === true;
    const currentRelationFeedbackConfig = asFeedbackConfig(current.feedbackConfig);
    const relationFeedbackConfigInput = body.relationFeedbackConfig ?? {};
    const relationFeedbackConfig = resetRelationFeedback
      ? DEFAULT_FEEDBACK_CONFIG
      : {
          enabled: typeof relationFeedbackConfigInput.enabled === 'boolean'
            ? relationFeedbackConfigInput.enabled
            : currentRelationFeedbackConfig.enabled,
          minSamples: isFiniteNumber(relationFeedbackConfigInput.minSamples)
            ? Math.round(clamp(relationFeedbackConfigInput.minSamples, 1, 10_000))
            : currentRelationFeedbackConfig.minSamples,
          maxAdjustment: isFiniteNumber(relationFeedbackConfigInput.maxAdjustment)
            ? clamp(relationFeedbackConfigInput.maxAdjustment, 0, 1)
            : currentRelationFeedbackConfig.maxAdjustment,
        };
    const relationFeedbackAdjustments = resetRelationFeedback
      ? {}
      : asFeedbackAdjustments(current.feedbackAdjustments, relationFeedbackConfig);
    const currentDomainFeedbackConfig = asFeedbackConfig(current.domainFeedbackConfig);
    const domainFeedbackConfigInput = body.domainFeedbackConfig ?? {};
    const domainFeedbackConfig = resetDomainFeedback
      ? DEFAULT_FEEDBACK_CONFIG
      : {
          enabled: typeof domainFeedbackConfigInput.enabled === 'boolean'
            ? domainFeedbackConfigInput.enabled
            : currentDomainFeedbackConfig.enabled,
          minSamples: isFiniteNumber(domainFeedbackConfigInput.minSamples)
            ? Math.round(clamp(domainFeedbackConfigInput.minSamples, 1, 10_000))
            : currentDomainFeedbackConfig.minSamples,
          maxAdjustment: isFiniteNumber(domainFeedbackConfigInput.maxAdjustment)
            ? clamp(domainFeedbackConfigInput.maxAdjustment, 0, 1)
            : currentDomainFeedbackConfig.maxAdjustment,
        };
    const domainFeedbackAdjustments = resetDomainFeedback
      ? {}
      : asFeedbackAdjustments(current.domainFeedbackAdjustments, domainFeedbackConfig);
    await db.transaction(async (tx) => {
      await tx
        .update(domainInferenceProfiles)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(domainInferenceProfiles.workspaceId, workspaceId));

      await tx
        .update(domainInferenceProfiles)
        .set({
          isDefault: true,
          wCode,
          wDb,
          wMsg,
          secondaryThreshold,
          minClusterSize,
          resolution,
          edgeWCall,
          edgeWRw,
          edgeWMsg,
          enabledLayers,
          updatedAt: new Date(),
        })
        .where(eq(domainInferenceProfiles.id, current.id));

      await tx.execute(sql`
        update domain_inference_profiles
        set cross_validation = ${JSON.stringify(crossValidation)}::jsonb
        where id = ${current.id}
      `);

      try {
        await tx.execute(sql`
          update domain_inference_profiles
          set feedback_config = ${JSON.stringify(relationFeedbackConfig)}::jsonb,
              feedback_adjustments = ${JSON.stringify(relationFeedbackAdjustments)}::jsonb
          where id = ${current.id}
        `);
      } catch (error) {
        if (!isMissingColumnError(error, ['feedback_config', 'feedback_adjustments'])) {
          throw error;
        }
      }

      try {
        await tx.execute(sql`
          update domain_inference_profiles
          set domain_feedback_config = ${JSON.stringify(domainFeedbackConfig)}::jsonb,
              domain_feedback_adjustments = ${JSON.stringify(domainFeedbackAdjustments)}::jsonb
          where id = ${current.id}
        `);
      } catch (error) {
        if (!isMissingColumnError(error, ['domain_feedback_config', 'domain_feedback_adjustments'])) {
          throw error;
        }
      }
    });

    const updated = await ensureDefaultProfile(workspaceId);
    return NextResponse.json(toPublicProfile(updated, { includeFeedbackEntries }));
  } catch (error) {
    console.error('[PUT /api/inference/profiles/default]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
