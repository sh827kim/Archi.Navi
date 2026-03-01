/**
 * LLM 추론 후보 필터링 — 핵심 로직
 * DB에서 PENDING 후보를 로딩 → LLM 평가 → metadata에 결과 저장
 * 설계 참조: docs/09-llm-inference-filtering.md §4, §6
 */
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  objects,
  relationCandidates,
  evidences,
  relationCandidateEvidences,
} from '@archi-navi/db';
import type {
  GenerateAssessmentFn,
  LlmFilterRequest,
  LlmFilterResult,
  CandidateContext,
  EvidenceSummary,
} from './types';
import { processBatch } from './batchProcessor';

/**
 * PENDING 후보를 로딩 (이미 llmAssessment가 있는 것은 제외)
 */
async function loadPendingCandidates(
  db: DbClient,
  workspaceId: string,
  candidateIds?: string[],
) {
  let query = db
    .select()
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, workspaceId),
        eq(relationCandidates.status, 'PENDING'),
      ),
    )
    .limit(200);

  const rows = await query;

  // candidateIds가 지정된 경우 필터
  let filtered = candidateIds
    ? rows.filter((r) => candidateIds.includes(r.id))
    : rows;

  // 이미 llmAssessment가 있는 후보 제외
  filtered = filtered.filter((r) => {
    const meta = r.metadata as Record<string, unknown>;
    return !meta?.llmAssessment;
  });

  return filtered;
}

/**
 * Object ID → 이름 매핑 조회
 */
async function buildObjectNameMap(
  db: DbClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const allObjects = await db
    .select({
      id: objects.id,
      name: objects.name,
      displayName: objects.displayName,
    })
    .from(objects)
    .where(eq(objects.workspaceId, workspaceId));

  return new Map(
    allObjects.map((o) => [o.id, o.displayName ?? o.name]),
  );
}

/**
 * 후보 ID → Evidence 목록 조회
 */
async function loadEvidencesForCandidates(
  db: DbClient,
  workspaceId: string,
  candidateIds: string[],
): Promise<Map<string, EvidenceSummary[]>> {
  const map = new Map<string, EvidenceSummary[]>();

  // 각 candidateId에 대해 개별 쿼리 (PGlite에서 inArray 호환성)
  for (const cid of candidateIds) {
    const links = await db
      .select({ evidenceId: relationCandidateEvidences.evidenceId })
      .from(relationCandidateEvidences)
      .where(
        and(
          eq(relationCandidateEvidences.workspaceId, workspaceId),
          eq(relationCandidateEvidences.candidateId, cid),
        ),
      );

    const evidenceList: EvidenceSummary[] = [];
    for (const link of links) {
      const [ev] = await db
        .select()
        .from(evidences)
        .where(eq(evidences.id, link.evidenceId))
        .limit(1);
      if (ev) {
        evidenceList.push({
          filePath: ev.filePath,
          lineStart: ev.lineStart,
          lineEnd: ev.lineEnd,
          excerpt: ev.excerpt,
          evidenceType: ev.evidenceType,
        });
      }
    }
    map.set(cid, evidenceList);
  }

  return map;
}

/**
 * LLM 평가 결과를 candidate metadata에 저장
 */
async function saveAssessment(
  db: DbClient,
  candidateId: string,
  assessment: NonNullable<import('./types').LlmAssessment>,
  existingMetadata: Record<string, unknown>,
) {
  const updatedMeta = {
    ...existingMetadata,
    llmAssessment: assessment,
  };

  await db
    .update(relationCandidates)
    .set({ metadata: updatedMeta })
    .where(eq(relationCandidates.id, candidateId));
}

/**
 * LLM 추론 후보 필터링 메인 함수
 * @param db 데이터베이스 클라이언트
 * @param generateFn LLM 호출 추상화 함수 (DI)
 * @param request 필터 요청
 */
export async function filterCandidates(
  db: DbClient,
  generateFn: GenerateAssessmentFn,
  request: LlmFilterRequest,
): Promise<LlmFilterResult> {
  const startTime = Date.now();
  const { workspaceId, candidateIds, batchSize = 10 } = request;

  // 1. PENDING 후보 로딩 (이미 평가된 것 제외)
  const candidates = await loadPendingCandidates(db, workspaceId, candidateIds);

  if (candidates.length === 0) {
    return {
      processedCount: 0,
      stats: { likelyValid: 0, uncertain: 0, likelyFalsePositive: 0 },
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Object 이름 매핑
  const nameMap = await buildObjectNameMap(db, workspaceId);

  // 3. Evidence 매핑
  const candidateIdList = candidates.map((c) => c.id);
  const evidenceMap = await loadEvidencesForCandidates(db, workspaceId, candidateIdList);

  // 4. CandidateContext 조립
  const contexts: CandidateContext[] = candidates.map((c) => ({
    candidateId: c.id,
    subjectName: nameMap.get(c.subjectObjectId) ?? c.subjectObjectId,
    objectName: nameMap.get(c.objectId) ?? c.objectId,
    relationType: c.relationType,
    confidence: c.confidence,
    evidences: evidenceMap.get(c.id) ?? [],
    metadata: c.metadata as Record<string, unknown>,
  }));

  // 5. 배치 처리
  const batchResults = await processBatch(contexts, generateFn, batchSize);

  // 6. 결과 저장 + stats 집계
  const stats = { likelyValid: 0, uncertain: 0, likelyFalsePositive: 0 };
  let processedCount = 0;

  for (const result of batchResults) {
    if (!result.success || !result.assessment) continue;

    // metadata에 llmAssessment 저장
    const candidate = candidates.find((c) => c.id === result.candidateId);
    if (candidate) {
      await saveAssessment(
        db,
        result.candidateId,
        result.assessment,
        candidate.metadata as Record<string, unknown>,
      );
      processedCount++;

      // stats 집계
      switch (result.assessment.verdict) {
        case 'LIKELY_VALID':
          stats.likelyValid++;
          break;
        case 'UNCERTAIN':
          stats.uncertain++;
          break;
        case 'LIKELY_FALSE_POSITIVE':
          stats.likelyFalsePositive++;
          break;
      }
    }
  }

  return {
    processedCount,
    stats,
    durationMs: Date.now() - startTime,
  };
}
