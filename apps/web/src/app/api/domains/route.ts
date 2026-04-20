/**
 * GET /api/domains — 도메인 목록 조회
 * 응답: Array<{ id, name, displayName, path, implementingServiceCount }>
 *
 * implementingServiceCount 는 objectRelations 의 DISCOVERY implements 행 기준으로
 * 도메인별 구현 서비스 수를 서브쿼리로 집계한다 (N+1 회피).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, objectRelations, objects } from '@archi-navi/db';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const domains = await db
      .select({
        id: objects.id,
        name: objects.name,
        displayName: objects.displayName,
        path: objects.path,
        // 서브쿼리로 각 도메인의 implements(DISCOVERY) 관계 수 집계
        implementingServiceCount: sql<number>`(
          SELECT count(*)::int
          FROM ${objectRelations} r
          WHERE r.workspace_id = ${objects.workspaceId}
            AND r.object_id = ${objects.id}
            AND r.relation_type = 'implements'
            AND r.source = 'DISCOVERY'
        )`,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'domain'),
        ),
      );

    return NextResponse.json(domains);
  } catch (error) {
    console.error('[GET /api/domains]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
