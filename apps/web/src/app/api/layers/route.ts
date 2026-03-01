/**
 * GET  /api/layers — 레이어 목록 조회 (sortOrder 순)
 * POST /api/layers — 레이어 생성
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, architectureLayers } from '@archi-navi/db';
import { eq, asc } from 'drizzle-orm';
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
      .from(architectureLayers)
      .where(eq(architectureLayers.workspaceId, workspaceId))
      .orderBy(asc(architectureLayers.sortOrder));

    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/layers]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      name: string;
      displayName?: string;
      color?: string;
      sortOrder?: number;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const id = generateId();

    const db = await getDb();
    await db.insert(architectureLayers).values({
      id,
      workspaceId,
      name: body.name,
      displayName: body.displayName ?? null,
      color: body.color ?? null,
      sortOrder: body.sortOrder ?? 0,
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/layers]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
