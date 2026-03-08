/**
 * GET /api/inference/candidates/:id/endpoints — COMPOUND→COMPOUND 후보의 세부 매핑용 엔드포인트 조회
 * 타겟 서비스 하위 api_endpoint 목록 반환
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, objects, relationCandidates } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = await getDb();

    // 후보 조회
    const [candidate] = await db
      .select({
        workspaceId: relationCandidates.workspaceId,
        objectId: relationCandidates.objectId,
        subjectObjectId: relationCandidates.subjectObjectId,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, id))
      .limit(1);

    if (!candidate) {
      return NextResponse.json({ error: '후보를 찾을 수 없습니다' }, { status: 404 });
    }

    // 타겟 서비스 하위 api_endpoint 조회
    const endpoints = await db
      .select({
        id: objects.id,
        name: objects.name,
        displayName: objects.displayName,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, candidate.workspaceId),
          eq(objects.objectType, 'api_endpoint'),
          eq(objects.parentId, candidate.objectId),
        ),
      );

    // 타겟 서비스 이름
    const [targetService] = await db
      .select({ name: objects.name, displayName: objects.displayName })
      .from(objects)
      .where(eq(objects.id, candidate.objectId))
      .limit(1);

    return NextResponse.json({
      candidateId: id,
      targetServiceName: targetService?.displayName ?? targetService?.name ?? 'unknown',
      endpoints: endpoints.map((ep) => {
        const meta = (ep.metadata ?? {}) as Record<string, unknown>;
        return {
          id: ep.id,
          name: ep.displayName ?? ep.name,
          method: (typeof meta['method'] === 'string' ? meta['method'] : 'ANY').toUpperCase(),
          path: typeof meta['path'] === 'string' ? meta['path'] : ep.name,
        };
      }),
    });
  } catch (error) {
    console.error('[GET /api/inference/candidates/:id/endpoints]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
