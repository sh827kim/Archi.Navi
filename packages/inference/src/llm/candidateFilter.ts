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
  GenerateExplanationFn,
  LlmFilterRequest,
  LlmFilterResult,
  LlmExplanation,
  LlmExplanationRequest,
  LlmExplanationResult,
  CandidateContext,
  EvidenceSummary,
} from './types';
import { processBatch } from './batchProcessor';
import { buildRelationExplanationPrompt } from './prompts';

/**
 * PENDING 후보를 로딩 (이미 llmAssessment가 있는 것은 제외)
 */
async function loadPendingCandidates(
  db: DbClient,
  workspaceId: string,
  candidateIds?: string[],
  opts: {
    excludeMetadataKeys?: string[];
  } = {},
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
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const excludeMetadataKeys = opts.excludeMetadataKeys ?? ['llmAssessment'];
    return excludeMetadataKeys.every((key) => !meta[key]);
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

  // candidate별로 개별 조회해 driver별 array binding 차이를 피한다.
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

async function saveExplanation(
  db: DbClient,
  candidateId: string,
  explanation: LlmExplanation,
  existingMetadata: Record<string, unknown>,
) {
  const updatedMeta = {
    ...existingMetadata,
    llmExplanation: explanation,
  };

  await db
    .update(relationCandidates)
    .set({ metadata: updatedMeta })
    .where(eq(relationCandidates.id, candidateId));
}

async function buildCandidateContexts(
  db: DbClient,
  workspaceId: string,
  candidates: Array<{
    id: string;
    subjectObjectId: string;
    objectId: string;
    relationType: string;
    confidence: number;
    metadata: unknown;
  }>,
): Promise<CandidateContext[]> {
  const nameMap = await buildObjectNameMap(db, workspaceId);
  const candidateIdList = candidates.map((candidate) => candidate.id);
  const evidenceMap = await loadEvidencesForCandidates(db, workspaceId, candidateIdList);

  return candidates.map((candidate) => ({
    candidateId: candidate.id,
    subjectObjectId: candidate.subjectObjectId,
    subjectName: nameMap.get(candidate.subjectObjectId) ?? candidate.subjectObjectId,
    objectId: candidate.objectId,
    objectName: nameMap.get(candidate.objectId) ?? candidate.objectId,
    relationType: candidate.relationType,
    confidence: candidate.confidence,
    evidences: evidenceMap.get(candidate.id) ?? [],
    metadata: (candidate.metadata ?? {}) as Record<string, unknown>,
  }));
}

export function groupCandidateContextsBySubject(
  contexts: CandidateContext[],
): CandidateContext[][] {
  const grouped = new Map<string, CandidateContext[]>();

  for (const context of contexts) {
    const group = grouped.get(context.subjectObjectId) ?? [];
    group.push(context);
    grouped.set(context.subjectObjectId, group);
  }

  return [...grouped.values()];
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
  const candidates = await loadPendingCandidates(db, workspaceId, candidateIds, {
    excludeMetadataKeys: ['llmAssessment'],
  });

  if (candidates.length === 0) {
    return {
      processedCount: 0,
      stats: { likelyValid: 0, uncertain: 0, likelyFalsePositive: 0 },
      durationMs: Date.now() - startTime,
    };
  }

  // 2. CandidateContext 조립
  const contexts = await buildCandidateContexts(db, workspaceId, candidates);

  // 3. 배치 처리
  const batchResults = await processBatch(contexts, generateFn, batchSize);

  // 4. 결과 저장 + stats 집계
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

export async function generateCandidateExplanations(
  db: DbClient,
  generateFn: GenerateExplanationFn,
  request: LlmExplanationRequest,
): Promise<LlmExplanationResult> {
  const startTime = Date.now();
  const { workspaceId, candidateIds, generateExplanations = false } = request;
  const maxCalls = Math.max(0, request.maxCalls ?? 50);

  if (!generateExplanations) {
    return {
      processedCandidateCount: 0,
      generatedCount: 0,
      skippedCount: 0,
      callCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const candidates = await loadPendingCandidates(db, workspaceId, candidateIds, {
    excludeMetadataKeys: ['llmExplanation'],
  });

  if (candidates.length === 0) {
    return {
      processedCandidateCount: 0,
      generatedCount: 0,
      skippedCount: 0,
      callCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const contexts = await buildCandidateContexts(db, workspaceId, candidates);
  const groups = groupCandidateContextsBySubject(contexts);
  let generatedCount = 0;
  let skippedCount = 0;
  let callCount = 0;

  for (const group of groups) {
    if (callCount >= maxCalls) {
      skippedCount += group.length;
      continue;
    }

    try {
      callCount += 1;
      const explanations = await generateFn(buildRelationExplanationPrompt(group), group);

      for (const context of group) {
        const explanation = explanations[context.candidateId];
        if (!explanation) continue;

        const candidate = candidates.find((item) => item.id === context.candidateId);
        if (!candidate) continue;

        await saveExplanation(
          db,
          context.candidateId,
          explanation,
          (candidate.metadata ?? {}) as Record<string, unknown>,
        );
        generatedCount += 1;
      }
    } catch {
      // graceful degradation: 저장 없이 다음 그룹 진행
      continue;
    }
  }

  return {
    processedCandidateCount: candidates.length,
    generatedCount,
    skippedCount,
    callCount,
    durationMs: Date.now() - startTime,
  };
}
