// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  createRelationChangeEventMock: vi.fn(() => ({ type: 'RELATION_APPROVED' })),
  relationCandidatesMock: {
    workspaceId: 'relation_candidates.workspace_id',
    relationType: 'relation_candidates.relation_type',
    subjectObjectId: 'relation_candidates.subject_object_id',
    objectId: 'relation_candidates.object_id',
    id: 'relation_candidates.id',
  },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  relationCandidates: relationCandidatesMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

vi.mock('@archi-navi/inference', () => ({
  approveRelationCandidate: approveRelationCandidateMock,
}));

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createRelationChangeEvent: createRelationChangeEventMock,
}));

import { PATCH } from '@/app/api/inference/candidates/[id]/route';

describe('PATCH /api/inference/candidates/[id]', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('승인 시 delta rebuild용 rollup 변경 이벤트를 적용해야 한다', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              relationType: 'call',
              subjectObjectId: 'svc-a',
              objectId: 'svc-b',
            }],
          }),
        }),
      }),
    };
    getDbMock.mockResolvedValue(db);
    approveRelationCandidateMock.mockResolvedValue({ ok: true, relationId: 'rel-1' });

    const response = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED' }),
      }) as never,
      { params: Promise.resolve({ id: 'cand-1' }) },
    );

    expect(response.status).toBe(200);
    expect(approveRelationCandidateMock).toHaveBeenCalledWith(db, 'cand-1', 'APPROVED');
    expect(createRelationChangeEventMock).toHaveBeenCalledWith('APPROVED', {
      relationType: 'call',
      subjectObjectId: 'svc-a',
      objectId: 'svc-b',
    });
    expect(applyRollupChangesMock).toHaveBeenCalledWith(db, 'ws-1', [{ type: 'RELATION_APPROVED' }]);
  });

  it('거부 시 rollup 변경 이벤트를 발행하지 않아야 한다', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              relationType: 'call',
              subjectObjectId: 'svc-a',
              objectId: 'svc-b',
            }],
          }),
        }),
      }),
    };
    getDbMock.mockResolvedValue(db);
    approveRelationCandidateMock.mockResolvedValue({ ok: true });

    const response = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REJECTED' }),
      }) as never,
      { params: Promise.resolve({ id: 'cand-1' }) },
    );

    expect(response.status).toBe(200);
    expect(applyRollupChangesMock).not.toHaveBeenCalled();
    expect(createRelationChangeEventMock).not.toHaveBeenCalled();
  });
});
