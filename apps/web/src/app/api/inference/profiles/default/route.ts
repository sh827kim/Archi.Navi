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

function toPublicProfile(row: ProfileResponse) {
  const crossValidation = asCrossValidationConfig(row.crossValidation);
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
  };
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

  const crossValidation = await db.execute<{ cross_validation: unknown }>(sql`
    select cross_validation
    from domain_inference_profiles
    where id = ${row.id}
    limit 1
  `);

  return {
    ...row,
    crossValidation: crossValidation.rows[0]?.cross_validation,
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

  const crossValidation = await db.execute<{ cross_validation: unknown }>(sql`
    select cross_validation
    from domain_inference_profiles
    where id = ${row.id}
    limit 1
  `);

  return {
    ...row,
    crossValidation: crossValidation.rows[0]?.cross_validation,
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

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const profile = await ensureDefaultProfile(workspaceId);
    return NextResponse.json(toPublicProfile(profile));
  } catch (error) {
    console.error('[GET /api/inference/profiles/default]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
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
    });

    const updated = await ensureDefaultProfile(workspaceId);
    return NextResponse.json(toPublicProfile(updated));
  } catch (error) {
    console.error('[PUT /api/inference/profiles/default]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
