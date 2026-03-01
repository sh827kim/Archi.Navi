/**
 * GET  /api/tags?workspaceId=X — 태그 목록 (사용 개수 포함)
 * POST /api/tags — 태그 생성
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, tags, objectTags } from '@archi-navi/db';
import { eq, sql } from 'drizzle-orm';

/* ── GET: 태그 목록 + 각 태그의 Object 수 ── */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const db = await getDb();

    // 태그 목록과 사용 개수를 LEFT JOIN으로 조회
    const rows = await db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        createdAt: tags.createdAt,
        objectCount: sql<number>`count(${objectTags.objectId})`.as('object_count'),
      })
      .from(tags)
      .leftJoin(
        objectTags,
        sql`${tags.id} = ${objectTags.tagId} AND ${tags.workspaceId} = ${objectTags.workspaceId}`,
      )
      .where(eq(tags.workspaceId, workspaceId))
      .groupBy(tags.id, tags.name, tags.color, tags.createdAt)
      .orderBy(tags.name);

    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/tags]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/* ── POST: 태그 생성 ── */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      name?: string;
      color?: string;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: '태그 이름은 필수입니다' }, { status: 400 });
    }

    const db = await getDb();
    const [created] = await db
      .insert(tags)
      .values({
        workspaceId,
        name,
        color: body.color ?? '#6b7280',
      })
      .returning({ id: tags.id });

    return NextResponse.json({ id: created!.id }, { status: 201 });
  } catch (error) {
    // 이름 중복 시 unique constraint 위반
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('uq_tags_ws_name') || msg.includes('duplicate key')) {
      return NextResponse.json({ error: '이미 존재하는 태그 이름입니다' }, { status: 409 });
    }
    console.error('[POST /api/tags]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
