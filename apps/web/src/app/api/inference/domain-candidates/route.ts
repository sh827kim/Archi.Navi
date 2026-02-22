/**
 * GET /api/inference/domain-candidates — 도메인 후보 목록 조회
 */
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { domainCandidates, objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId') ?? DEFAULT_WORKSPACE_ID;
    const status = searchParams.get('status') ?? 'PENDING';

    const db = await getDb();

    // 도메인 후보 조회
    const candidates = await db
      .select()
      .from(domainCandidates)
      .where(
        and(
          eq(domainCandidates.workspaceId, workspaceId),
          eq(domainCandidates.status, status as 'PENDING' | 'APPROVED' | 'REJECTED'),
        ),
      )
      .limit(100);

    // Object 이름 맵 (service + domain)
    const allObjects = await db
      .select({ id: objects.id, displayName: objects.displayName, name: objects.name })
      .from(objects)
      .where(eq(objects.workspaceId, workspaceId));
    const objMap = new Map(
      allObjects.map((o: { id: string; displayName: string | null; name: string }) => [
        o.id,
        o.displayName ?? o.name,
      ]),
    );

    // 응답 변환
    const result = candidates.map((c: typeof candidates[0]) => ({
      id: c.id,
      objectId: c.objectId,
      objectName: objMap.get(c.objectId) ?? c.objectId,
      primaryDomainId: c.primaryDomainId ?? null,
      primaryDomainName: c.primaryDomainId ? (objMap.get(c.primaryDomainId) ?? c.primaryDomainId) : null,
      purity: c.purity,
      affinityMap: c.affinityMap as Record<string, number>,
      signals: c.signals,
      status: c.status,
      createdAt: c.createdAt,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/inference/domain-candidates]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
