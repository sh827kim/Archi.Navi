import { type NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, relationCandidates } from '@archi-navi/db';
import { approveRelationCandidate } from '@archi-navi/inference';
import { applyRollupChanges, createRelationChangeEvent } from '@/lib/rollup-change-events';

interface BulkCandidateActionRequest {
  workspaceId?: string;
  ids?: string[];
  status?: 'APPROVED' | 'REJECTED';
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as BulkCandidateActionRequest;
    const workspaceId = body.workspaceId;
    const status = body.status;
    const ids = Array.from(new Set((body.ids ?? []).filter((id) => typeof id === 'string' && id.length > 0)));

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      return NextResponse.json({ error: 'status는 APPROVED 또는 REJECTED 이어야 합니다' }, { status: 400 });
    }
    if (ids.length === 0) {
      return NextResponse.json({ error: 'ids is required' }, { status: 400 });
    }

    const db = await getDb();
    const candidates = await db
      .select({
        id: relationCandidates.id,
        relationType: relationCandidates.relationType,
        subjectObjectId: relationCandidates.subjectObjectId,
        objectId: relationCandidates.objectId,
      })
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          inArray(relationCandidates.id, ids),
        ),
      );

    if (candidates.length === 0) {
      return NextResponse.json({ error: '처리할 후보를 찾을 수 없습니다.' }, { status: 404 });
    }

    let updatedCount = 0;
    const approvedEvents: ReturnType<typeof createRelationChangeEvent>[] = [];
    const errors: Array<{ id: string; message: string }> = [];

    for (const candidate of candidates) {
      try {
        await approveRelationCandidate(db, candidate.id, status);
        updatedCount += 1;
        if (status === 'APPROVED') {
          approvedEvents.push(
            createRelationChangeEvent('APPROVED', {
              relationType: candidate.relationType,
              subjectObjectId: candidate.subjectObjectId,
              objectId: candidate.objectId,
            }),
          );
        }
      } catch (error) {
        errors.push({
          id: candidate.id,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }

    if (approvedEvents.length > 0) {
      await applyRollupChanges(db, workspaceId, approvedEvents);
    }

    return NextResponse.json({
      ok: true,
      requestedCount: ids.length,
      matchedCount: candidates.length,
      updatedCount,
      errors,
    });
  } catch (error) {
    console.error('[PATCH /api/inference/candidates/bulk]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
