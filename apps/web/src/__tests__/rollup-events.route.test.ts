// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/rollup-events/route';
import {
  publishRollupChangeNotification,
  resetRollupChangeEventSubscribersForTest,
} from '@/lib/rollup-change-events';

const decoder = new TextDecoder();

describe('GET /api/rollup-events', () => {
  afterEach(() => {
    resetRollupChangeEventSubscribersForTest();
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await GET(new NextRequest('http://localhost/api/rollup-events'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'workspaceId is required' });
  });

  it('연결 직후 connected 이벤트를 보내고 이후 rollup-change 이벤트를 스트리밍해야 한다', async () => {
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

    publishRollupChangeNotification('ws-1', [
      {
        type: 'RELATION_APPROVED',
        payload: {
          relationType: 'call',
          subjectObjectId: 'svc-a',
          objectId: 'svc-b',
        },
      },
    ]);

    const changedChunk = await reader!.read();
    const changedText = decoder.decode(changedChunk.value);
    expect(changedText).toContain('event: rollup-change');
    expect(changedText).toContain('"eventCount":1');
    expect(changedText).toContain('"relationType":"call"');

    await reader!.cancel();
  });
});
