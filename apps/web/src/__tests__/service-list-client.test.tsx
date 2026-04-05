// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ServiceListClient } from '@/components/services/service-list-client';

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast }));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('lucide-react', () => ({
  Search: () => null,
  LayoutGrid: () => null,
  List: () => null,
  Server: () => null,
  Database: () => null,
  Radio: () => null,
  Globe: () => null,
  Box: () => null,
  Plus: () => null,
  Loader2: () => null,
  Pencil: () => null,
  Trash2: () => null,
  Eye: () => null,
  EyeOff: () => null,
  ChevronRight: () => null,
  ArrowRight: () => null,
  ArrowLeft: () => null,
  CheckCheck: () => null,
  Download: () => null,
  Check: () => null,
  X: () => null,
  Tag: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div data-testid="object-detail-sheet">{children}</div> : null
  ),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  ConfirmDialog: () => null,
}));

interface ObjectItem {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
  granularity: string;
  visibility: string;
  parentId: string | null;
  depth: number;
}

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

function setupFetchMock() {
  let displayName = '주문 서비스';
  let description = '기존 설명';
  let visibility = 'VISIBLE';
  let currentLayerId = 'layer-1';

  const baseObject: ObjectItem = {
    id: 'obj-1',
    name: 'orders-service',
    displayName,
    objectType: 'service',
    granularity: 'COMPOUND',
    visibility,
    parentId: null,
    depth: 0,
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === '/api/objects?workspaceId=ws-1') {
      return jsonResponse([{ ...baseObject, displayName, visibility }]);
    }
    if (url === '/api/objects/obj-1?workspaceId=ws-1' && method === 'GET') {
      return jsonResponse({
        ...baseObject,
        displayName,
        visibility,
        description,
        outbound: [],
        inbound: [],
        children: [],
      });
    }
    if (url === '/api/objects/obj-1/tags?workspaceId=ws-1') {
      return jsonResponse([]);
    }
    if (url === '/api/tags?workspaceId=ws-1') {
      return jsonResponse([]);
    }
    if (url === '/api/layers?workspaceId=ws-1') {
      return jsonResponse([
        {
          id: 'layer-1',
          name: 'application',
          displayName: 'Application',
          color: '#3b82f6',
          sortOrder: 0,
          isEnabled: true,
        },
        {
          id: 'layer-2',
          name: 'infrastructure',
          displayName: 'Infrastructure',
          color: '#10b981',
          sortOrder: 1,
          isEnabled: true,
        },
      ]);
    }
    if (url === '/api/layers/assignments?workspaceId=ws-1') {
      return jsonResponse(
        currentLayerId
          ? [{ objectId: 'obj-1', layerId: currentLayerId }]
          : [],
      );
    }
    if (url === '/api/objects/obj-1' && method === 'PATCH') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        workspaceId?: string;
        displayName?: string | null;
        description?: string | null;
        visibility?: string;
      };
      if (payload.workspaceId !== 'ws-1') {
        return jsonResponse({ error: 'workspaceId is required' }, false);
      }
      if ('displayName' in payload) displayName = payload.displayName ?? '';
      if ('description' in payload) description = payload.description ?? '';
      if (payload.visibility) visibility = payload.visibility;
      return jsonResponse({ ok: true });
    }
    if (url === '/api/layers/assignments' && method === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        workspaceId?: string;
        objectId?: string;
        layerId?: string;
      };
      if (payload.workspaceId !== 'ws-1' || payload.objectId !== 'obj-1' || !payload.layerId) {
        return jsonResponse({ error: 'bad request' }, false);
      }
      currentLayerId = payload.layerId;
      return jsonResponse({ id: 'assign-1' });
    }
    if (url === '/api/layers/assignments?workspaceId=ws-1&objectId=obj-1' && method === 'DELETE') {
      currentLayerId = '';
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setupNoEnabledLayersFetchMock() {
  let currentLayerId = 'layer-1';

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === '/api/objects?workspaceId=ws-1') {
      return jsonResponse([{
        id: 'obj-1',
        name: 'orders-service',
        displayName: '주문 서비스',
        objectType: 'service',
        granularity: 'COMPOUND',
        visibility: 'VISIBLE',
        parentId: null,
        depth: 0,
      }]);
    }
    if (url === '/api/objects/obj-1?workspaceId=ws-1' && method === 'GET') {
      return jsonResponse({
        id: 'obj-1',
        name: 'orders-service',
        displayName: '주문 서비스',
        objectType: 'service',
        granularity: 'COMPOUND',
        visibility: 'VISIBLE',
        parentId: null,
        depth: 0,
        description: '기존 설명',
        outbound: [],
        inbound: [],
        children: [],
      });
    }
    if (url === '/api/objects/obj-1/tags?workspaceId=ws-1') return jsonResponse([]);
    if (url === '/api/tags?workspaceId=ws-1') return jsonResponse([]);
    if (url === '/api/layers?workspaceId=ws-1') return jsonResponse([]);
    if (url === '/api/layers/assignments?workspaceId=ws-1') {
      return jsonResponse([{ objectId: 'obj-1', layerId: currentLayerId }]);
    }
    if (url === '/api/layers/assignments?workspaceId=ws-1&objectId=obj-1' && method === 'DELETE') {
      currentLayerId = '';
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function getPatchPayloads(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === '/api/objects/obj-1' && (init?.method ?? 'GET') === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
}

async function openDetailSheet() {
  await screen.findByText('주문 서비스');
  fireEvent.click(screen.getByText('주문 서비스'));
  return await screen.findByTestId('object-detail-sheet');
}

describe('ServiceListClient object edit flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('상세 sheet에서 displayName 인라인 편집 후 PATCH를 호출해야 한다', async () => {
    const fetchMock = setupFetchMock();

    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    fireEvent.click(within(sheet).getByText('주문 서비스'));
    const input = within(sheet).getByDisplayValue('주문 서비스');
    fireEvent.change(input, { target: { value: '주문 서비스 v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const payloads = getPatchPayloads(fetchMock);
      expect(payloads.some((payload) => (
        payload.workspaceId === 'ws-1'
        && payload.displayName === '주문 서비스 v2'
      ))).toBe(true);
    });
    expect(within(sheet).getByText('주문 서비스 v2')).toBeTruthy();
  });

  it('상세 sheet에서 description 인라인 편집 후 PATCH를 호출해야 한다', async () => {
    const fetchMock = setupFetchMock();

    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    fireEvent.click(within(sheet).getByText('기존 설명'));
    const textarea = within(sheet).getByDisplayValue('기존 설명');
    fireEvent.change(textarea, { target: { value: '변경된 설명' } });
    fireEvent.click(within(sheet).getByLabelText('인라인 저장'));

    await waitFor(() => {
      const payloads = getPatchPayloads(fetchMock);
      expect(payloads.some((payload) => (
        payload.workspaceId === 'ws-1'
        && payload.description === '변경된 설명'
      ))).toBe(true);
    });
    expect(within(sheet).getByText('변경된 설명')).toBeTruthy();
  });

  it('상세 sheet에서 visibility 토글 시 PATCH를 호출하고 UI 상태를 갱신해야 한다', async () => {
    const fetchMock = setupFetchMock();

    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    expect(within(sheet).getByText('VISIBLE')).toBeTruthy();
    fireEvent.click(within(sheet).getByLabelText('가시성 전환'));

    await waitFor(() => {
      const payloads = getPatchPayloads(fetchMock);
      expect(payloads.some((payload) => (
        payload.workspaceId === 'ws-1'
        && payload.visibility === 'HIDDEN'
      ))).toBe(true);
    });
    expect(within(sheet).getByText('HIDDEN')).toBeTruthy();
  });

  it('상세 sheet에서 approval proof drill-down 링크를 노출해야 한다', async () => {
    setupFetchMock();
    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    const links = within(sheet).getAllByRole('link', { name: 'proof chain drill-down' });
    expect(links.length).toBe(2);
    expect(links[0]?.getAttribute('href')).toContain('/approval?workspaceId=ws-1');
    expect(links[0]?.getAttribute('href')).toContain('focusObjectId=obj-1');
    expect(links[0]?.getAttribute('href')).toContain('drill=proof-chain');
  });

  it('상세 sheet에서 현재 레이어를 표시하고 변경 시 assignment POST를 호출해야 한다', async () => {
    const fetchMock = setupFetchMock();

    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    const layerSelect = within(sheet).getByLabelText('아키텍처 레이어 선택') as HTMLSelectElement;
    expect(layerSelect.value).toBe('layer-1');

    fireEvent.change(layerSelect, { target: { value: 'layer-2' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/layers/assignments',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            workspaceId: 'ws-1',
            objectId: 'obj-1',
            layerId: 'layer-2',
          }),
        }),
      );
    });
    expect(layerSelect.value).toBe('layer-2');
  });

  it('상세 sheet에서 레이어 없음 선택 시 assignment DELETE를 호출해야 한다', async () => {
    const fetchMock = setupFetchMock();

    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    const layerSelect = within(sheet).getByLabelText('아키텍처 레이어 선택') as HTMLSelectElement;
    fireEvent.change(layerSelect, { target: { value: '__none__' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/layers/assignments?workspaceId=ws-1&objectId=obj-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(layerSelect.value).toBe('__none__');
  });

  it('활성 레이어가 없어도 기존 assignment는 레이어 없음으로 해제할 수 있어야 한다', async () => {
    const fetchMock = setupNoEnabledLayersFetchMock();

    render(<ServiceListClient />);
    const sheet = await openDetailSheet();

    const layerSelect = within(sheet).getByLabelText('아키텍처 레이어 선택') as HTMLSelectElement;
    expect(layerSelect.disabled).toBe(false);

    fireEvent.change(layerSelect, { target: { value: '__none__' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/layers/assignments?workspaceId=ws-1&objectId=obj-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(layerSelect.value).toBe('__none__');
  });

  it('목록 카드 visibility 토글 경로도 PATCH를 호출해야 한다', async () => {
    const fetchMock = setupFetchMock();

    render(<ServiceListClient />);
    await screen.findByText('주문 서비스');

    fireEvent.click(screen.getByRole('button', { name: /편집/ }));
    fireEvent.click(screen.getByTitle('숨기기'));

    await waitFor(() => {
      const payloads = getPatchPayloads(fetchMock);
      expect(payloads.some((payload) => (
        payload.workspaceId === 'ws-1'
        && payload.visibility === 'HIDDEN'
      ))).toBe(true);
    });
    expect(screen.getByText('HIDDEN')).toBeTruthy();
  });
});
