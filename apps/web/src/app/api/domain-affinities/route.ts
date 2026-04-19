/**
 * GET /api/domain-affinities — 객체별 도메인 소속도 목록 조회
 *
 * 신규 도메인 엔진(Phase 1 발견 / 승인 흐름)도 동일하게
 * objectDomainAffinities 테이블에 source='APPROVED_INFERENCE' 행을 쓰므로
 * 이 엔드포인트는 그대로 재사용된다 (mapping graph fetchData 가 의존).
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
