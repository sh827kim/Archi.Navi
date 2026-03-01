/**
 * GET /api/domains — 도메인 목록 조회
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const domains = await db
      .select()
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
