import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { createTestDb as createEmbeddedTestDb } from '@archi-navi/db';
import { objects, relationCandidates, workspaces } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';

vi.mock('@/llm/batchProcessor', () => ({
  processBatch: vi.fn(async () => [
    {
      candidateId: 'non-existent-candidate-id',
      success: true,
      assessment: {
        verdict: 'LIKELY_VALID',
        confidenceAdjustment: 0.1,
        reasoning: 'mock',
        reviewPriority: 'LOW',
        model: 'mock-model',
        assessedAt: new Date().toISOString(),
      },
    },
  ]),
}));

import { filterCandidates } from '@/llm/candidateFilter';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
const workspaceId = '00000000-0000-0000-0000-000000000130';

describe('filterCandidates edge cases', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'llm-edge-workspace' });

    const subjectId = generateId();
    const objectId = generateId();
    await db.insert(objects).values([
      {
        id: subjectId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'subject',
        path: `/${subjectId}`,
        depth: 0,
        metadata: {},
      },
      {
        id: objectId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'object',
        path: `/${objectId}`,
        depth: 0,
        metadata: {},
      },
    ]);

    await db.insert(relationCandidates).values({
      id: generateId(),
      workspaceId,
      relationType: 'call',
      subjectObjectId: subjectId,
      objectId,
      confidence: 0.7,
      status: 'PENDING',
      metadata: {},
    });
  });

  it('배치 결과의 candidateId가 DB 후보와 불일치하면 저장/카운트에서 제외해야 한다', async () => {
    const result = await filterCandidates(
      db,
      async () => ({
        verdict: 'LIKELY_VALID',
        confidenceAdjustment: 0.1,
        reasoning: 'unused',
        reviewPriority: 'LOW',
        model: 'unused',
        assessedAt: new Date().toISOString(),
      }),
      { workspaceId },
    );

    expect(result.processedCount).toBe(0);
    expect(result.stats.likelyValid).toBe(0);
    expect(result.stats.uncertain).toBe(0);
    expect(result.stats.likelyFalsePositive).toBe(0);
  });
});
