/**
 * POST /api/inference/domain-run
 * - Track A(seed-based), Track B(discovery) 실행 오케스트레이션
 * - profileId 미지정 시 워크스페이스 기본 프로필(is_default=true) 자동 적용
 */
import { and, eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';
import { domainInferenceProfiles, getDb } from '@archi-navi/db';
import { runDiscovery, runSeedBasedInference } from '@archi-navi/inference';
import { getActiveGeneration } from '@archi-navi/core';

type DomainTrack = 'a' | 'b' | 'all';

interface DomainRunBody {
  workspaceId?: string;
  track?: DomainTrack;
  profileId?: string;
  generationVersion?: number;
  minClusterSize?: number;
  resolution?: number;
}

function normalizeTrack(value: unknown): DomainTrack {
  if (value === 'a' || value === 'b' || value === 'all') return value;
  return 'all';
}

async function resolveProfileId(
  workspaceId: string,
  requestedProfileId?: string,
): Promise<string | undefined> {
  if (requestedProfileId && requestedProfileId.trim().length > 0) {
    return requestedProfileId.trim();
  }

  const db = await getDb();
  const defaultRows = await db
    .select({ id: domainInferenceProfiles.id })
    .from(domainInferenceProfiles)
    .where(
      and(
        eq(domainInferenceProfiles.workspaceId, workspaceId),
        eq(domainInferenceProfiles.isDefault, true),
      ),
    )
    .limit(1);

  if (defaultRows[0]?.id) return defaultRows[0].id;

  const anyRows = await db
    .select({ id: domainInferenceProfiles.id })
    .from(domainInferenceProfiles)
    .where(eq(domainInferenceProfiles.workspaceId, workspaceId))
    .limit(1);
  return anyRows[0]?.id;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as DomainRunBody;
    const workspaceId = body.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const track = normalizeTrack(body.track);
    const profileId = await resolveProfileId(workspaceId, body.profileId);
    const db = await getDb();

    const result = {
      track,
      workspaceId,
      profileId: profileId ?? null,
      seed: null as null | { candidateCount: number },
      discovery: null as null | {
        runId: string;
        clusterCount: number;
        generationVersion: number;
      },
    };

    if (track === 'a' || track === 'all') {
      result.seed = await runSeedBasedInference(db, {
        workspaceId,
        ...(profileId ? { profileId } : {}),
      });
    }

    if (track === 'b' || track === 'all') {
      const activeGeneration = await getActiveGeneration(db, workspaceId);
      const generationVersion = body.generationVersion ?? activeGeneration ?? null;
      if (generationVersion === null) {
        return NextResponse.json(
          {
            error:
              'Track B 실행에 사용할 ACTIVE rollup generation이 없습니다. 먼저 seed/rebuild를 실행하세요.',
          },
          { status: 400 },
        );
      }

      const discoveryResult = await runDiscovery(db, {
        workspaceId,
        generationVersion,
        ...(profileId ? { profileId } : {}),
        ...(typeof body.minClusterSize === 'number'
          ? { minClusterSize: body.minClusterSize }
          : {}),
        ...(typeof body.resolution === 'number' ? { resolution: body.resolution } : {}),
      });

      result.discovery = {
        ...discoveryResult,
        generationVersion,
      };
    }

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error('[POST /api/inference/domain-run]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
