import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalList } from '@/components/approval/approval-list';

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast }));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('lucide-react', () => ({
  Check: () => null,
  X: () => null,
  Sparkles: () => null,
  Link2: () => null,
  ChevronRight: () => null,
}));

vi.mock('@archi-navi/ui', () => {
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>{children}</button>
    ),
    Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    Spinner: () => <div>loading...</div>,
    ConfirmDialog: () => null,
    Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
      open ? <div data-testid="mapping-sheet">{children}</div> : null
    ),
    SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

interface RelationCandidate {
  id: string;
  subjectName: string;
  subjectGranularity: 'COMPOUND' | 'ATOMIC';
  subjectParentName: string | null;
  subjectObjectType: string | null;
  relationType: string;
  objectName: string;
  objectGranularity: 'COMPOUND' | 'ATOMIC';
  objectParentName: string | null;
  objectObjectType: string | null;
  objectId: string;
  subjectObjectId: string;
  confidence: number;
  source: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

interface EndpointInfo {
  id: string;
  name: string;
  method: string;
  path: string;
}

function createCandidate(id: string, objectName: string): RelationCandidate {
  return {
    id,
    subjectName: `caller-${id}`,
    subjectGranularity: 'COMPOUND',
    subjectParentName: null,
    subjectObjectType: 'service',
    relationType: 'call',
    objectName,
    objectGranularity: 'COMPOUND',
    objectParentName: null,
    objectObjectType: 'service',
    objectId: `service-${id}`,
    subjectObjectId: `caller-${id}`,
    confidence: 0.8,
    source: 'INFERRED',
    status: 'PENDING',
  };
}

function createEndpoint(id: string, path: string): EndpointInfo {
  return {
    id,
    name: id,
    method: 'GET',
    path,
  };
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

describe('ApprovalList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toast.success.mockReset();
    toast.error.mockReset();
    toast.warning.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('늦게 도착한 이전 후보의 엔드포인트 응답이 현재 시트를 덮어쓰지 않는다', async () => {
    const candidateA = createCandidate('cand-a', 'service-a');
    const candidateB = createCandidate('cand-b', 'service-b');
    const deferredA = deferredResponse();

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([candidateA, candidateB]));
      }
      if (url.endsWith('/cand-a/endpoints')) {
        return deferredA.promise;
      }
      if (url.endsWith('/cand-b/endpoints')) {
        return Promise.resolve(jsonResponse({
          endpoints: [createEndpoint('ep-b', '/service-b/orders')],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-a');

    const mappingButtons = await screen.findAllByRole('button', { name: /세부 매핑/ });
    fireEvent.click(mappingButtons[0]!);
    fireEvent.click(mappingButtons[1]!);

    await screen.findByText('/service-b/orders');

    deferredA.resolve(jsonResponse({
      endpoints: [createEndpoint('ep-a', '/service-a/users')],
    }));

    await waitFor(() => {
      expect(screen.queryByText('/service-a/users')).toBeNull();
    });
    expect(screen.getByText('/service-b/orders')).toBeTruthy();
  });

  it('0건 매핑 응답이면 후보를 목록에서 제거하지 않는다', async () => {
    const candidate = createCandidate('cand-1', 'service-1');

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([candidate]));
      }
      if (url.endsWith('/cand-1/endpoints')) {
        return Promise.resolve(jsonResponse({
          endpoints: [createEndpoint('ep-1', '/service-1/orders')],
        }));
      }
      if (url.endsWith('/cand-1/map-endpoints')) {
        return Promise.resolve(jsonResponse({ createdRelationCount: 0 }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-1');

    fireEvent.click(screen.getByRole('button', { name: /세부 매핑/ }));
    await screen.findByText('/service-1/orders');

    fireEvent.click(screen.getByText('/service-1/orders').closest('button') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: /1개 매핑 적용/ }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        '생성된 엔드포인트 관계가 없어 원본 후보를 유지했습니다.',
      );
    });
    expect(screen.getByText('서비스 간 관계 — 세부 매핑 필요 (1건)')).toBeTruthy();
    expect(screen.getByTestId('mapping-sheet')).toBeTruthy();
  });
});
