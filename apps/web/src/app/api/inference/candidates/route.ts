/**
 * GET /api/inference/candidates — 관계 후보 목록 조회
 * POST /api/inference/run — 추론 실행
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { relationCandidates, objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const status = searchParams.get('status') ?? 'PENDING';

    const db = await getDb();

    // 후보 조회
    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.status, status as 'PENDING' | 'APPROVED' | 'REJECTED'),
        ),
      )
      .limit(100);

    // Object 이름 맵
    const allObjects = await db
      .select({ id: objects.id, displayName: objects.displayName, name: objects.name })
      .from(objects)
      .where(eq(objects.workspaceId, workspaceId));
    const objMap = new Map(
      allObjects.map((o: { id: string; displayName: string | null; name: string }) => [o.id, o.displayName ?? o.name])
    );

    // 응답 변환 (llmAssessment가 있으면 포함)
    const result = candidates.map((c: typeof candidates[0]) => {
      const meta = c.metadata as Record<string, unknown> | null;
      const llmAssessment = meta?.llmAssessment ?? null;
      return {
        id: c.id,
        subjectName: objMap.get(c.subjectObjectId) ?? c.subjectObjectId,
        relationType: c.relationType,
        objectName: objMap.get(c.objectId) ?? c.objectId,
        confidence: c.confidence,
        status: c.status,
        ...(llmAssessment ? { llmAssessment } : {}),
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/inference/candidates]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
