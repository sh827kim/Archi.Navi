/**
 * PATCH /api/inference/candidates/:id — 후보 상태 변경 (승인/거부)
 * 승인 시 → object_relations에 APPROVED 상태로 이동
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, relationCandidates } from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { approveRelationCandidate } from '@archi-navi/inference';
import { applyRollupChanges, createRelationChangeEvent } from '@/lib/rollup-change-events';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { status: 'APPROVED' | 'REJECTED' };

    if (!['APPROVED', 'REJECTED'].includes(body.status)) {
      return NextResponse.json(
        { error: 'status는 APPROVED 또는 REJECTED 이어야 합니다' },
        { status: 400 },
      );
    }

    const db = await getDb();
    const [candidate] = await db
      .select({
        workspaceId: relationCandidates.workspaceId,
        status: relationCandidates.status,
        relationType: relationCandidates.relationType,
        subjectObjectId: relationCandidates.subjectObjectId,
        objectId: relationCandidates.objectId,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(eq(relationCandidates.id, id))
      .limit(1);

    if (!candidate) {
      return NextResponse.json({ error: '후보를 찾을 수 없습니다' }, { status: 404 });
    }

    const result = await approveRelationCandidate(db, id, body.status);

    if (body.status === 'APPROVED') {
      await applyRollupChanges(db, candidate.workspaceId, [
        createRelationChangeEvent('APPROVED', {
          relationType: candidate.relationType,
          subjectObjectId: candidate.subjectObjectId,
          objectId: candidate.objectId,
        }),
      ]);
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'candidate not found') {
      return NextResponse.json({ error: '후보를 찾을 수 없습니다' }, { status: 404 });
    }
    console.error('[PATCH /api/inference/candidates/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
