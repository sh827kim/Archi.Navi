/**
 * GET    /api/objects/:id/tags — Object에 달린 태그 목록
 * POST   /api/objects/:id/tags — Object에 태그 추가
 * DELETE /api/objects/:id/tags — Object에서 태그 제거
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, tags, objectTags } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';

/* ── GET: Object에 달린 태그 목록 ── */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: objectId } = await params;
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();

    // objectTags → tags JOIN으로 태그 정보 조회
    const rows = await db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(objectTags)
      .innerJoin(tags, eq(objectTags.tagId, tags.id))
      .where(
        and(
          eq(objectTags.workspaceId, workspaceId),
          eq(objectTags.objectId, objectId),
        ),
      );

    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/objects/[id]/tags]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/* ── POST: Object에 태그 추가 ── */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: objectId } = await params;
    const body = (await req.json()) as {
      workspaceId?: string;
      tagId?: string;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!body.tagId) {
      return NextResponse.json({ error: 'tagId는 필수입니다' }, { status: 400 });
    }

    const db = await getDb();
    await db.insert(objectTags).values({
      workspaceId,
      objectId,
      tagId: body.tagId,
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    // 중복 삽입 무시 (이미 달린 태그)
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
      return NextResponse.json({ ok: true, message: '이미 추가된 태그입니다' });
    }
    console.error('[POST /api/objects/[id]/tags]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/* ── DELETE: Object에서 태그 제거 ── */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: objectId } = await params;
    const body = (await req.json()) as {
      workspaceId?: string;
      tagId?: string;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!body.tagId) {
      return NextResponse.json({ error: 'tagId는 필수입니다' }, { status: 400 });
    }

    const db = await getDb();
    await db.delete(objectTags).where(
      and(
        eq(objectTags.workspaceId, workspaceId),
        eq(objectTags.objectId, objectId),
        eq(objectTags.tagId, body.tagId),
      ),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/objects/[id]/tags]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
