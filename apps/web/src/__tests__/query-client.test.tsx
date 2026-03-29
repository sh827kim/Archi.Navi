// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@/components/query/query-client';

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
  Play: () => null,
  Loader2: () => null,
  ArrowRight: () => null,
  ArrowLeft: () => null,
  ChevronDown: () => null,
  Network: () => null,
  Route: () => null,
  Users: () => null,
  Layers: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

interface ObjectOption {
  id: string;
  name: string;
  displayName: string | null;
  objectType: string;
}

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pickObject(label: string, objectLabel: string) {
  const labelNode = screen.getByText(label);
  const pickerRoot = labelNode.parentElement;
  if (!pickerRoot) throw new Error(`picker root not found: ${label}`);
  const button = within(pickerRoot).getByRole('button', { name: new RegExp(objectLabel) });
  fireEvent.click(button);
}

function createQueryFetchMock(options: {
  queryHandler: (body: Record<string, unknown>) => Response | Promise<Response>;
  objects?: ObjectOption[];
}) {
  const objects = options.objects ?? [
    { id: 'obj-1', name: 'orders-service', displayName: 'Orders', objectType: 'service' },
    { id: 'obj-2', name: 'billing-service', displayName: 'Billing', objectType: 'service' },
    { id: 'domain-1', name: 'domain-order', displayName: 'Order Domain', objectType: 'domain' },
  ];
  const queryCalls: Array<Record<string, unknown>> = [];

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === '/api/objects?workspaceId=ws-1' && method === 'GET') {
      return Promise.resolve(jsonResponse(objects));
    }

    if (url === '/api/query' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      queryCalls.push(body);
      return Promise.resolve(options.queryHandler(body));
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, queryCalls };
}

