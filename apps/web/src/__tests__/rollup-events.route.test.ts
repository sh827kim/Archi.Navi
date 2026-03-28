// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getDbMock, getWorkspaceRollupChangeCursorMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getWorkspaceRollupChangeCursorMock: vi.fn(),
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@/lib/rollup-change-events', () => ({
  getWorkspaceRollupChangeCursor: getWorkspaceRollupChangeCursorMock,
}));

import { GET } from '@/app/api/rollup-events/route';

const decoder = new TextDecoder();

describe('GET /api/rollup-events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getDbMock.mockReset();
    getDbMock.mockResolvedValue({ tag: 'db' });
    getWorkspaceRollupChangeCursorMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await GET(new NextRequest('http://localhost/api/rollup-events'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'workspaceId is required' });
  });

  it('연결 직후 connected 이벤트를 보내고 변경 토큰 갱신 시 rollup-change를 스트리밍해야 한다', async () => {
    getWorkspaceRollupChangeCursorMock
      .mockResolvedValueOnce({
        workspaceId: 'ws-1',
        generationVersion: 3,
        builtAt: '2026-03-28T00:00:00.000Z',
        changeToken: 'token-1',
      })
      .mockResolvedValue({
        workspaceId: 'ws-1',
        generationVersion: 3,
        builtAt: '2026-03-28T00:00:01.000Z',
        changeToken: 'token-2',
      });

    const response = await GET(
      new NextRequest('http://localhost/api/rollup-events?workspaceId=ws-1'),
    );

    expect(response.headers.get('Content-Type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const connectedChunk = await reader!.read();
    const connectedText = decoder.decode(connectedChunk.value);
    expect(connectedText).toContain('event: connected');
    expect(connectedText).toContain('"workspaceId":"ws-1"');

    await vi.advanceTimersByTimeAsync(1_000);

    const changedChunk = await reader!.read();
    const changedText = decoder.decode(changedChunk.value);
    expect(changedText).toContain('event: rollup-change');
    expect(changedText).toContain('"changeToken":"token-2"');
    expect(changedText).toContain('"generationVersion":3');

    await reader!.cancel();
  });

  it('초기 커서가 없으면 첫 번째 커서 생성 시 rollup-change를 스트리밍해야 한다', async () => {
    getWorkspaceRollupChangeCursorMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        workspaceId: 'ws-1',
        generationVersion: 4,
        builtAt: '2026-03-28T00:00:02.000Z',
        changeToken: 'token-1',
      });

    const response = await GET(
      new NextRequest('http://localhost/api/rollup-events?workspaceId=ws-1'),
    );

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const connectedChunk = await reader!.read();
    const connectedText = decoder.decode(connectedChunk.value);
    expect(connectedText).toContain('event: connected');

    await vi.advanceTimersByTimeAsync(1_000);

    const changedChunk = await reader!.read();
    const changedText = decoder.decode(changedChunk.value);
    expect(changedText).toContain('event: rollup-change');
    expect(changedText).toContain('"changeToken":"token-1"');
    expect(changedText).toContain('"generationVersion":4');

    await reader!.cancel();
  });
});
