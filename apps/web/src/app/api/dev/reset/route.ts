/**
 * POST /api/dev/reset — 워크스페이스 데이터 초기화
 * 워크스페이스 하위 도메인/코드/근거/관계/롤업/레이어/태그 데이터를 전체 삭제
 * workspaces 레코드 자체는 보존
 */
import { type NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  objects,
  objectRelations,
  relationCandidates,
  architectureLayers,
  tags,
  objectTags,
  objectLayerAssignments,
  objectRollups,
  objectRollupProvenances,
  objectGraphStats,
  rollupGenerations,
  relationEvidences,
  relationCandidateEvidences,
  evidences,
  codeArtifacts,
  codeImportEdges,
  codeCallEdges,
  objectDomainAffinities,
  domainCandidates,
  domainCandidateEvidences,
  domainInferenceProfiles,
  domainDiscoveryRuns,
  domainDiscoveryMemberships,
  domainRollupProvenances,
  changeLogs,
} from '@archi-navi/db';
import { eq, sql } from 'drizzle-orm';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { workspaceId?: string };
    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();

    const before = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(objects).where(eq(objects.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(architectureLayers).where(eq(architectureLayers.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(tags).where(eq(tags.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectRelations).where(eq(objectRelations.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(relationCandidates).where(eq(relationCandidates.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(domainCandidates).where(eq(domainCandidates.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(codeArtifacts).where(eq(codeArtifacts.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(evidences).where(eq(evidences.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectRollups).where(eq(objectRollups.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectGraphStats).where(eq(objectGraphStats.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(rollupGenerations).where(eq(rollupGenerations.workspaceId, workspaceId)),
    ]);
    const beforeCounts = {
      objects: Number(before[0][0]?.count ?? 0),
      layers: Number(before[1][0]?.count ?? 0),
      tags: Number(before[2][0]?.count ?? 0),
      relations: Number(before[3][0]?.count ?? 0),
      relationCandidates: Number(before[4][0]?.count ?? 0),
      domainCandidates: Number(before[5][0]?.count ?? 0),
      codeArtifacts: Number(before[6][0]?.count ?? 0),
      evidences: Number(before[7][0]?.count ?? 0),
      objectRollups: Number(before[8][0]?.count ?? 0),
      objectGraphStats: Number(before[9][0]?.count ?? 0),
      rollupGenerations: Number(before[10][0]?.count ?? 0),
    };

    await db.transaction(async (tx) => {
      // 1) 롤업/도메인 provenance 및 스냅샷
      await tx
        .delete(domainRollupProvenances)
        .where(eq(domainRollupProvenances.workspaceId, workspaceId));
      await tx
        .delete(domainDiscoveryMemberships)
        .where(eq(domainDiscoveryMemberships.workspaceId, workspaceId));
      await tx
        .delete(domainDiscoveryRuns)
        .where(eq(domainDiscoveryRuns.workspaceId, workspaceId));

      // 2) 코드/근거
      await tx
        .delete(codeCallEdges)
        .where(eq(codeCallEdges.workspaceId, workspaceId));
      await tx
        .delete(codeImportEdges)
        .where(eq(codeImportEdges.workspaceId, workspaceId));
      await tx
        .delete(codeArtifacts)
        .where(eq(codeArtifacts.workspaceId, workspaceId));

      // 3) 후보/확정 관계와 연결 테이블
      await tx
        .delete(domainCandidateEvidences)
        .where(eq(domainCandidateEvidences.workspaceId, workspaceId));
      await tx
        .delete(relationCandidateEvidences)
        .where(eq(relationCandidateEvidences.workspaceId, workspaceId));
      await tx
        .delete(relationEvidences)
        .where(eq(relationEvidences.workspaceId, workspaceId));

      await tx
        .delete(domainCandidates)
        .where(eq(domainCandidates.workspaceId, workspaceId));
      await tx
        .delete(objectDomainAffinities)
        .where(eq(objectDomainAffinities.workspaceId, workspaceId));
      await tx
        .delete(relationCandidates)
        .where(eq(relationCandidates.workspaceId, workspaceId));
      await tx
        .delete(objectRelations)
        .where(eq(objectRelations.workspaceId, workspaceId));

      // 4) 롤업 본체/통계/세대
      await tx
        .delete(objectRollupProvenances)
        .where(eq(objectRollupProvenances.workspaceId, workspaceId));
      await tx
        .delete(objectGraphStats)
        .where(eq(objectGraphStats.workspaceId, workspaceId));
      await tx
        .delete(objectRollups)
        .where(eq(objectRollups.workspaceId, workspaceId));
      await tx
        .delete(rollupGenerations)
        .where(eq(rollupGenerations.workspaceId, workspaceId));

      // 5) 근거 원문 / 태깅 / 레이어 배치
      await tx
        .delete(evidences)
        .where(eq(evidences.workspaceId, workspaceId));
      await tx
        .delete(objectTags)
        .where(eq(objectTags.workspaceId, workspaceId));
      await tx
        .delete(objectLayerAssignments)
        .where(eq(objectLayerAssignments.workspaceId, workspaceId));

      // 6) 오브젝트/레이어/태그 및 도메인 프로필/로그
      await tx
        .delete(objects)
        .where(eq(objects.workspaceId, workspaceId));
      await tx
        .delete(architectureLayers)
        .where(eq(architectureLayers.workspaceId, workspaceId));
      await tx
        .delete(tags)
        .where(eq(tags.workspaceId, workspaceId));
      await tx
        .delete(domainInferenceProfiles)
        .where(eq(domainInferenceProfiles.workspaceId, workspaceId));
      await tx
        .delete(changeLogs)
        .where(eq(changeLogs.workspaceId, workspaceId));
    });

    const after = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(objects).where(eq(objects.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(architectureLayers).where(eq(architectureLayers.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(tags).where(eq(tags.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectRelations).where(eq(objectRelations.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(relationCandidates).where(eq(relationCandidates.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(domainCandidates).where(eq(domainCandidates.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(codeArtifacts).where(eq(codeArtifacts.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(evidences).where(eq(evidences.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectRollups).where(eq(objectRollups.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectGraphStats).where(eq(objectGraphStats.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(rollupGenerations).where(eq(rollupGenerations.workspaceId, workspaceId)),
    ]);
    const remaining = {
      objects: Number(after[0][0]?.count ?? 0),
      layers: Number(after[1][0]?.count ?? 0),
      tags: Number(after[2][0]?.count ?? 0),
      relations: Number(after[3][0]?.count ?? 0),
      relationCandidates: Number(after[4][0]?.count ?? 0),
      domainCandidates: Number(after[5][0]?.count ?? 0),
      codeArtifacts: Number(after[6][0]?.count ?? 0),
      evidences: Number(after[7][0]?.count ?? 0),
      objectRollups: Number(after[8][0]?.count ?? 0),
      objectGraphStats: Number(after[9][0]?.count ?? 0),
      rollupGenerations: Number(after[10][0]?.count ?? 0),
    };

    const hasRemaining = Object.values(remaining).some((count) => count > 0);
    if (hasRemaining) {
      return NextResponse.json(
        {
          error: '워크스페이스 초기화가 부분적으로만 완료되었습니다.',
          workspaceId,
          deleted: beforeCounts,
          remaining,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      workspaceId,
      deleted: beforeCounts,
      remaining,
    });
  } catch (error) {
    console.error('[POST /api/dev/reset]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
