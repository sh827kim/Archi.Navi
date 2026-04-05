/**
 * /api/inference/profiles/default
 * - GET: 워크스페이스 기본 추론 프로필 조회 (없으면 생성)
 * - PUT: 워크스페이스 기본 추론 프로필 갱신
 */
import { eq, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { domainInferenceProfiles, getDb } from '@archi-navi/db';
import { normalizeSmartProofConfig, type SmartProofConfig } from '@archi-navi/inference';

const DEFAULT_PROFILE_NAME = 'default';

function extractQueryRows<Row>(result: { rows?: Row[] } | Row[]): Row[] {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

interface CrossValidationConfig {
  enabled: boolean;
  boostFactor: number;
  penaltyFactor: number;
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

interface ProofConfidenceConfig {
  name: string;
  version: string;
  weights: ProofConfidenceWeights;
  slotWeights: {
    http: HttpProofSlotWeights;
    db: DbProofSlotWeights;
    message: MessageProofSlotWeights;
  };
}

const DEFAULT_CROSS_VALIDATION_CONFIG: CrossValidationConfig = {
  enabled: true,
  boostFactor: 0.3,
  penaltyFactor: 0.85,
};

const DEFAULT_PROOF_CONFIDENCE: ProofConfidenceConfig = {
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
  proofConfidence?: unknown;
  smartProofConfig?: unknown;
  feedbackConfig?: unknown;
  feedbackAdjustments?: unknown;
  domainFeedbackConfig?: unknown;
  domainFeedbackAdjustments?: unknown;
}

type ProfileBaseRow = Record<string, unknown> & {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  is_default: boolean | null;
  w_code: number | null;
  w_db: number | null;
  w_msg: number | null;
  secondary_threshold: number | null;
  min_cluster_size: number | null;
  resolution: number | null;
  edge_w_call: number | null;
  edge_w_rw: number | null;
  edge_w_msg: number | null;
  enabled_layers: unknown;
};

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
  proofConfidence?: Partial<ProofConfidenceConfig> & {
    weights?: Partial<ProofConfidenceWeights>;
    slotWeights?: {
      http?: Partial<HttpProofSlotWeights>;
      db?: Partial<DbProofSlotWeights>;
      message?: Partial<MessageProofSlotWeights>;
    };
  };
  smartProofConfig?: boolean | Partial<SmartProofConfig>;
  relationFeedbackConfig?: Partial<FeedbackConfig>;
  domainFeedbackConfig?: Partial<FeedbackConfig>;
  resetRelationFeedback?: boolean;
  resetDomainFeedback?: boolean;
}

function isMissingColumnError(error: unknown, columns: string[]): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = Reflect.get(error, 'message');
  if (typeof message !== 'string') return false;

  const normalizedMessage = message.toLowerCase();
  const hasRequestedColumn = columns.some((column) => normalizedMessage.includes(column.toLowerCase()));
  if (!hasRequestedColumn) return false;

  const code = Reflect.get(error, 'code');
  return code === '42703' || normalizedMessage.includes('does not exist');
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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeWeight(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? clamp(value, 0, 1) : fallback;
}

function asProofConfidenceConfig(value: unknown): ProofConfidenceConfig {
  const record = asRecord(value);
  const weights = asRecord(record['weights']);
  const slotWeights = asRecord(record['slotWeights']);
  const http = asRecord(slotWeights['http']);
  const db = asRecord(slotWeights['db']);
  const message = asRecord(slotWeights['message']);

  return {
    name: asString(record['name']) ?? DEFAULT_PROOF_CONFIDENCE.name,
    version: asString(record['version']) ?? DEFAULT_PROOF_CONFIDENCE.version,
    weights: {
      summaryQuality: normalizeWeight(
        weights['summaryQuality'],
        DEFAULT_PROOF_CONFIDENCE.weights.summaryQuality,
      ),
      slotCompleteness: normalizeWeight(
        weights['slotCompleteness'],
        DEFAULT_PROOF_CONFIDENCE.weights.slotCompleteness,
      ),
      corroborationPerSignal: normalizeWeight(
        weights['corroborationPerSignal'],
        DEFAULT_PROOF_CONFIDENCE.weights.corroborationPerSignal,
      ),
      corroborationCap: normalizeWeight(
        weights['corroborationCap'],
        DEFAULT_PROOF_CONFIDENCE.weights.corroborationCap,
      ),
      contradictionPenaltyPerItem: normalizeWeight(
        weights['contradictionPenaltyPerItem'],
        DEFAULT_PROOF_CONFIDENCE.weights.contradictionPenaltyPerItem,
      ),
      contradictionPenaltyCap: normalizeWeight(
        weights['contradictionPenaltyCap'],
        DEFAULT_PROOF_CONFIDENCE.weights.contradictionPenaltyCap,
      ),
    },
    slotWeights: {
      http: {
        method: normalizeWeight(http['method'], DEFAULT_PROOF_CONFIDENCE.slotWeights.http.method),
        externalPath: normalizeWeight(
          http['externalPath'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.http.externalPath,
        ),
        internalPath: normalizeWeight(
          http['internalPath'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.http.internalPath,
        ),
        providerService: normalizeWeight(
          http['providerService'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.http.providerService,
        ),
        targetObject: normalizeWeight(
          http['targetObject'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.http.targetObject,
        ),
      },
      db: {
        action: normalizeWeight(db['action'], DEFAULT_PROOF_CONFIDENCE.slotWeights.db.action),
        table: normalizeWeight(db['table'], DEFAULT_PROOF_CONFIDENCE.slotWeights.db.table),
        schema: normalizeWeight(db['schema'], DEFAULT_PROOF_CONFIDENCE.slotWeights.db.schema),
        datasource: normalizeWeight(
          db['datasource'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.db.datasource,
        ),
        targetObject: normalizeWeight(
          db['targetObject'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.db.targetObject,
        ),
      },
      message: {
        channel: normalizeWeight(
          message['channel'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.message.channel,
        ),
        broker: normalizeWeight(
          message['broker'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.message.broker,
        ),
        objectType: normalizeWeight(
          message['objectType'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.message.objectType,
        ),
        targetObject: normalizeWeight(
          message['targetObject'],
          DEFAULT_PROOF_CONFIDENCE.slotWeights.message.targetObject,
        ),
      },
    },
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

function toProfileResponseRow(row: ProfileBaseRow): ProfileResponse {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    isDefault: row.is_default,
    wCode: row.w_code,
    wDb: row.w_db,
    wMsg: row.w_msg,
    secondaryThreshold: row.secondary_threshold,
    minClusterSize: row.min_cluster_size,
    resolution: row.resolution,
    edgeWCall: row.edge_w_call,
    edgeWRw: row.edge_w_rw,
    edgeWMsg: row.edge_w_msg,
    enabledLayers: row.enabled_layers,
  };
}

function toPublicProfile(
  row: ProfileResponse,
  options?: { includeFeedbackEntries?: boolean },
) {
  const crossValidation = asCrossValidationConfig(row.crossValidation);
  const proofConfidence = asProofConfidenceConfig(row.proofConfidence);
  const smartProofConfig = normalizeSmartProofConfig(row.smartProofConfig as boolean | SmartProofConfig | null | undefined);
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
    proofConfidence,
    smartProofConfig,
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
  proofConfidence: unknown;
  smartProofConfig: unknown;
  feedbackConfig: unknown;
  feedbackAdjustments: unknown;
  domainFeedbackConfig: unknown;
  domainFeedbackAdjustments: unknown;
}> {
  try {
    const state = await db.execute<{
      cross_validation: unknown;
      proof_confidence_config: unknown;
      smart_proof_config: unknown;
      feedback_config: unknown;
      feedback_adjustments: unknown;
      domain_feedback_config: unknown;
      domain_feedback_adjustments: unknown;
    }>(sql`
      select
        cross_validation,
        proof_confidence_config,
        smart_proof_config,
        feedback_config,
        feedback_adjustments,
        domain_feedback_config,
        domain_feedback_adjustments
      from ${domainInferenceProfiles}
      where id = ${profileId}
      limit 1
    `);
    const rows = extractQueryRows(state);

    return {
      crossValidation: rows[0]?.cross_validation,
      proofConfidence: rows[0]?.proof_confidence_config,
      smartProofConfig: rows[0]?.smart_proof_config,
      feedbackConfig: rows[0]?.feedback_config,
      feedbackAdjustments: rows[0]?.feedback_adjustments,
      domainFeedbackConfig: rows[0]?.domain_feedback_config,
      domainFeedbackAdjustments: rows[0]?.domain_feedback_adjustments,
    };
  } catch (error) {
    if (!isMissingColumnError(error, [
      'proof_confidence_config',
      'smart_proof_config',
      'domain_feedback_config',
      'domain_feedback_adjustments',
    ])) {
      throw error;
    }
  }

  try {
    const relationState = await db.execute<{
      cross_validation: unknown;
      proof_confidence_config: unknown;
      smart_proof_config: unknown;
      feedback_config: unknown;
      feedback_adjustments: unknown;
    }>(sql`
      select
        cross_validation,
        proof_confidence_config,
        smart_proof_config,
        feedback_config,
        feedback_adjustments
      from ${domainInferenceProfiles}
      where id = ${profileId}
      limit 1
    `);
    const rows = extractQueryRows(relationState);

    return {
      crossValidation: rows[0]?.cross_validation,
      proofConfidence: rows[0]?.proof_confidence_config,
      smartProofConfig: rows[0]?.smart_proof_config,
      feedbackConfig: rows[0]?.feedback_config,
      feedbackAdjustments: rows[0]?.feedback_adjustments,
      domainFeedbackConfig: undefined,
      domainFeedbackAdjustments: undefined,
    };
  } catch (error) {
    if (!isMissingColumnError(error, [
      'proof_confidence_config',
      'smart_proof_config',
      'feedback_config',
      'feedback_adjustments',
    ])) {
      throw error;
    }
  }

  try {
    const crossValidation = await db.execute<{
      cross_validation: unknown;
      proof_confidence_config: unknown;
      smart_proof_config: unknown;
    }>(sql`
      select cross_validation, proof_confidence_config, smart_proof_config
      from ${domainInferenceProfiles}
      where id = ${profileId}
      limit 1
    `);
    const rows = extractQueryRows(crossValidation);

    return {
      crossValidation: rows[0]?.cross_validation,
      proofConfidence: rows[0]?.proof_confidence_config,
      smartProofConfig: rows[0]?.smart_proof_config,
      feedbackConfig: undefined,
      feedbackAdjustments: undefined,
      domainFeedbackConfig: undefined,
      domainFeedbackAdjustments: undefined,
    };
  } catch (error) {
    if (!isMissingColumnError(error, ['cross_validation', 'proof_confidence_config', 'smart_proof_config'])) {
      throw error;
    }
    return {
      crossValidation: undefined,
      proofConfidence: undefined,
      smartProofConfig: undefined,
      feedbackConfig: undefined,
      feedbackAdjustments: undefined,
      domainFeedbackConfig: undefined,
      domainFeedbackAdjustments: undefined,
    };
  }
}

async function selectProfileBaseRow(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string,
  options: { defaultOnly: boolean },
): Promise<ProfileResponse | null> {
  const baseRows = options.defaultOnly
    ? await db.execute<ProfileBaseRow>(sql`
      select
        id,
        workspace_id,
        name,
        kind,
        is_default,
        w_code,
        w_db,
        w_msg,
        secondary_threshold,
        min_cluster_size,
        resolution,
        edge_w_call,
        edge_w_rw,
        edge_w_msg,
        enabled_layers
      from ${domainInferenceProfiles}
      where workspace_id = ${workspaceId}
        and is_default = true
      limit 1
    `)
    : await db.execute<ProfileBaseRow>(sql`
      select
        id,
        workspace_id,
        name,
        kind,
        is_default,
        w_code,
        w_db,
        w_msg,
        secondary_threshold,
        min_cluster_size,
        resolution,
        edge_w_call,
        edge_w_rw,
        edge_w_msg,
        enabled_layers
      from ${domainInferenceProfiles}
      where workspace_id = ${workspaceId}
      limit 1
    `);

  const row = extractQueryRows(baseRows)[0];
  return row ? toProfileResponseRow(row) : null;
}

async function selectDefaultProfile(workspaceId: string): Promise<ProfileResponse | null> {
  const db = await getDb();
  const row = await selectProfileBaseRow(db, workspaceId, { defaultOnly: true });
  if (!row) return null;

  const state = await selectProfileJsonState(db, row.id);

  return {
    ...row,
    crossValidation: state.crossValidation,
    proofConfidence: state.proofConfidence,
    smartProofConfig: state.smartProofConfig,
    feedbackConfig: state.feedbackConfig,
    feedbackAdjustments: state.feedbackAdjustments,
    domainFeedbackConfig: state.domainFeedbackConfig,
    domainFeedbackAdjustments: state.domainFeedbackAdjustments,
  };
}

async function selectAnyProfile(workspaceId: string): Promise<ProfileResponse | null> {
  const db = await getDb();
  const row = await selectProfileBaseRow(db, workspaceId, { defaultOnly: false });
  if (!row) return null;

  const state = await selectProfileJsonState(db, row.id);

  return {
    ...row,
    crossValidation: state.crossValidation,
    proofConfidence: state.proofConfidence,
    smartProofConfig: state.smartProofConfig,
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
    const currentProofConfidence = asProofConfidenceConfig(current.proofConfidence);
    const proofConfidenceInput = body.proofConfidence ?? {};
    const proofConfidence = asProofConfidenceConfig({
      ...currentProofConfidence,
      ...proofConfidenceInput,
      name: asString(proofConfidenceInput.name) ?? currentProofConfidence.name,
      version: asString(proofConfidenceInput.version) ?? currentProofConfidence.version,
      weights: {
        ...currentProofConfidence.weights,
        ...(proofConfidenceInput.weights ?? {}),
      },
      slotWeights: {
        http: {
          ...currentProofConfidence.slotWeights.http,
          ...(proofConfidenceInput.slotWeights?.http ?? {}),
        },
        db: {
          ...currentProofConfidence.slotWeights.db,
          ...(proofConfidenceInput.slotWeights?.db ?? {}),
        },
        message: {
          ...currentProofConfidence.slotWeights.message,
          ...(proofConfidenceInput.slotWeights?.message ?? {}),
        },
      },
    });
    const currentSmartProofConfig = normalizeSmartProofConfig(
      current.smartProofConfig as boolean | SmartProofConfig | null | undefined,
    );
    const smartProofConfigInput = body.smartProofConfig;
    const smartProofConfig = normalizeSmartProofConfig(
      smartProofConfigInput === undefined
        ? currentSmartProofConfig
        : smartProofConfigInput === true || smartProofConfigInput === false
          ? { ...currentSmartProofConfig, enabled: smartProofConfigInput }
          : {
              ...currentSmartProofConfig,
              ...smartProofConfigInput,
              categories: {
                ...currentSmartProofConfig.categories,
                ...(smartProofConfigInput.categories ?? {}),
              },
              budget: {
                ...currentSmartProofConfig.budget,
                ...(smartProofConfigInput.budget ?? {}),
              },
              thresholds: {
                ...currentSmartProofConfig.thresholds,
                ...(smartProofConfigInput.thresholds ?? {}),
              },
            },
    );
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
        update ${domainInferenceProfiles}
        set cross_validation = ${JSON.stringify(crossValidation)}::jsonb
        where id = ${current.id}
      `);

      try {
        await tx.execute(sql`
          update ${domainInferenceProfiles}
          set proof_confidence_config = ${JSON.stringify(proofConfidence)}::jsonb
          where id = ${current.id}
        `);
      } catch (error) {
        if (!isMissingColumnError(error, ['proof_confidence_config'])) {
          throw error;
        }
      }

      try {
        await tx.execute(sql`
          update ${domainInferenceProfiles}
          set smart_proof_config = ${JSON.stringify(smartProofConfig)}::jsonb
          where id = ${current.id}
        `);
      } catch (error) {
        if (!isMissingColumnError(error, ['smart_proof_config'])) {
          throw error;
        }
      }

      try {
        if (resetRelationFeedback) {
          await tx.execute(sql`
            update ${domainInferenceProfiles}
            set feedback_config = ${JSON.stringify(relationFeedbackConfig)}::jsonb,
                feedback_adjustments = '{}'::jsonb
            where id = ${current.id}
          `);
        } else {
          await tx.execute(sql`
            update ${domainInferenceProfiles}
            set feedback_config = ${JSON.stringify(relationFeedbackConfig)}::jsonb
            where id = ${current.id}
          `);
        }
      } catch (error) {
        if (!isMissingColumnError(error, ['feedback_config', 'feedback_adjustments'])) {
          throw error;
        }
      }

      try {
        if (resetDomainFeedback) {
          await tx.execute(sql`
            update ${domainInferenceProfiles}
            set domain_feedback_config = ${JSON.stringify(domainFeedbackConfig)}::jsonb,
                domain_feedback_adjustments = '{}'::jsonb
            where id = ${current.id}
          `);
        } else {
          await tx.execute(sql`
            update ${domainInferenceProfiles}
            set domain_feedback_config = ${JSON.stringify(domainFeedbackConfig)}::jsonb
            where id = ${current.id}
          `);
        }
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
