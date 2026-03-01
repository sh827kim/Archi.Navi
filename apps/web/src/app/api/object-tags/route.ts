/**
 * GET /api/object-tags — 워크스페이스 내 모든 Object의 태그 일괄 조회
 *
 * Object별로 개별 API를 N번 호출하는 대신 한 번의 JOIN으로
 * { objectId → Tag[] } 매핑을 반환한다.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, tags, objectTags } from '@archi-navi/db';
import { asc, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();

    // objectTags → tags JOIN, 해당 워크스페이스 전체
    const rows = await db
      .select({
        objectId: objectTags.objectId,
        tagId: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(objectTags)
      .innerJoin(tags, eq(objectTags.tagId, tags.id))
      .where(eq(objectTags.workspaceId, workspaceId))
      .orderBy(asc(objectTags.objectId), asc(tags.name));

    // objectId 기준으로 그룹화 → Record<objectId, Tag[]>
    const result: Record<string, { id: string; name: string; color: string | null }[]> = {};
    for (const row of rows) {
      if (!result[row.objectId]) result[row.objectId] = [];
      result[row.objectId]!.push({ id: row.tagId, name: row.name, color: row.color });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/object-tags]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
