/**
 * GET /api/objects — Object 목록 조회
 * POST /api/objects — Object 등록
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { generateId, buildPath } from '@archi-navi/shared';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const objectType = searchParams.get('objectType');

    const db = await getDb();

    const query = db
      .select()
      .from(objects)
      .where(eq(objects.workspaceId, workspaceId));

    const result = await query;

    // objectType 필터링
    const filtered = objectType
      ? result.filter((o: typeof result[0]) => o.objectType === objectType)
      : result;

    return NextResponse.json(filtered);
  } catch (error) {
    console.error('[GET /api/objects]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      objectType: string;
      name: string;
      displayName?: string;
      granularity?: string;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const id = generateId();

    const db = await getDb();
    await db.insert(objects).values({
      id,
      workspaceId,
      objectType: body.objectType,
      category: null,
      granularity: (body.granularity as 'ATOMIC' | 'COMPOUND') ?? 'ATOMIC',
      name: body.name,
      displayName: body.displayName ?? null,
      path: buildPath(null, id),
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/objects]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
