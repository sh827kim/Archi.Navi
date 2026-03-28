/**
 * GET  /api/workspaces — 전체 워크스페이스 목록
 * POST /api/workspaces — 새 워크스페이스 생성
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, workspaces } from '@archi-navi/db';
import { asc } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { normalizeWorkspaceName } from '@/lib/workspace-name';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
} as const;

export async function GET() {
  try {
    const db = await getDb();
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .orderBy(asc(workspaces.createdAt));

    return NextResponse.json(rows, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('[GET /api/workspaces]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { name: string };
    const normalized = normalizeWorkspaceName(body.name);
    if ('error' in normalized) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const id = generateId();
    const db = await getDb();

    await db.insert(workspaces).values({
      id,
      name: normalized.name,
    });

    return NextResponse.json({ id, name: normalized.name }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/workspaces]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
