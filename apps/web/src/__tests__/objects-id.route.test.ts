// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, updateMock, setMock, whereMock, eqMock, andMock, orMock } = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const eq = vi.fn((column: unknown, value: unknown) => ({ type: 'eq', column, value }));
  const and = vi.fn((...args: unknown[]) => ({ type: 'and', args }));
  const or = vi.fn((...args: unknown[]) => ({ type: 'or', args }));
  return {
    getDbMock: vi.fn(),
    updateMock: update,
    setMock: set,
    whereMock: where,
    eqMock: eq,
    andMock: and,
    orMock: or,
  };
});

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: eqMock,
  and: andMock,
  or: orMock,
}));

import { PATCH } from '@/app/api/objects/[id]/route';

describe('PATCH /api/objects/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockResolvedValue({
      update: updateMock,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await PATCH(
      new Request('http://localhost/api/objects/obj-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'orders' }),
      }) as never,
      { params: Promise.resolve({ id: 'obj-1' }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'workspaceId is required' });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('업데이트할 필드가 없으면 400을 반환해야 한다', async () => {
    const response = await PATCH(
      new Request('http://localhost/api/objects/obj-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1' }),
      }) as never,
      { params: Promise.resolve({ id: 'obj-1' }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'No fields to update' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('displayName/description/visibility payload를 받아 DB update를 호출해야 한다', async () => {
    const response = await PATCH(
      new Request('http://localhost/api/objects/obj-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          displayName: '주문 서비스',
          description: '주문 처리 서비스',
          visibility: 'HIDDEN',
        }),
      }) as never,
      { params: Promise.resolve({ id: 'obj-1' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(getDbMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({
      displayName: '주문 서비스',
      description: '주문 처리 서비스',
      visibility: 'HIDDEN',
    });
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(eqMock).toHaveBeenCalledWith(expect.anything(), 'obj-1');
    expect(eqMock).toHaveBeenCalledWith(expect.anything(), 'ws-1');
    expect(andMock).toHaveBeenCalledTimes(1);
    const whereClause = whereMock.mock.calls[0]?.[0] as { type: string; args: Array<{ value: unknown }> };
    expect(whereClause.type).toBe('and');
    expect(whereClause.args).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'eq', value: 'obj-1' }),
      expect.objectContaining({ type: 'eq', value: 'ws-1' }),
    ]));
  });
});
