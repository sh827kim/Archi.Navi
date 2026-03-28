/**
 * LLM 추론 후보 필터링 — 핵심 로직 통합 테스트
 * PGlite 인메모리 DB + mock LLM으로 검증
 * 설계 참조: docs/09-llm-inference-filtering.md §4, §6
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  objects,
  workspaces,
  relationCandidates,
  evidences,
  relationCandidateEvidences,
} from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import {
  filterCandidates,
  generateCandidateExplanations,
  groupCandidateContextsBySubject,
} from '@/llm/candidateFilter';
import type {
  LlmAssessment,
  LlmExplanation,
  GenerateAssessmentFn,
  GenerateExplanationFn,
  CandidateContext,
} from '@/llm/types';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000030';

async function setupWorkspace(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'llm-filter-test' });
}

/** service object 생성 헬퍼 */
async function createService(db: TestDb, name: string): Promise<string> {
  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name,
    path: `/${id}`,
    depth: 0,
    metadata: {},
  });
  return id;
}

/** relation_candidate 생성 헬퍼 */
async function createCandidate(
  db: TestDb,
  subjectId: string,
  objectId: string,
  opts: {
    relationType?: string;
    confidence?: number;
    status?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const id = generateId();
  await db.insert(relationCandidates).values({
    id,
    workspaceId,
    relationType: opts.relationType ?? 'call',
    subjectObjectId: subjectId,
    objectId,
    confidence: opts.confidence ?? 0.7,
    status: opts.status ?? 'PENDING',
    metadata: opts.metadata ?? { source: 'code_signal' },
  });
  return id;
}

/** evidence 생성 + candidate에 연결 */
async function createEvidence(
  db: TestDb,
  candidateId: string,
  excerpt: string,
): Promise<string> {
  const id = generateId();
  await db.insert(evidences).values({
    id,
    workspaceId,
    evidenceType: 'FILE',
    filePath: 'src/main/java/Test.java',
    lineStart: 10,
    lineEnd: 15,
    excerpt,
    metadata: {},
  });
  await db.insert(relationCandidateEvidences).values({
    workspaceId,
    candidateId,
    evidenceId: id,
  });
  return id;
}

/** LIKELY_VALID를 반환하는 mock LLM */
function mockLlmValid(): GenerateAssessmentFn {
  return async (_prompt: string, _context: CandidateContext): Promise<LlmAssessment> => ({
    verdict: 'LIKELY_VALID',
    confidenceAdjustment: 0.1,
    reasoning: 'HTTP 호출 패턴이 유효합니다.',
    reviewPriority: 'LOW',
    model: 'mock-model',
    assessedAt: new Date().toISOString(),
  });
}

/** LIKELY_FALSE_POSITIVE를 반환하는 mock LLM */
function mockLlmFalsePositive(): GenerateAssessmentFn {
  return async (_prompt: string, _context: CandidateContext): Promise<LlmAssessment> => ({
    verdict: 'LIKELY_FALSE_POSITIVE',
    confidenceAdjustment: -0.2,
    reasoning: '테스트 코드에서 추출된 mock URL입니다.',
    reviewPriority: 'HIGH',
    model: 'mock-model',
    assessedAt: new Date().toISOString(),
  });
}

/** verdict를 인자에 따라 반환하는 mock LLM */
function mockLlmByIndex(verdicts: Array<LlmAssessment['verdict']>): GenerateAssessmentFn {
  let callIndex = 0;
  return async (_prompt: string, _context: CandidateContext): Promise<LlmAssessment> => {
    const verdict = verdicts[callIndex] ?? 'UNCERTAIN';
    callIndex++;
    return {
      verdict,
      confidenceAdjustment: verdict === 'LIKELY_VALID' ? 0.1 : verdict === 'LIKELY_FALSE_POSITIVE' ? -0.2 : 0,
      reasoning: `verdict: ${verdict}`,
      reviewPriority: verdict === 'LIKELY_FALSE_POSITIVE' ? 'HIGH' : 'LOW',
      model: 'mock-model',
      assessedAt: new Date().toISOString(),
    };
  };
}

function mockExplanationByCandidateId(): GenerateExplanationFn {
  return async (_prompt, contexts): Promise<Record<string, LlmExplanation>> => Object.fromEntries(
    contexts.map((context) => [
      context.candidateId,
      {
        summary: `${context.subjectName} 가 ${context.objectName} 를 ${context.relationType} 합니다.`,
        model: 'mock-model',
        explainedAt: new Date().toISOString(),
      },
    ]),
  );
}

describe('filterCandidates', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await setupWorkspace(db);
  });

  it('T4: LIKELY_VALID 판정 → metadata.llmAssessment 저장 확인', async () => {
    const subjectId = await createService(db, 'order-service');
    const objectId = await createService(db, 'payment-service');
    const candidateId = await createCandidate(db, subjectId, objectId);
    await createEvidence(db, candidateId, 'restTemplate.get("/api/pay")');

    const result = await filterCandidates(db, mockLlmValid(), {
      workspaceId,
      candidateIds: [candidateId],
    });

    expect(result.processedCount).toBe(1);
    expect(result.stats.likelyValid).toBe(1);

    // metadata에 llmAssessment가 저장되었는지 확인
    const [updated] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const meta = updated?.metadata as Record<string, unknown>;
    expect(meta?.llmAssessment).toBeDefined();

    const assessment = meta.llmAssessment as LlmAssessment;
    expect(assessment.verdict).toBe('LIKELY_VALID');
    expect(assessment.confidenceAdjustment).toBe(0.1);
    expect(assessment.reasoning).toContain('유효');
  });

  it('T5: LIKELY_FALSE_POSITIVE 판정 → metadata 저장 확인', async () => {
    const subjectId = await createService(db, 'test-service');
    const objectId = await createService(db, 'mock-service');
    const candidateId = await createCandidate(db, subjectId, objectId);

    const result = await filterCandidates(db, mockLlmFalsePositive(), {
      workspaceId,
      candidateIds: [candidateId],
    });

    expect(result.processedCount).toBe(1);
    expect(result.stats.likelyFalsePositive).toBe(1);

    const [updated] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const meta = updated?.metadata as Record<string, unknown>;
    const assessment = meta.llmAssessment as LlmAssessment;
    expect(assessment.verdict).toBe('LIKELY_FALSE_POSITIVE');
    expect(assessment.reviewPriority).toBe('HIGH');
  });

  it('T6: 이미 llmAssessment가 있는 후보 skip', async () => {
    const subjectId = await createService(db, 'already-assessed');
    const objectId = await createService(db, 'target');
    const candidateId = await createCandidate(db, subjectId, objectId, {
      metadata: {
        source: 'code_signal',
        llmAssessment: {
          verdict: 'LIKELY_VALID',
          confidenceAdjustment: 0.05,
          reasoning: '이미 평가됨',
          reviewPriority: 'LOW',
          model: 'old-model',
          assessedAt: '2026-02-21T00:00:00Z',
        },
      },
    });

    let llmCallCount = 0;
    const countingMock: GenerateAssessmentFn = async (_p, _c) => {
      llmCallCount++;
      return {
        verdict: 'UNCERTAIN',
        confidenceAdjustment: 0,
        reasoning: 'test',
        reviewPriority: 'MEDIUM',
        model: 'mock',
        assessedAt: new Date().toISOString(),
      };
    };

    const result = await filterCandidates(db, countingMock, {
      workspaceId,
      candidateIds: [candidateId],
    });

    expect(result.processedCount).toBe(0);
    expect(llmCallCount).toBe(0);
  });

  it('T7: PENDING이 아닌 후보 제외', async () => {
    const subjectId = await createService(db, 'approved-subject');
    const objectId = await createService(db, 'approved-object');
    const candidateId = await createCandidate(db, subjectId, objectId, {
      status: 'APPROVED',
    });

    const result = await filterCandidates(db, mockLlmValid(), {
      workspaceId,
      candidateIds: [candidateId],
    });

    expect(result.processedCount).toBe(0);
  });

  it('T8: 결과 stats 정확한 집계 (verdict별 카운트)', async () => {
    const subjectId = await createService(db, 'multi-subject');
    const obj1 = await createService(db, 'target-1');
    const obj2 = await createService(db, 'target-2');
    const obj3 = await createService(db, 'target-3');

    const c1 = await createCandidate(db, subjectId, obj1);
    const c2 = await createCandidate(db, subjectId, obj2);
    const c3 = await createCandidate(db, subjectId, obj3);

    const result = await filterCandidates(
      db,
      mockLlmByIndex(['LIKELY_VALID', 'LIKELY_FALSE_POSITIVE', 'UNCERTAIN']),
      { workspaceId, candidateIds: [c1, c2, c3] },
    );

    expect(result.processedCount).toBe(3);
    expect(result.stats.likelyValid).toBe(1);
    expect(result.stats.likelyFalsePositive).toBe(1);
    expect(result.stats.uncertain).toBe(1);
  });

  it('T9: candidateIds 미지정 시 전체 PENDING 후보 처리', async () => {
    const subjectId = await createService(db, 'all-subject');
    const obj1 = await createService(db, 'all-target-1');
    const obj2 = await createService(db, 'all-target-2');

    await createCandidate(db, subjectId, obj1);
    await createCandidate(db, subjectId, obj2);
    // APPROVED 후보는 처리되지 않아야 함
    await createCandidate(db, subjectId, obj1, { status: 'APPROVED', relationType: 'read' });

    const result = await filterCandidates(db, mockLlmValid(), {
      workspaceId,
    });

    expect(result.processedCount).toBe(2);
  });

  it('T13: confidenceAdjustment 범위 초과 시 clamp 처리', async () => {
    const subjectId = await createService(db, 'clamp-subject');
    const objectId = await createService(db, 'clamp-object');
    const candidateId = await createCandidate(db, subjectId, objectId);

    const outOfRangeMock: GenerateAssessmentFn = async () => ({
      verdict: 'LIKELY_VALID',
      confidenceAdjustment: 0.5, // 범위 초과 (+0.2 max)
      reasoning: 'test',
      reviewPriority: 'LOW',
      model: 'mock',
      assessedAt: new Date().toISOString(),
    });

    await filterCandidates(db, outOfRangeMock, {
      workspaceId,
      candidateIds: [candidateId],
    });

    const [updated] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const meta = updated?.metadata as Record<string, unknown>;
    const assessment = meta.llmAssessment as LlmAssessment;
    expect(assessment.confidenceAdjustment).toBe(0.2); // clamped to max
  });

  it('T14: 연결된 evidence가 없어도 정상 처리되어야 한다', async () => {
    const subjectId = await createService(db, 'missing-ev-subject');
    const objectId = await createService(db, 'missing-ev-object');
    const candidateId = await createCandidate(db, subjectId, objectId);

    const result = await filterCandidates(db, mockLlmValid(), {
      workspaceId,
      candidateIds: [candidateId],
    });

    expect(result.processedCount).toBe(1);
    expect(result.stats.likelyValid).toBe(1);
  });

  it('T15: 객체 이름이 없으면 objectId를 fallback 이름으로 사용해야 한다', async () => {
    const otherWorkspaceId = generateId();
    await db.insert(workspaces).values({ id: otherWorkspaceId, name: 'other-workspace' });

    const unknownSubjectId = generateId();
    const unknownObjectId = generateId();
    await db.insert(objects).values([
      {
        id: unknownSubjectId,
        workspaceId: otherWorkspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'other-subject',
        path: `/${unknownSubjectId}`,
        depth: 0,
        metadata: {},
      },
      {
        id: unknownObjectId,
        workspaceId: otherWorkspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'other-object',
        path: `/${unknownObjectId}`,
        depth: 0,
        metadata: {},
      },
    ]);

    const candidateId = await createCandidate(db, unknownSubjectId, unknownObjectId);

    let captured: CandidateContext | null = null;
    const captureMock: GenerateAssessmentFn = async (_prompt, context) => {
      captured = context;
      return {
        verdict: 'UNCERTAIN',
        confidenceAdjustment: 0,
        reasoning: 'fallback-name-check',
        reviewPriority: 'MEDIUM',
        model: 'mock-model',
        assessedAt: new Date().toISOString(),
      };
    };

    const result = await filterCandidates(db, captureMock, {
      workspaceId,
      candidateIds: [candidateId],
    });

    expect(result.processedCount).toBe(1);
    expect(captured?.subjectName).toBe(unknownSubjectId);
    expect(captured?.objectName).toBe(unknownObjectId);
  });

  it('C3: 같은 subjectObjectId 기준으로 설명 배치를 그룹화해야 한다', () => {
    const grouped = groupCandidateContextsBySubject([
      {
        candidateId: 'cand-1',
        subjectObjectId: 'svc-a',
        subjectName: 'svc-a',
        objectId: 'obj-1',
        objectName: 'obj-1',
        relationType: 'call',
        confidence: 0.8,
        evidences: [],
        metadata: {},
      },
      {
        candidateId: 'cand-2',
        subjectObjectId: 'svc-a',
        subjectName: 'svc-a',
        objectId: 'obj-2',
        objectName: 'obj-2',
        relationType: 'call',
        confidence: 0.7,
        evidences: [],
        metadata: {},
      },
      {
        candidateId: 'cand-3',
        subjectObjectId: 'svc-b',
        subjectName: 'svc-b',
        objectId: 'obj-3',
        objectName: 'obj-3',
        relationType: 'publish',
        confidence: 0.6,
        evidences: [],
        metadata: {},
      },
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.map((item) => item.candidateId)).toEqual(['cand-1', 'cand-2']);
    expect(grouped[1]?.map((item) => item.candidateId)).toEqual(['cand-3']);
  });

  it('C2: 생성된 설명을 metadata.llmExplanation 에 저장해야 한다', async () => {
    const subjectId = await createService(db, 'order-service');
    const objectId = await createService(db, 'payment-service');
    const candidateId = await createCandidate(db, subjectId, objectId);
    await createEvidence(db, candidateId, 'restTemplate.get("/api/pay")');

    const result = await generateCandidateExplanations(db, mockExplanationByCandidateId(), {
      workspaceId,
      candidateIds: [candidateId],
      generateExplanations: true,
    });

    expect(result.processedCandidateCount).toBe(1);
    expect(result.generatedCount).toBe(1);
    expect(result.callCount).toBe(1);

    const [updated] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const meta = updated?.metadata as Record<string, unknown>;
    expect(meta?.llmExplanation).toBeDefined();
    expect((meta.llmExplanation as LlmExplanation).summary).toContain('payment-service');
  });

  it('C4: maxCalls 초과 시 남은 후보는 skip 해야 한다', async () => {
    const subjectA = await createService(db, 'subject-a');
    const subjectB = await createService(db, 'subject-b');
    const objectA = await createService(db, 'target-a');
    const objectB = await createService(db, 'target-b');
    const candidateA = await createCandidate(db, subjectA, objectA);
    const candidateB = await createCandidate(db, subjectB, objectB);

    const result = await generateCandidateExplanations(db, mockExplanationByCandidateId(), {
      workspaceId,
      candidateIds: [candidateA, candidateB],
      generateExplanations: true,
      maxCalls: 1,
    });

    expect(result.processedCandidateCount).toBe(2);
    expect(result.generatedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.callCount).toBe(1);

    const updatedRows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    const explainedCount = updatedRows.filter((row) => {
      const meta = row.metadata as Record<string, unknown> | null;
      return Boolean(meta?.llmExplanation);
    }).length;
    expect(explainedCount).toBe(1);
  });

  it('C5: generateExplanations=false 면 LLM 호출이 없어야 한다', async () => {
    const subjectId = await createService(db, 'subject-no-call');
    const objectId = await createService(db, 'object-no-call');
    await createCandidate(db, subjectId, objectId);

    const generateFn = vi.fn(async () => ({}));
    const result = await generateCandidateExplanations(db, generateFn, {
      workspaceId,
      generateExplanations: false,
    });

    expect(result.generatedCount).toBe(0);
    expect(result.callCount).toBe(0);
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('C6: LLM 실패 시 기존 metadata 는 유지하고 계속 진행해야 한다', async () => {
    const subjectA = await createService(db, 'subject-fail');
    const subjectB = await createService(db, 'subject-pass');
    const objectA = await createService(db, 'object-fail');
    const objectB = await createService(db, 'object-pass');
    const candidateA = await createCandidate(db, subjectA, objectA, {
      metadata: { source: 'code_signal', keep: 'before' },
    });
    const candidateB = await createCandidate(db, subjectB, objectB, {
      metadata: { source: 'code_signal', keep: 'before' },
    });

    const generateFn: GenerateExplanationFn = async (_prompt, contexts) => {
      if (contexts[0]?.subjectObjectId === subjectA) {
        throw new Error('mock failure');
      }
      return {
        [candidateB]: {
          summary: '정상 설명',
          model: 'mock-model',
          explainedAt: new Date().toISOString(),
        },
      };
    };

    const result = await generateCandidateExplanations(db, generateFn, {
      workspaceId,
      candidateIds: [candidateA, candidateB],
      generateExplanations: true,
      maxCalls: 5,
    });

    expect(result.generatedCount).toBe(1);
    expect(result.callCount).toBe(2);

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    const failedCandidate = rows.find((row) => row.id === candidateA);
    const passedCandidate = rows.find((row) => row.id === candidateB);

    expect((failedCandidate?.metadata as Record<string, unknown>)?.keep).toBe('before');
    expect((failedCandidate?.metadata as Record<string, unknown>)?.llmExplanation).toBeUndefined();
    expect((passedCandidate?.metadata as Record<string, unknown>)?.llmExplanation).toBeDefined();
  });
});
