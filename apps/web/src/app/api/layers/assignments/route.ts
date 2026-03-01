/**
 * GET    /api/layers/assignments — 전체 배치 조회
 * POST   /api/layers/assignments — Object를 Layer에 배치
 * DELETE /api/layers/assignments — 배치 해제 (objectId 쿼리 파라미터)
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, objectLayerAssignments } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const rows = await db
      .select()
      .from(objectLayerAssignments)
      .where(eq(objectLayerAssignments.workspaceId, workspaceId));

    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/layers/assignments]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      objectId: string;
      layerId: string;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const id = generateId();
    const db = await getDb();

    // 기존 배치 삭제 (upsert)
    await db
      .delete(objectLayerAssignments)
      .where(
        and(
          eq(objectLayerAssignments.workspaceId, workspaceId),
          eq(objectLayerAssignments.objectId, body.objectId),
        ),
      );

    // 새 배치 삽입
    await db.insert(objectLayerAssignments).values({
      id,
      workspaceId,
      objectId: body.objectId,
      layerId: body.layerId,
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/layers/assignments]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const objectId = req.nextUrl.searchParams.get('objectId');
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');

    if (!objectId) {
      return NextResponse.json({ error: 'objectId is required' }, { status: 400 });
    }
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    await db
      .delete(objectLayerAssignments)
      .where(
        and(
          eq(objectLayerAssignments.workspaceId, workspaceId),
          eq(objectLayerAssignments.objectId, objectId),
        ),
      );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/layers/assignments]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
