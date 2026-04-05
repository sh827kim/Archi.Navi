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
import { eq, and, inArray, asc, desc } from 'drizzle-orm';
import {
  CROSS_VALIDATION_CONTRADICTION_TYPES,
  CROSS_VALIDATION_RULE_IDS,
  summarizeCrossValidation,
  type CrossValidationSource,
  type CrossValidationContradiction,
} from '@/lib/cross-validation';

interface RelationFeedbackHint {
  key: string;
  applied: boolean;
  sampleCount: number;
  adjustment: number;
  baseConfidence?: number;
  adjustedConfidence?: number;
}

type CandidateMetadataSummary = Record<string, unknown> & {
  feedback?: RelationFeedbackHint;
  targetType?: 'api_endpoint' | 'db_table' | 'topic' | 'queue';
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asCanonicalFeedbackKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const segments = value.split(':');
  return (segments.length === 3 || segments.length === 5)
    && segments.every((segment) => segment.trim().length > 0)
    ? value
    : null;
}

function asRelationFeedbackHint(value: unknown): RelationFeedbackHint | null {
  const record = asRecord(value);
  if (!record) return null;

  const key = asCanonicalFeedbackKey(record['key']);
  if (!key) return null;

  const hint: RelationFeedbackHint = {
    key,
    applied: typeof record['applied'] === 'boolean' ? record['applied'] : false,
    sampleCount: isFiniteNumber(record['sampleCount'])
      ? Math.max(0, Math.round(record['sampleCount']))
      : 0,
    adjustment: isFiniteNumber(record['adjustment']) ? record['adjustment'] : 0,
  };

  if (isFiniteNumber(record['baseConfidence'])) {
    hint.baseConfidence = record['baseConfidence'];
  }
  if (isFiniteNumber(record['adjustedConfidence'])) {
    hint.adjustedConfidence = record['adjustedConfidence'];
  }

  return hint;
}

function asCandidateMetadataSummary(value: unknown): CandidateMetadataSummary | null {
  const record = asRecord(value);
  if (!record) return null;

  const feedback = asRelationFeedbackHint(record['feedback']);
  const targetType = record['targetType'] === 'api_endpoint'
    || record['targetType'] === 'db_table'
    || record['targetType'] === 'topic'
    || record['targetType'] === 'queue'
    ? record['targetType']
    : undefined;
  const normalized: CandidateMetadataSummary = { ...record };

  if (feedback) {
    normalized.feedback = feedback;
  } else {
    delete normalized.feedback;
  }

  if (targetType) {
    normalized.targetType = targetType;
  } else {
    delete normalized.targetType;
  }

  if (Object.keys(normalized).length === 0) {
    return null;
  }

  return normalized;
}

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

function isCrossValidationSource(value: unknown): value is CrossValidationSource {
  return value === 'config' || value === 'code' || value === 'db';
}

function asCrossValidationSources(value: unknown): CrossValidationSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCrossValidationSource);
}

function summarizePersistedCrossValidation(
  metadataCrossValidation: Record<string, unknown> | null,
  evidenceRows: Array<{ evidenceType: string | null }>,
) {
  const derivedSummary = summarizeCrossValidation(evidenceRows);
  const contradictions = asCrossValidationContradictions(
    metadataCrossValidation?.contradictions,
  );
  if (metadataCrossValidation) {
    const hasSupportingSources = Object.prototype.hasOwnProperty.call(
      metadataCrossValidation,
      'supportingSources',
    );
    const supportingSources = hasSupportingSources
      ? asCrossValidationSources(metadataCrossValidation.supportingSources)
      : derivedSummary.supportingSources;
    const supportCount =
      Object.prototype.hasOwnProperty.call(metadataCrossValidation, 'supportCount')
      && typeof metadataCrossValidation.supportCount === 'number'
      && Number.isFinite(metadataCrossValidation.supportCount)
        ? metadataCrossValidation.supportCount
        : supportingSources.length;
    const validated = Object.prototype.hasOwnProperty.call(metadataCrossValidation, 'validated')
      && typeof metadataCrossValidation.validated === 'boolean'
      ? metadataCrossValidation.validated
      : (supportCount >= 2 && contradictions.length === 0);

    return {
      validated,
      supportCount,
      supportingSources,
      contradictions,
    };
  }

  return summarizeCrossValidation(evidenceRows, contradictions);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const status = searchParams.get('status') ?? 'PENDING';
    const requestedLimit = Number.parseInt(searchParams.get('limit') ?? '100', 10);
    const requestedOffset = Number.parseInt(searchParams.get('offset') ?? '0', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

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
      .orderBy(
        desc(relationCandidates.confidence),
        asc(relationCandidates.createdAt),
        asc(relationCandidates.id),
      )
      .limit(limit)
      .offset(offset);

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
    const result = candidates.flatMap((c: typeof candidates[0]) => {
      const meta = c.metadata as Record<string, unknown> | null;
      const llmAssessment = meta?.llmAssessment ?? null;
      const llmExplanation =
        meta?.llmExplanation !== null && typeof meta?.llmExplanation === 'object'
          ? meta.llmExplanation
          : null;
      const feedback = asRelationFeedbackHint(meta?.feedback);
      const metadata = asCandidateMetadataSummary(meta);
      const source = typeof meta?.source === 'string' ? meta.source : null;
      const metadataCrossValidation =
        meta?.crossValidation !== null && typeof meta?.crossValidation === 'object'
          ? meta.crossValidation as Record<string, unknown>
          : null;
      const crossValidation = summarizePersistedCrossValidation(
        metadataCrossValidation,
        groupedEvidenceRows.get(c.id) ?? [],
      );

      const subjectObj = objMap.get(c.subjectObjectId);
      const objectObj = objMap.get(c.objectId);
      const rawTargetType = typeof meta?.targetType === 'string' ? meta.targetType : null;

      if (objectObj?.objectType === 'service' || rawTargetType === 'service') {
        return [];
      }

      // ATOMIC인 경우 parent(COMPOUND) 이름 조회
      const subjectParent = subjectObj?.parentId ? objMap.get(subjectObj.parentId) : null;
      const objectParent = objectObj?.parentId ? objMap.get(objectObj.parentId) : null;

      return [{
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
        ...(feedback ? { feedback } : {}),
        ...(metadata ? { metadata } : {}),
        ...(source ? { source } : {}),
        ...(llmAssessment ? { llmAssessment } : {}),
        ...(llmExplanation ? { llmExplanation } : {}),
      }];
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/inference/candidates]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
