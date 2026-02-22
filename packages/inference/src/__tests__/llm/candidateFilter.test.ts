/**
 * LLM 추론 후보 필터링 — 핵심 로직 통합 테스트
 * PGlite 인메모리 DB + mock LLM으로 검증
 * 설계 참조: docs/09-llm-inference-filtering.md §4, §6
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
import { filterCandidates } from '../../llm/candidateFilter.js';
import type {
  LlmAssessment,
  GenerateAssessmentFn,
  CandidateContext,
} from '../../llm/types.js';

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
});
