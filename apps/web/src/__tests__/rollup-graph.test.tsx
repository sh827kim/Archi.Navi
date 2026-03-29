import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RollupGraph } from '@/components/mapping/rollup-graph';
import { ROLLUP_EVENT_FALLBACK_INTERVAL_MS } from '@/lib/rollup-event-source';

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('@archi-navi/ui', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  Spinner: () => <div>loading...</div>,
}));

vi.mock('@/components/mapping/rollup-graph-3d', () => ({
  RollupGraph3D: ({
    nodes,
    links,
  }: {
    nodes: Array<{ id: string; label: string }>;
    links: Array<{ id: string }>;
  }) => (
    <div>
      <div data-testid="graph-node-labels">{nodes.map((node) => node.label).join(',')}</div>
      <div data-testid="graph-link-count">{links.length}</div>
    </div>
  ),
}));

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

function createDomain(label: string) {
  return [
    {
      id: 'domain-1',
      name: label,
      displayName: label,
      objectType: 'domain',
      granularity: 'COMPOUND',
      parentId: null,
      depth: 0,
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushGraphRender() {
  await act(async () => {
    for (let idx = 0; idx < 5; idx += 1) {
      await Promise.resolve();
    }
  });
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<() => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    if (this.closed) return;
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  close() {
    this.closed = true;
  }
}

describe('RollupGraph', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('SSE rollup-change 이벤트를 받으면 현재 뷰를 다시 fetch 한다', async () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

    let objectFetchCount = 0;
    let eventTriggered = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/objects?')) {
        objectFetchCount += 1;
        return Promise.resolve(
          jsonResponse(createDomain(eventTriggered ? 'domain-after-event' : 'domain-before-event')),
        );
      }
      if (url.startsWith('/api/domain-affinities?')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.startsWith('/api/rollups?')) {
        return Promise.resolve(jsonResponse({ edges: [], graphStats: [] }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RollupGraph />);

    await screen.findByText('domain-before-event');
    expect(FakeEventSource.instances[0]?.url).toBe('/api/rollup-events?workspaceId=ws-1');
    const baselineFetchCount = objectFetchCount;

    eventTriggered = true;
    await act(async () => {
      FakeEventSource.instances[0]?.emit('rollup-change');
    });
    expect(objectFetchCount).toBe(baselineFetchCount);

    await act(async () => {
      FakeEventSource.instances[0]?.emit('rollup-change');
    });

    await screen.findByText('domain-after-event');
    expect(objectFetchCount).toBeGreaterThan(baselineFetchCount);
  });

  it('EventSource 미지원이면 polling fallback으로 현재 workspace 뷰를 자동 갱신한다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined);

    let currentLabel = 'domain-fallback-initial';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/objects?')) {
          return Promise.resolve(jsonResponse(createDomain(currentLabel)));
        }
        if (url.startsWith('/api/domain-affinities?')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.startsWith('/api/rollups?')) {
          return Promise.resolve(jsonResponse({ edges: [], graphStats: [] }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<RollupGraph />);
    await flushGraphRender();
    expect(screen.getByText('domain-fallback-initial')).toBeTruthy();

    currentLabel = 'domain-fallback-polled';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS);
    });
    await flushGraphRender();
    expect(screen.getByText('domain-fallback-polled')).toBeTruthy();
  });

  it('SSE 연결 에러 후에는 polling fallback으로 전환해 자동 갱신을 이어간다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

    let currentLabel = 'domain-stable';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/objects?')) {
          return Promise.resolve(jsonResponse(createDomain(currentLabel)));
        }
        if (url.startsWith('/api/domain-affinities?')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.startsWith('/api/rollups?')) {
          return Promise.resolve(jsonResponse({ edges: [], graphStats: [] }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<RollupGraph />);
    await flushGraphRender();
    expect(screen.getByText('domain-stable')).toBeTruthy();

    await act(async () => {
      FakeEventSource.instances[0]?.emit('error');
    });
    expect(FakeEventSource.instances[0]?.closed).toBe(true);

    currentLabel = 'domain-after-error';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROLLUP_EVENT_FALLBACK_INTERVAL_MS);
    });
    await flushGraphRender();
    expect(screen.getByText('domain-after-error')).toBeTruthy();
  });

  it('연속 rollup-change 중 오래된 fetch 응답이 최신 그래프를 덮지 않아야 한다', async () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

    const firstObjectsResponse = deferred<Response>();
    let objectFetchCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/objects?')) {
          objectFetchCount += 1;
          if (objectFetchCount === 1) {
            return firstObjectsResponse.promise;
          }
          return Promise.resolve(jsonResponse(createDomain('domain-latest')));
        }
        if (url.startsWith('/api/domain-affinities?')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.startsWith('/api/rollups?')) {
          return Promise.resolve(jsonResponse({ edges: [], graphStats: [] }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<RollupGraph />);

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    await act(async () => {
      FakeEventSource.instances[0]?.emit('rollup-change');
    });
    await act(async () => {
      FakeEventSource.instances[0]?.emit('rollup-change');
    });

    await screen.findByText('domain-latest');

    await act(async () => {
      firstObjectsResponse.resolve(jsonResponse(createDomain('domain-stale')));
      await Promise.resolve();
    });

    expect(screen.getByText('domain-latest')).toBeTruthy();
    expect(screen.queryByText('domain-stale')).toBeNull();
  });
});
