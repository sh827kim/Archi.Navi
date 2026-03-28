// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalRebuildMock } = vi.hoisted(() => ({
  incrementalRebuildMock: vi.fn(),
}));

vi.mock('@archi-navi/core', () => ({
  incrementalRebuild: incrementalRebuildMock,
}));

import {
  applyRollupChanges,
  resetRollupChangeEventSubscribersForTest,
  subscribeRollupChangeEvents,
} from '@/lib/rollup-change-events';

describe('rollup-change-events', () => {
  beforeEach(() => {
    incrementalRebuildMock.mockReset();
    incrementalRebuildMock.mockResolvedValue(undefined);
    resetRollupChangeEventSubscribersForTest();
  });

  it('delta rebuild 성공 후 구독자에게 rollup 변경 알림을 발행해야 한다', async () => {
    const listener = vi.fn();
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

    subscribeRollupChangeEvents('ws-1', listener);
    await applyRollupChanges(db, 'ws-1', events);

    expect(incrementalRebuildMock).toHaveBeenCalledWith(db, 'ws-1', events);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ROLLUP_CHANGED',
        workspaceId: 'ws-1',
        eventCount: 1,
        events,
      }),
    );
  });

  it('빈 이벤트 목록이면 rebuild와 알림 모두 생략해야 한다', async () => {
    const listener = vi.fn();

    subscribeRollupChangeEvents('ws-1', listener);
    await applyRollupChanges({} as never, 'ws-1', []);

    expect(incrementalRebuildMock).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
