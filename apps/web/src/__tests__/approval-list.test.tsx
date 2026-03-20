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
  crossValidation?: {
    validated: boolean;
    supportCount: number;
    supportingSources: string[];
    contradictions?: Array<{
      ruleId: string;
      type: 'STALE_CONFIG' | 'PHANTOM_CALL' | 'DEAD_TOPIC' | 'ORPHAN_FK';
      penalty: number;
    }>;
  };
}

interface EndpointInfo {
  id: string;
  name: string;
  method: string;
  path: string;
}

function createCandidate(
  id: string,
  objectName: string,
  relationType = 'call',
  crossValidation?: RelationCandidate['crossValidation'],
): RelationCandidate {
  return {
    id,
    subjectName: `caller-${id}`,
    subjectGranularity: 'COMPOUND',
    subjectParentName: null,
    subjectObjectType: 'service',
    relationType,
    objectName,
    objectGranularity: 'COMPOUND',
    objectParentName: null,
    objectObjectType: 'service',
    objectId: `service-${id}`,
    subjectObjectId: `caller-${id}`,
    confidence: 0.8,
    source: 'INFERRED',
    status: 'PENDING',
    ...(crossValidation ? { crossValidation } : {}),
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

  it('non-call COMPOUND 후보도 세부 매핑 대상으로 유지되어야 한다', async () => {
    const candidate = createCandidate('cand-2', 'service-2', 'depend_on');

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([candidate]));
      }
      if (url.endsWith('/cand-2/endpoints')) {
        return Promise.resolve(jsonResponse({
          endpoints: [createEndpoint('ep-2', '/service-2/dependency')],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-2');

    expect(screen.queryByRole('button', { name: /승인/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /세부 매핑/ }));
    await screen.findByText('/service-2/dependency');
  });

  it('교차 검증 배지를 후보별로 표시해야 한다', async () => {
    const supported = createCandidate('cand-3', 'service-3', 'call', {
      validated: true,
      supportCount: 2,
      supportingSources: ['config', 'code'],
    });
    const single = createCandidate('cand-4', 'service-4', 'call', {
      validated: false,
      supportCount: 1,
      supportingSources: ['code'],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([supported, single]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-3');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('2+ 소스 지지');
    expect(cards[1]?.textContent).toContain('단일 소스');
  });

  it('STALE_CONFIG contradiction이 있으면 경고 배지를 함께 표시해야 한다', async () => {
    const stale = createCandidate('cand-5', 'order-db', 'read', {
      validated: false,
      supportCount: 1,
      supportingSources: ['config'],
      contradictions: [{ ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.15 }],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([stale]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('order-db');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('STALE_CONFIG 경고');
    expect(cards[0]?.textContent).not.toContain('단일 소스');
  });

  it('다른 contradiction type도 대응되는 경고 배지를 우선 표시해야 한다', async () => {
    const phantom = createCandidate('cand-6', 'payment-service', 'call', {
      validated: false,
      supportCount: 2,
      supportingSources: ['config', 'code'],
      contradictions: [{ ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 }],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([phantom]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('payment-service');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('PHANTOM_CALL 경고');
    expect(cards[0]?.textContent).not.toContain('2+ 소스 지지');
  });

  it('DEAD_TOPIC contradiction도 대응되는 경고 배지를 표시해야 한다', async () => {
    const deadTopic = createCandidate('cand-7', 'order.created', 'consume', {
      validated: false,
      supportCount: 1,
      supportingSources: ['config'],
      contradictions: [{ ruleId: 'C3', type: 'DEAD_TOPIC', penalty: 0.15 }],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([deadTopic]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('order.created');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('DEAD_TOPIC 경고');
    expect(cards[0]?.textContent).not.toContain('단일 소스');
  });

  it('ORPHAN_FK contradiction도 대응되는 경고 배지를 표시해야 한다', async () => {
    const orphanFk = createCandidate('cand-8', 'orders', 'fk_reference', {
      validated: false,
      supportCount: 1,
      supportingSources: ['db'],
      contradictions: [{ ruleId: 'C4', type: 'ORPHAN_FK', penalty: 0.15 }],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([orphanFk]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('orders');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('ORPHAN_FK 경고');
    expect(cards[0]?.textContent).not.toContain('단일 소스');
  });

  it('교차 검증 필터로 경고 후보만 볼 수 있어야 한다', async () => {
    const warning = createCandidate('cand-9', 'warning-service', 'call', {
      validated: false,
      supportCount: 1,
      supportingSources: ['code'],
      contradictions: [{ ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 }],
    });
    const supported = createCandidate('cand-10', 'supported-service', 'call', {
      validated: true,
      supportCount: 2,
      supportingSources: ['config', 'code'],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([warning, supported]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('warning-service');
    fireEvent.change(screen.getByLabelText('교차 검증 필터'), {
      target: { value: 'warnings' },
    });

    expect(screen.getByText('warning-service')).toBeTruthy();
    expect(screen.queryByText('supported-service')).toBeNull();
  });

  it('기본 정렬은 경고 후보를 다중 소스/단일 소스보다 우선 배치해야 한다', async () => {
    const single = createCandidate('cand-11', 'single-service', 'call', {
      validated: false,
      supportCount: 1,
      supportingSources: ['code'],
    });
    const warning = createCandidate('cand-12', 'warning-first', 'call', {
      validated: false,
      supportCount: 1,
      supportingSources: ['code'],
      contradictions: [{ ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 }],
    });
    const supported = createCandidate('cand-13', 'supported-next', 'call', {
      validated: true,
      supportCount: 2,
      supportingSources: ['config', 'code'],
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([single, supported, warning]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('warning-first');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('warning-first');
    expect(cards[1]?.textContent).toContain('supported-next');
    expect(cards[2]?.textContent).toContain('single-service');
  });

  it('신뢰도 낮은 순 정렬을 적용할 수 있어야 한다', async () => {
    const high = { ...createCandidate('cand-14', 'high-confidence'), confidence: 0.9 };
    const low = { ...createCandidate('cand-15', 'low-confidence'), confidence: 0.2 };
    const mid = { ...createCandidate('cand-16', 'mid-confidence'), confidence: 0.5 };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([high, low, mid]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('high-confidence');
    fireEvent.change(screen.getByLabelText('교차 검증 정렬'), {
      target: { value: 'confidence-asc' },
    });

    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('low-confidence');
    expect(cards[1]?.textContent).toContain('mid-confidence');
    expect(cards[2]?.textContent).toContain('high-confidence');
  });
});