describe('QueryClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('IMPACT_ANALYSIS에서 fromObjectId가 없으면 실행을 막고 에러 토스트를 표시해야 한다', async () => {
    const { queryCalls } = createQueryFetchMock({
      queryHandler: () => jsonResponse({ queryType: 'IMPACT_ANALYSIS', result: { nodes: [], edges: [] } }),
    });

    render(<QueryClient />);
    await screen.findByText('Orders');

    fireEvent.click(screen.getByRole('button', { name: '쿼리 실행' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('시작 Object를 선택하세요');
    });
    expect(queryCalls).toHaveLength(0);
  });

  it('IMPACT_ANALYSIS 정상 실행 시 /api/query payload를 올바르게 보내야 한다', async () => {
    const { queryCalls } = createQueryFetchMock({
      queryHandler: () => jsonResponse({
        queryType: 'IMPACT_ANALYSIS',
        result: {
          nodes: [{ id: 'obj-1', type: 'service', name: 'orders-service', displayName: 'Orders' }],
          edges: [{
            subjectId: 'obj-1',
            objectId: 'obj-2',
            relationType: 'call',
            level: 'SERVICE_TO_SERVICE',
            edgeWeight: 1,
            confidence: 0.91,
          }],
        },
      }),
    });

    render(<QueryClient />);
    await screen.findByText('Orders');

    pickObject('시작 Object', 'Orders');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '쿼리 실행' }));

    await waitFor(() => {
      expect(queryCalls).toHaveLength(1);
    });

    expect(queryCalls[0]).toMatchObject({
      workspaceId: 'ws-1',
      queryType: 'IMPACT_ANALYSIS',
      scope: {
        level: 'SERVICE_TO_SERVICE',
        visibility: 'VISIBLE_ONLY',
      },
      params: {
        fromObjectId: 'obj-1',
        direction: 'DOWNSTREAM',
        maxHops: 4,
      },
    });

    expect(toast.success).toHaveBeenCalledWith('노드 1개, 엣지 1개 조회됨');
    expect(screen.getByText('노드 (1)')).toBeTruthy();
    expect(screen.getByText('엣지 (1)')).toBeTruthy();
  });

  it('PATH_DISCOVERY에서 시작/도착 Object 누락 시 실행을 막아야 한다', async () => {
    const { queryCalls } = createQueryFetchMock({
      queryHandler: () => jsonResponse({ queryType: 'PATH_DISCOVERY', result: { nodes: [], edges: [], paths: [] } }),
    });

    render(<QueryClient />);
    await screen.findByText('Orders');

    fireEvent.click(screen.getByRole('button', { name: '경로 탐색' }));
    fireEvent.click(screen.getByRole('button', { name: '쿼리 실행' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('시작/도착 Object를 모두 선택하세요');
    });
    expect(queryCalls).toHaveLength(0);
  });

  it('PATH_DISCOVERY 정상 실행 시 경로 결과를 렌더링해야 한다', async () => {
    const { queryCalls } = createQueryFetchMock({
      queryHandler: () => jsonResponse({
        queryType: 'PATH_DISCOVERY',
        result: {
          nodes: [
            { id: 'obj-1', type: 'service', name: 'orders-service', displayName: 'Orders' },
            { id: 'obj-2', type: 'service', name: 'billing-service', displayName: 'Billing' },
          ],
          edges: [{
            subjectId: 'obj-1',
            objectId: 'obj-2',
            relationType: 'call',
            level: 'SERVICE_TO_SERVICE',
            edgeWeight: 1,
            confidence: 0.87,
          }],
          paths: [{ pathId: 'p-1', nodeIds: ['obj-1', 'obj-2'], score: 0.91 }],
        },
      }),
    });

    render(<QueryClient />);
    await screen.findByText('Orders');

    fireEvent.click(screen.getByRole('button', { name: '경로 탐색' }));
    pickObject('시작 Object', 'Orders');
    pickObject('도착 Object', 'Billing');
    fireEvent.click(screen.getByRole('button', { name: '쿼리 실행' }));

    await waitFor(() => {
      expect(queryCalls).toHaveLength(1);
    });
    expect(queryCalls[0]).toMatchObject({
      queryType: 'PATH_DISCOVERY',
      params: {
        fromObjectId: 'obj-1',
        toObjectId: 'obj-2',
      },
    });

    expect(screen.getByText('경로 (1)')).toBeTruthy();
    expect(screen.getByText(/점수:\s*0\.91/, { selector: 'span' })).toBeTruthy();
  });

  it('DOMAIN_SUMMARY 정상 실행 시 domainId를 전송하고 요약을 렌더링해야 한다', async () => {
    const { queryCalls } = createQueryFetchMock({
      queryHandler: () => jsonResponse({
        queryType: 'DOMAIN_SUMMARY',
        result: {
          nodes: [],
          edges: [],
          summary: { totalDomains: 1, services: 3 },
        },
      }),
    });

    render(<QueryClient />);
    await screen.findByText('Order Domain');

    fireEvent.click(screen.getByRole('button', { name: '도메인 요약' }));
    pickObject('도메인 Object', 'Order Domain');
    fireEvent.click(screen.getByRole('button', { name: '쿼리 실행' }));

    await waitFor(() => {
      expect(queryCalls).toHaveLength(1);
    });
    expect(queryCalls[0]).toMatchObject({
      queryType: 'DOMAIN_SUMMARY',
      params: { domainId: 'domain-1' },
    });

    expect(screen.getByText('요약')).toBeTruthy();
    expect(screen.getByText(/"totalDomains": 1/, { selector: 'pre' })).toBeTruthy();
  });

  it('쿼리 실패 시 에러 토스트를 표시하고 loading 상태를 해제해야 한다', async () => {
    const queryDeferred = deferredResponse();
    const { queryCalls } = createQueryFetchMock({
      queryHandler: () => queryDeferred.promise,
    });

    render(<QueryClient />);
    await screen.findByText('Orders');

    pickObject('시작 Object', 'Orders');
    const runButton = screen.getByRole('button', { name: '쿼리 실행' });
    fireEvent.click(runButton);

    expect((runButton as HTMLButtonElement).disabled).toBe(true);
    expect(queryCalls).toHaveLength(1);

    queryDeferred.resolve(jsonResponse({ error: '쿼리 실패 테스트' }, false));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('쿼리 실패 테스트');
    });
    expect((runButton as HTMLButtonElement).disabled).toBe(false);
  });
});
