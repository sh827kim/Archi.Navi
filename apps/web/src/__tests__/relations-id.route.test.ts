// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  applyRollupChangesMock,
  createRelationChangeEventMock,
  isApprovedBaseRelationMock,
  objectRelationsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  applyRollupChangesMock: vi.fn(),
  createRelationChangeEventMock: vi.fn(() => ({ type: 'RELATION_DELETED' })),
  isApprovedBaseRelationMock: vi.fn(() => true),
  objectRelationsMock: {
    workspaceId: 'object_relations.workspace_id',
    relationType: 'object_relations.relation_type',
    subjectObjectId: 'object_relations.subject_object_id',
    objectId: 'object_relations.object_id',
    status: 'object_relations.status',
    isDerived: 'object_relations.is_derived',
    id: 'object_relations.id',
  },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  objectRelations: objectRelationsMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
}));

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createRelationChangeEvent: createRelationChangeEventMock,
  isApprovedBaseRelation: isApprovedBaseRelationMock,
}));

import { DELETE } from '@/app/api/relations/[id]/route';

describe('DELETE /api/relations/[id]', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('승인된 base relation 삭제 시 delta rebuild용 rollup 변경 이벤트를 적용해야 한다', async () => {
    const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              relationType: 'call',
              subjectObjectId: 'svc-a',
              objectId: 'svc-b',
              status: 'APPROVED',
              isDerived: false,
            }],
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: deleteWhereMock,
      }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await DELETE(
      new Request('http://localhost') as never,
      { params: Promise.resolve({ id: 'rel-1' }) },
    );

    expect(response.status).toBe(200);
    expect(deleteWhereMock).toHaveBeenCalled();
    expect(isApprovedBaseRelationMock).toHaveBeenCalledWith('APPROVED', false);
    expect(createRelationChangeEventMock).toHaveBeenCalledWith('DELETED', {
      relationType: 'call',
      subjectObjectId: 'svc-a',
      objectId: 'svc-b',
    });
    expect(applyRollupChangesMock).toHaveBeenCalledWith(db, 'ws-1', [{ type: 'RELATION_DELETED' }]);
  });

  it('rollup 영향이 없는 relation 삭제면 이벤트를 발행하지 않아야 한다', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              relationType: 'call',
              subjectObjectId: 'svc-a',
              objectId: 'svc-b',
              status: 'REJECTED',
              isDerived: true,
            }],
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    getDbMock.mockResolvedValue(db);
    isApprovedBaseRelationMock.mockReturnValue(false);

    const response = await DELETE(
      new Request('http://localhost') as never,
      { params: Promise.resolve({ id: 'rel-1' }) },
    );

    expect(response.status).toBe(200);
    expect(createRelationChangeEventMock).not.toHaveBeenCalled();
    expect(applyRollupChangesMock).not.toHaveBeenCalled();
  });
});
