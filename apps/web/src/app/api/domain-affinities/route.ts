/**
 * GET /api/domain-affinities — 서비스별 도메인 소속도 목록 조회
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, objectDomainAffinities } from '@archi-navi/db';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const rows = await db
      .select({
        objectId: objectDomainAffinities.objectId,
        domainId: objectDomainAffinities.domainId,
        affinity: objectDomainAffinities.affinity,
      })
      .from(objectDomainAffinities)
      .where(eq(objectDomainAffinities.workspaceId, workspaceId));

    return NextResponse.json(rows);
  } catch (error) {
    console.error('[GET /api/domain-affinities]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
