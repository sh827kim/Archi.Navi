// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  generateIdMock,
  applyRollupChangesMock,
  createRelationChangeEventMock,
  objectRelationsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  generateIdMock: vi.fn(() => 'rel-new'),
  applyRollupChangesMock: vi.fn(),
  createRelationChangeEventMock: vi.fn(() => ({ type: 'RELATION_APPROVED' })),
  objectRelationsMock: {},
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  objectRelations: objectRelationsMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
}));

vi.mock('@archi-navi/shared', () => ({
  generateId: generateIdMock,
}));

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createRelationChangeEvent: createRelationChangeEventMock,
}));

import { POST } from '@/app/api/relations/route';

describe('POST /api/relations', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('relation 생성 후 delta rebuild용 rollup 변경 이벤트를 적용해야 한다', async () => {
    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          subjectObjectId: 'svc-a',
          relationType: 'call',
          objectId: 'svc-b',
          confidence: 0.9,
        }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rel-new',
      workspaceId: 'ws-1',
      relationType: 'call',
      subjectObjectId: 'svc-a',
      objectId: 'svc-b',
    }));
    expect(createRelationChangeEventMock).toHaveBeenCalledWith('APPROVED', {
      relationType: 'call',
      subjectObjectId: 'svc-a',
      objectId: 'svc-b',
    });
    expect(applyRollupChangesMock).toHaveBeenCalledWith(db, 'ws-1', [{ type: 'RELATION_APPROVED' }]);
  });
});
