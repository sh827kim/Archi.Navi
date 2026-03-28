// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getActiveGenerationMock,
  incrementalRebuildMock,
  updateGenerationMetaMock,
} = vi.hoisted(() => ({
  getActiveGenerationMock: vi.fn(),
  incrementalRebuildMock: vi.fn(),
  updateGenerationMetaMock: vi.fn(),
}));

vi.mock('@archi-navi/core', () => ({
  getActiveGeneration: getActiveGenerationMock,
  incrementalRebuild: incrementalRebuildMock,
  updateGenerationMeta: updateGenerationMetaMock,
}));


vi.mock('@archi-navi/db', () => ({
  rollupGenerations: {},
}));

import { applyRollupChanges } from '@/lib/rollup-change-events';

describe('rollup-change-events', () => {
  beforeEach(() => {
    incrementalRebuildMock.mockReset();
    incrementalRebuildMock.mockResolvedValue(undefined);
    getActiveGenerationMock.mockReset();
    getActiveGenerationMock.mockResolvedValue(7);
    updateGenerationMetaMock.mockReset();
    updateGenerationMetaMock.mockResolvedValue(undefined);
  });

  it('delta rebuild 성공 후 active generation meta에 변경 토큰을 기록해야 한다', async () => {
    const db = { tag: 'db' } as never;
    const events = [
      {
        type: 'RELATION_APPROVED' as const,
        payload: {
          relationType: 'call',
          subjectObjectId: 'svc-a',
          objectId: 'svc-b',
        },
      },
    ];

    await applyRollupChanges(db, 'ws-1', events);

    expect(incrementalRebuildMock).toHaveBeenCalledWith(db, 'ws-1', events);
    expect(getActiveGenerationMock).toHaveBeenCalledWith(db, 'ws-1');
    expect(updateGenerationMetaMock).toHaveBeenCalledTimes(1);
    expect(updateGenerationMetaMock).toHaveBeenCalledWith(
      db,
      'ws-1',
      7,
      expect.objectContaining({
        rollupChangeToken: expect.any(String),
      }),
    );
  });

  it('active generation이 없으면 meta 업데이트를 생략해야 한다', async () => {
    getActiveGenerationMock.mockResolvedValueOnce(null);

    await applyRollupChanges({} as never, 'ws-1', [
      {
        type: 'RELATION_APPROVED',
        payload: { relationType: 'call', subjectObjectId: 'svc-a', objectId: 'svc-b' },
      },
    ]);

    expect(updateGenerationMetaMock).not.toHaveBeenCalled();
  });

  it('빈 이벤트 목록이면 rebuild와 메타 업데이트를 모두 생략해야 한다', async () => {
    await applyRollupChanges({} as never, 'ws-1', []);

    expect(incrementalRebuildMock).not.toHaveBeenCalled();
    expect(getActiveGenerationMock).not.toHaveBeenCalled();
    expect(updateGenerationMetaMock).not.toHaveBeenCalled();
  });
});
