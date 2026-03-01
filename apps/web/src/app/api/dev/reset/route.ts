/**
 * POST /api/dev/reset — 워크스페이스 데이터 초기화
 * objects, object_relations, relation_candidates, rollups, architecture_layers, tags 삭제
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
  objectRollups,
  objectGraphStats,
  rollupGenerations,
} from '@archi-navi/db';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { workspaceId?: string };
    const workspaceId = body.workspaceId ?? DEFAULT_WORKSPACE_ID;

    const db = await getDb();

    const before = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(objects).where(eq(objects.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(architectureLayers).where(eq(architectureLayers.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(tags).where(eq(tags.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectRelations).where(eq(objectRelations.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(relationCandidates).where(eq(relationCandidates.workspaceId, workspaceId)),
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
      objectRollups: Number(before[5][0]?.count ?? 0),
      objectGraphStats: Number(before[6][0]?.count ?? 0),
      rollupGenerations: Number(before[7][0]?.count ?? 0),
    };

    // CASCADE FK에 의해 하위 테이블도 자동 삭제됨
    // object_layer_assignments → FK on objectId (CASCADE)
    // object_tags → FK on objectId (CASCADE)
    // 단, object_rollups/object_graph_stats는 objects FK가 CASCADE가 아니므로 선삭제 필요

    // 1. 관계 후보 삭제
    await db
      .delete(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    // 2. 확정 관계 삭제
    await db
      .delete(objectRelations)
      .where(eq(objectRelations.workspaceId, workspaceId));

    // 3. 롤업 통계/엣지 삭제 (objects 선삭제 제약 회피)
    await db
      .delete(objectGraphStats)
      .where(eq(objectGraphStats.workspaceId, workspaceId));

    await db
      .delete(objectRollups)
      .where(eq(objectRollups.workspaceId, workspaceId));

    await db
      .delete(rollupGenerations)
      .where(eq(rollupGenerations.workspaceId, workspaceId));

    // 4. 오브젝트 삭제 (object_layer_assignments, object_tags CASCADE)
    await db
      .delete(objects)
      .where(eq(objects.workspaceId, workspaceId));

    // 5. 레이어 삭제 (object_layer_assignments CASCADE)
    await db
      .delete(architectureLayers)
      .where(eq(architectureLayers.workspaceId, workspaceId));

    // 6. 태그 삭제 (object_tags는 objects 삭제 시 이미 CASCADE 처리됨)
    await db
      .delete(tags)
      .where(eq(tags.workspaceId, workspaceId));

    const after = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(objects).where(eq(objects.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(architectureLayers).where(eq(architectureLayers.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(tags).where(eq(tags.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(objectRelations).where(eq(objectRelations.workspaceId, workspaceId)),
      db.select({ count: sql<number>`count(*)` }).from(relationCandidates).where(eq(relationCandidates.workspaceId, workspaceId)),
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
      objectRollups: Number(after[5][0]?.count ?? 0),
      objectGraphStats: Number(after[6][0]?.count ?? 0),
      rollupGenerations: Number(after[7][0]?.count ?? 0),
    };

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
