import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cytoscape from 'cytoscape';
import { LayeredArchitectureView } from '@/components/architecture/layered-architecture-view';

const { themeState } = vi.hoisted(() => ({
  themeState: { resolvedTheme: 'dark' as 'dark' | 'light' | undefined },
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => themeState,
}));

vi.mock('lucide-react', () => ({
  Search: () => null,
  ZoomIn: () => null,
  ZoomOut: () => null,
  Maximize: () => null,
  Download: () => null,
  Eye: () => null,
  EyeOff: () => null,
  Spline: () => null,
  CornerDownRight: () => null,
  Minus: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
  Spinner: () => <div>loading...</div>,
}));

vi.mock('cytoscape', () => ({
  default: vi.fn(() => {
    const createCollection = () => {
      const collection = {
        style: vi.fn(() => collection),
        removeClass: vi.fn(() => collection),
        addClass: vi.fn(() => collection),
        remove: vi.fn(() => collection),
        filter: vi.fn(() => createCollection()),
        connectedEdges: vi.fn(() => createCollection()),
        neighborhood: vi.fn(() => createCollection()),
        forEach: vi.fn(),
      };
      return collection;
    };

    let zoomValue = 1;
    let panValue = { x: 0, y: 0 };

    return {
      fit: vi.fn(),
      resize: vi.fn(),
      elements: vi.fn(() => createCollection()),
      nodes: vi.fn(() => createCollection()),
      edges: vi.fn(() => createCollection()),
      getElementById: vi.fn(() => ({ style: vi.fn() })),
      destroy: vi.fn(),
      add: vi.fn(),
      batch: vi.fn((fn: () => void) => fn()),
      zoom: vi.fn((next?: number) => {
        if (typeof next === 'number') zoomValue = next;
        return zoomValue;
      }),
      pan: vi.fn((next?: { x: number; y: number }) => {
        if (next) panValue = next;
        return panValue;
      }),
      png: vi.fn(() => 'data:image/png;base64,AAAA'),
    };
  }),
}));

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

function createFetchMock() {
  let objectFetchCount = 0;

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/layers?')) {
      return Promise.resolve(jsonResponse([
        {
          id: 'layer-1',
          name: 'application',
          displayName: 'Application',
          color: '#3b82f6',
          sortOrder: 0,
          isEnabled: true,
        },
      ]));
    }
    if (url.startsWith('/api/layers/assignments?')) {
      return Promise.resolve(jsonResponse([
        { objectId: 'svc-1', layerId: 'layer-1' },
      ]));
    }
    if (url.startsWith('/api/objects?')) {
      objectFetchCount += 1;
      return Promise.resolve(jsonResponse([
        {
          id: 'svc-1',
          name: 'orders',
          displayName: 'Orders',
          objectType: 'service',
          granularity: 'COMPOUND',
          parentId: null,
          depth: 0,
        },
      ]));
    }
    if (url.startsWith('/api/object-tags?')) {
      return Promise.resolve(jsonResponse({}));
    }
    if (url.startsWith('/api/rollups?')) {
      return Promise.resolve(jsonResponse({ edges: [] }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  return {
    fetchMock,
    getObjectFetchCount: () => objectFetchCount,
  };
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

describe('LayeredArchitectureView SSE refresh', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    themeState.resolvedTheme = 'dark';
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rollup-change 이벤트 수신 시 현재 workspace 데이터를 다시 fetch 해야 한다', async () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    const { fetchMock, getObjectFetchCount } = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(<LayeredArchitectureView />);

    await waitFor(() => {
      expect(getObjectFetchCount()).toBeGreaterThanOrEqual(1);
    });

    expect(FakeEventSource.instances[0]?.url).toBe('/api/rollup-events?workspaceId=ws-1');
    const before = getObjectFetchCount();

    // skipInitialChangeEvent=true 이므로 첫 이벤트는 무시된다.
    await act(async () => {
      FakeEventSource.instances[0]?.emit('rollup-change');
    });
    expect(getObjectFetchCount()).toBe(before);

    await act(async () => {
      FakeEventSource.instances[0]?.emit('rollup-change');
    });

    await waitFor(() => {
      expect(getObjectFetchCount()).toBeGreaterThan(before);
    });
  });

  it('데이터가 없으면 다음 행동 안내를 표시해야 한다', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/layers?')) return Promise.resolve(jsonResponse([]));
      if (url.startsWith('/api/layers/assignments?')) return Promise.resolve(jsonResponse([]));
      if (url.startsWith('/api/objects?')) return Promise.resolve(jsonResponse([]));
      if (url.startsWith('/api/object-tags?')) return Promise.resolve(jsonResponse({}));
      if (url.startsWith('/api/rollups?')) return Promise.resolve(jsonResponse({ edges: [] }));
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<LayeredArchitectureView />);

    await screen.findByText('아직 레이어드 아키텍처를 그릴 데이터가 없습니다');
    expect(screen.getByRole('link', { name: 'Object 목록 열기' }).getAttribute('href')).toBe('/services');
    expect(screen.getByRole('link', { name: '설정으로 이동' }).getAttribute('href')).toBe('/settings');
  });

  it('라이트 모드에서는 레이어 제목과 태그가 밝은 테마 팔레트를 사용해야 한다', async () => {
    themeState.resolvedTheme = 'light';
    vi.stubGlobal('fetch', createFetchMock().fetchMock);

    render(<LayeredArchitectureView />);

    await waitFor(() => {
      expect(vi.mocked(cytoscape).mock.calls.length).toBeGreaterThan(0);
    });

    const initOptions = vi.mocked(cytoscape).mock.calls.at(-1)?.[0] as {
      style: Array<{ selector: string; css: Record<string, unknown> }>;
    };
    const layerTitleStyle = initOptions.style.find(
      (item) => item.selector === 'node[nodeType="layer-title"]',
    );
    const tagStyle = initOptions.style.find(
      (item) => item.selector === 'node[nodeType="tag"]',
    );

    expect(layerTitleStyle?.css.color).toBe('#334155');
    expect(tagStyle?.css['background-color']).toBe('#f4ede2');
  });

  it('초기 mount 직후 theme가 light로 결정되면 graph build를 다시 실행해야 한다', async () => {
    const { fetchMock, getObjectFetchCount } = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<LayeredArchitectureView />);

    await waitFor(() => {
      expect(getObjectFetchCount()).toBeGreaterThanOrEqual(1);
    });

    const before = getObjectFetchCount();
    themeState.resolvedTheme = 'light';
    rerender(<LayeredArchitectureView />);

    await waitFor(() => {
      expect(getObjectFetchCount()).toBeGreaterThan(before);
    });
  });
});
