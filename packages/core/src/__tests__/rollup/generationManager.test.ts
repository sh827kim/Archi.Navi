import { describe, it, expect, vi } from 'vitest';
import {
  getActiveGeneration,
  createNewGeneration,
  updateGenerationMeta,
  activateGeneration,
} from '../../rollup/generationManager';

function createSelectDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy, limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, where, orderBy, limit };
}

function createSelectWhereDb(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, where };
}

describe('generationManager', () => {
  it('getActiveGeneration: ACTIVE가 있으면 최신 generationVersion을 반환해야 한다', async () => {
    const mock = createSelectDb([{ generationVersion: 7 }]);
    const db = { select: mock.select } as unknown as Parameters<typeof getActiveGeneration>[0];

    const version = await getActiveGeneration(db, 'ws-1');
    expect(version).toBe(7);
  });

  it('getActiveGeneration: ACTIVE가 없으면 null을 반환해야 한다', async () => {
    const mock = createSelectDb([]);
    const db = { select: mock.select } as unknown as Parameters<typeof getActiveGeneration>[0];

    const version = await getActiveGeneration(db, 'ws-1');
    expect(version).toBeNull();
  });

  it('createNewGeneration: ACTIVE가 없으면 1로 생성해야 한다', async () => {
    const selectMock = createSelectDb([]);
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    const db = { select: selectMock.select, insert } as unknown as Parameters<typeof createNewGeneration>[0];

    const version = await createNewGeneration(db, 'ws-1');
    expect(version).toBe(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        generationVersion: 1,
        status: 'BUILDING',
      }),
    );
  });

  it('createNewGeneration: ACTIVE가 있으면 +1 version으로 생성해야 한다', async () => {
    const selectMock = createSelectDb([{ generationVersion: 3 }]);
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    const db = { select: selectMock.select, insert } as unknown as Parameters<typeof createNewGeneration>[0];

    const version = await createNewGeneration(db, 'ws-1');
    expect(version).toBe(4);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ generationVersion: 4 }));
  });

  it('updateGenerationMeta: 대상 generation이 없으면 update를 호출하지 않아야 한다', async () => {
    const selectMock = createSelectWhereDb([]);
    const whereUpdate = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where: whereUpdate });
    const update = vi.fn().mockReturnValue({ set });
    const db = { select: selectMock.select, update } as unknown as Parameters<typeof updateGenerationMeta>[0];

    await updateGenerationMeta(db, 'ws-1', 2, { eventCount: 5 });
    expect(update).not.toHaveBeenCalled();
  });

  it('updateGenerationMeta: 기존 meta와 patch를 병합해야 한다', async () => {
    const selectMock = createSelectWhereDb([{ meta: { eventCount: 1, lastIncrementalAt: 'old' } }]);
    const whereUpdate = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where: whereUpdate });
    const update = vi.fn().mockReturnValue({ set });
    const db = { select: selectMock.select, update } as unknown as Parameters<typeof updateGenerationMeta>[0];

    await updateGenerationMeta(db, 'ws-1', 2, { eventCount: 3, source: 'test' });
    expect(set).toHaveBeenCalledWith({
      meta: { eventCount: 3, lastIncrementalAt: 'old', source: 'test' },
    });
  });

  it('activateGeneration: 기존 ACTIVE를 ARCHIVED 후 신규 generation을 ACTIVE로 전환해야 한다', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi
      .fn()
      .mockReturnValueOnce({ where })
      .mockReturnValueOnce({ where });
    const update = vi.fn().mockReturnValue({ set });
    const db = { update } as unknown as Parameters<typeof activateGeneration>[0];

    await activateGeneration(db, 'ws-1', 9);

    expect(update).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, { status: 'ARCHIVED' });
    expect(set).toHaveBeenNthCalledWith(2, {
      status: 'ACTIVE',
      builtAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalledTimes(2);
  });
});
