// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getDbMock,
  approveRelationCandidateMock,
  applyRollupChangesMock,
  createRelationChangeEventMock,
  relationCandidatesMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  approveRelationCandidateMock: vi.fn(),
  applyRollupChangesMock: vi.fn(),
  createRelationChangeEventMock: vi.fn(() => ({ type: 'APPROVED' })),
  relationCandidatesMock: {
    id: 'relation_candidates.id',
    workspaceId: 'relation_candidates.workspace_id',
    status: 'relation_candidates.status',
    relationType: 'relation_candidates.relation_type',
    subjectObjectId: 'relation_candidates.subject_object_id',
    objectId: 'relation_candidates.object_id',
    metadata: 'relation_candidates.metadata',
  },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  relationCandidates: relationCandidatesMock,
}));

vi.mock('@archi-navi/inference', () => ({
  approveRelationCandidate: approveRelationCandidateMock,
}));

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createRelationChangeEvent: createRelationChangeEventMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

import { PATCH } from '@/app/api/inference/candidates/[id]/route';

describe('PATCH /api/inference/candidates/:id', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('PENDING 후보 승인 시 backend 승인 helper만 사용하고 rollup만 적용해야 한다', async () => {
    const selectMock = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              status: 'PENDING',
              relationType: 'call',
              subjectObjectId: 'svc-a',
              objectId: 'svc-b',
              metadata: { source: 'CODE', framework: 'spring-boot', language: 'java' },
            }],
          }),
        }),
      });
    const db = {
      select: selectMock,
    };
    getDbMock.mockResolvedValue(db);
    approveRelationCandidateMock.mockResolvedValue({
      success: true,
      status: 'APPROVED',
      relationId: 'rel-1',
      promotedEvidenceCount: 1,
    });

    const response = await PATCH(
      new NextRequest('http://localhost/api/inference/candidates/cand-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'APPROVED' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'cand-1' }) },
    );

    expect(response.status).toBe(200);
    expect(approveRelationCandidateMock).toHaveBeenCalledWith(db, 'cand-1', 'APPROVED');
    expect(createRelationChangeEventMock).toHaveBeenCalledWith('APPROVED', {
      relationType: 'call',
      subjectObjectId: 'svc-a',
      objectId: 'svc-b',
    });
    expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
  });
});
