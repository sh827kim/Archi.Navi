/**
 * GET /api/inference/candidates — 관계 후보 목록 조회
 * POST /api/inference/run — 추론 실행
 */
import { type NextRequest, NextResponse } from 'next/server';
import {
  evidences,
  getDb,
  objects,
  relationCandidateEvidences,
  relationCandidates,
} from '@archi-navi/db';
import { eq, and, inArray } from 'drizzle-orm';
import {
  CROSS_VALIDATION_CONTRADICTION_TYPES,
  CROSS_VALIDATION_RULE_IDS,
  summarizeCrossValidation,
  type CrossValidationContradiction,
} from '@/lib/cross-validation';

function isCrossValidationRuleId(value: unknown): value is CrossValidationContradiction['ruleId'] {
  return typeof value === 'string'
    && CROSS_VALIDATION_RULE_IDS.includes(value as CrossValidationContradiction['ruleId']);
}

function isCrossValidationContradictionType(
  value: unknown,
): value is CrossValidationContradiction['type'] {
  return typeof value === 'string'
    && CROSS_VALIDATION_CONTRADICTION_TYPES.includes(value as CrossValidationContradiction['type']);
}

function asCrossValidationContradictions(value: unknown): CrossValidationContradiction[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      !isCrossValidationRuleId(record['ruleId'])
      || !isCrossValidationContradictionType(record['type'])
      || typeof record['penalty'] !== 'number'
    ) {
      return [];
    }

    return [{
      ruleId: record['ruleId'],
      type: record['type'],
      penalty: record['penalty'],
    }];
  });
}

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

    const candidateIds = candidates.map((candidate) => candidate.id);
    const evidenceRows = candidateIds.length > 0
      ? await db
        .select({
          candidateId: relationCandidateEvidences.candidateId,
          evidenceType: evidences.evidenceType,
        })
        .from(relationCandidateEvidences)
        .innerJoin(evidences, eq(relationCandidateEvidences.evidenceId, evidences.id))
        .where(
          and(
            eq(relationCandidateEvidences.workspaceId, workspaceId),
            inArray(relationCandidateEvidences.candidateId, candidateIds),
          ),
        )
      : [];

    const groupedEvidenceRows = new Map<string, Array<{ evidenceType: string | null }>>();
    for (const row of evidenceRows) {
      const current = groupedEvidenceRows.get(row.candidateId) ?? [];
      current.push({ evidenceType: row.evidenceType });
      groupedEvidenceRows.set(row.candidateId, current);
    }

    // Object 정보 맵 (이름, granularity, parentId 포함)
    const allObjects = await db
      .select({
        id: objects.id,
        displayName: objects.displayName,
        name: objects.name,
        granularity: objects.granularity,
        parentId: objects.parentId,
        objectType: objects.objectType,
      })
      .from(objects)
      .where(eq(objects.workspaceId, workspaceId));

    type ObjInfo = {
      displayName: string | null;
      name: string;
      granularity: string;
      parentId: string | null;
      objectType: string;
    };
    const objMap = new Map<string, ObjInfo>(
      allObjects.map((o) => [o.id, o])
    );

    // 응답 변환 (granularity, parent 정보 포함)
    const result = candidates.map((c: typeof candidates[0]) => {
      const meta = c.metadata as Record<string, unknown> | null;
      const llmAssessment = meta?.llmAssessment ?? null;
      const source = typeof meta?.source === 'string' ? meta.source : null;
      const metadataCrossValidation =
        meta?.crossValidation !== null && typeof meta?.crossValidation === 'object'
          ? meta.crossValidation as Record<string, unknown>
          : null;
      const contradictions = asCrossValidationContradictions(
        metadataCrossValidation?.contradictions,
      );
      const crossValidation = summarizeCrossValidation(
        groupedEvidenceRows.get(c.id) ?? [],
        contradictions,
      );

      const subjectObj = objMap.get(c.subjectObjectId);
      const objectObj = objMap.get(c.objectId);

      // ATOMIC인 경우 parent(COMPOUND) 이름 조회
      const subjectParent = subjectObj?.parentId ? objMap.get(subjectObj.parentId) : null;
      const objectParent = objectObj?.parentId ? objMap.get(objectObj.parentId) : null;

      return {
        id: c.id,
        subjectName: subjectObj?.displayName ?? subjectObj?.name ?? c.subjectObjectId,
        subjectGranularity: subjectObj?.granularity ?? 'ATOMIC',
        subjectParentName: subjectParent ? (subjectParent.displayName ?? subjectParent.name) : null,
        subjectObjectType: subjectObj?.objectType ?? null,
        relationType: c.relationType,
        objectName: objectObj?.displayName ?? objectObj?.name ?? c.objectId,
        objectGranularity: objectObj?.granularity ?? 'ATOMIC',
        objectParentName: objectParent ? (objectParent.displayName ?? objectParent.name) : null,
        objectObjectType: objectObj?.objectType ?? null,
        objectId: c.objectId,
        subjectObjectId: c.subjectObjectId,
        confidence: c.confidence,
        status: c.status,
        crossValidation,
        ...(source ? { source } : {}),
        ...(llmAssessment ? { llmAssessment } : {}),
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/inference/candidates]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
