/**
 * /api/inference/profiles/default
 * - GET: 워크스페이스 기본 추론 프로필 조회 (없으면 생성)
 * - PUT: 워크스페이스 기본 추론 프로필 갱신
 */
import { and, eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';
import { domainInferenceProfiles, getDb } from '@archi-navi/db';

const DEFAULT_PROFILE_NAME = 'default';

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
}

function toPublicProfile(row: ProfileResponse) {
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
  return rows[0] ?? null;
}

async function selectAnyProfile(workspaceId: string): Promise<ProfileResponse | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(domainInferenceProfiles)
    .where(eq(domainInferenceProfiles.workspaceId, workspaceId))
    .limit(1);
  return rows[0] ?? null;
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
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') ?? DEFAULT_WORKSPACE_ID;
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
    const workspaceId = body.workspaceId ?? DEFAULT_WORKSPACE_ID;
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
    });

    const updated = await ensureDefaultProfile(workspaceId);
    return NextResponse.json(toPublicProfile(updated));
  } catch (error) {
    console.error('[PUT /api/inference/profiles/default]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
