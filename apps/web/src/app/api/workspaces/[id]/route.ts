/**
 * PATCH  /api/workspaces/:id — 워크스페이스 이름 수정
 * DELETE /api/workspaces/:id — 워크스페이스 삭제
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, workspaces } from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { normalizeWorkspaceName } from '@/lib/workspace-name';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { name?: string };
    const normalized = normalizeWorkspaceName(body.name);
    if ('error' in normalized) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const db = await getDb();
    const updated = await db
      .update(workspaces)
      .set({ name: normalized.name, updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .returning({ id: workspaces.id });

    if (updated.length === 0) {
      return NextResponse.json({ error: 'workspace not found' }, { status: 404 });
    }

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
    const deleted = await db
      .delete(workspaces)
      .where(eq(workspaces.id, id))
      .returning({ id: workspaces.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: 'workspace not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/workspaces/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
