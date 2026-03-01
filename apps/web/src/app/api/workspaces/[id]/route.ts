/**
 * PATCH  /api/workspaces/:id — 워크스페이스 이름 수정
 * DELETE /api/workspaces/:id — 워크스페이스 삭제
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, workspaces } from '@archi-navi/db';
import { eq } from 'drizzle-orm';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { name?: string };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const db = await getDb();
    await db
      .update(workspaces)
      .set({ name: body.name.trim(), updatedAt: new Date() })
      .where(eq(workspaces.id, id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[PATCH /api/workspaces/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const db = await getDb();
    await db.delete(workspaces).where(eq(workspaces.id, id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/workspaces/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
