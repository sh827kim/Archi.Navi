/**
 * POST /api/inference/candidates/:id/map-endpoints — COMPOUND→COMPOUND 후보를 ATOMIC 단위로 매핑
 * 사용자가 선택한 엔드포인트에 대해 개별 relation을 생성하고 원본 후보를 처리 완료
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, objects, relationCandidates, objectRelations, relationCandidateEvidences, relationEvidences } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { applyRollupChanges, createRelationChangeEvent } from '@/lib/rollup-change-events';

interface MapEndpointsBody {
  /** 선택한 엔드포인트 ID 목록 */
  endpointIds: string[];
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as MapEndpointsBody;
    const endpointIds = body.endpointIds ?? [];

    if (endpointIds.length === 0) {
      return NextResponse.json(
        { error: '최소 1개의 엔드포인트를 선택해야 합니다' },
        { status: 400 },
      );
    }

    const db = await getDb();

    // 원본 후보 조회
    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, id))
      .limit(1);

    if (!candidate) {
      return NextResponse.json({ error: '후보를 찾을 수 없습니다' }, { status: 404 });
    }

    if (candidate.status !== 'PENDING') {
      return NextResponse.json({ error: '이미 처리된 후보입니다' }, { status: 400 });
    }

    // 원본 후보의 evidence 조회
    const evidenceLinks = await db
      .select({ evidenceId: relationCandidateEvidences.evidenceId })
      .from(relationCandidateEvidences)
      .where(eq(relationCandidateEvidences.candidateId, id));

    const createdRelations: Array<{ endpointId: string; relationId: string }> = [];

    // 선택된 각 엔드포인트에 대해 relation 생성
    for (const endpointId of endpointIds) {
      // 엔드포인트가 실제로 타겟 서비스 하위인지 확인
      const [endpoint] = await db
        .select({ id: objects.id, parentId: objects.parentId })
        .from(objects)
        .where(
          and(
            eq(objects.id, endpointId),
            eq(objects.workspaceId, candidate.workspaceId),
            eq(objects.objectType, 'api_endpoint'),
          ),
        )
        .limit(1);

      if (!endpoint || endpoint.parentId !== candidate.objectId) continue;

      // 중복 relation 확인
      const existingRelation = await db
        .select({ id: objectRelations.id })
        .from(objectRelations)
        .where(
          and(
            eq(objectRelations.workspaceId, candidate.workspaceId),
            eq(objectRelations.relationType, candidate.relationType),
            eq(objectRelations.subjectObjectId, candidate.subjectObjectId),
            eq(objectRelations.objectId, endpointId),
          ),
        )
        .limit(1);

      if (existingRelation.length > 0) continue;

      // relation 생성
      const relationId = generateId();
      await db.insert(objectRelations).values({
        id: relationId,
        workspaceId: candidate.workspaceId,
        relationType: candidate.relationType,
        subjectObjectId: candidate.subjectObjectId,
        objectId: endpointId,
        confidence: candidate.confidence,
        status: 'APPROVED',
        source: 'INFERRED',
        metadata: {
          mappedFromCandidate: id,
          originalTargetServiceId: candidate.objectId,
        },
      });

      // evidence 연결
      for (const { evidenceId } of evidenceLinks) {
        await db.insert(relationEvidences)
          .values({
            workspaceId: candidate.workspaceId,
            relationId,
            evidenceId,
          })
          .onConflictDoNothing();
      }

      createdRelations.push({ endpointId, relationId });
    }

    // 원본 COMPOUND→COMPOUND 후보를 APPROVED (처리 완료)로 마킹
    await db
      .update(relationCandidates)
      .set({
        status: 'APPROVED',
        reviewedAt: new Date(),
        metadata: {
          ...(candidate.metadata as Record<string, unknown> ?? {}),
          mappedEndpoints: endpointIds,
          mappedRelationCount: createdRelations.length,
        },
      })
      .where(eq(relationCandidates.id, id));

    // 롤업 변경 적용
    const rollupEvents = createdRelations.map((r) =>
      createRelationChangeEvent('APPROVED', {
        relationType: candidate.relationType,
        subjectObjectId: candidate.subjectObjectId,
        objectId: r.endpointId,
      }),
    );
    if (rollupEvents.length > 0) {
      await applyRollupChanges(db, candidate.workspaceId, rollupEvents);
    }

    return NextResponse.json({
      ok: true,
      candidateId: id,
      createdRelationCount: createdRelations.length,
      createdRelations,
    });
  } catch (error) {
    console.error('[POST /api/inference/candidates/:id/map-endpoints]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
