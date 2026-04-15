// @vitest-environment jsdom

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
  Bot: () => null,
  Zap: () => null,
  FlaskConical: () => null,
  Loader2: () => null,
}));

vi.mock('@archi-navi/ui', () => {
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>{children}</button>
    ),
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
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
  llmExplanation?: {
    summary: string;
  };
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
  feedback?: {
    key: string;
    baseConfidence: number;
    adjustment: number;
    adjustedConfidence: number;
    applied: boolean;
    sampleCount: number;
  };
  metadata?: {
    feedback?: {
      key: string;
      baseConfidence: number;
      adjustment: number;
      adjustedConfidence: number;
      applied: boolean;
      sampleCount: number;
    };
    targetType?: 'api_endpoint' | 'db_table' | 'topic' | 'queue';
    analysisMode?: string;
    fallbackReason?: 'NO_ENDPOINT_OBJECTS' | 'PATH_NOT_MATCHED' | 'METHOD_NOT_MATCHED' | 'INSUFFICIENT_CONTEXT';
    fallbackContext?: {
      attemptedMethod: string;
      attemptedPath: string;
      evidenceSummary?: string;
    };
    [key: string]: unknown;
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
  llmExplanation?: RelationCandidate['llmExplanation'],
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
    ...(llmExplanation ? { llmExplanation } : {}),
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

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  };
}

describe('ApprovalList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const localStorageMock = createLocalStorageMock();
    vi.stubGlobal('localStorage', localStorageMock);
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });
    window.localStorage.clear();
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

  it('proof chain과 frontier queue 정보를 렌더링해야 한다', async () => {
    const candidate = createCandidate('cand-proof', 'service-proof', 'call', undefined, {
      summary: 'proof trace available',
    });
    candidate.metadata = {
      feedback: {
        key: 'call:gateway:service-proof',
        baseConfidence: 0.72,
        adjustment: 0.08,
        adjustedConfidence: 0.8,
        applied: true,
        sampleCount: 4,
      },
      targetType: 'api_endpoint',
      proof: {
        sourceService: 'gateway',
        sourceFunction: 'OrderController.getOrders',
        resolvedProviderEndpoint: { method: 'GET', path: '/orders' },
        routeChain: ['gateway', 'orders'],
        supportingEvidence: ['gateway.ts:42'],
        contradictions: [{ type: 'STALE_CONFIG' }],
        proofSteps: [
          { id: 's1', stepType: 'resolve_alias', status: 'ok' },
          { id: 's2', stepType: 'match_endpoint', status: 'ok' },
        ],
        frontierHistory: [
          {
            id: 'f1',
            frontierReason: 'PATH_NOT_MATCHED',
            missingSlots: ['provider_path'],
            relevantSnippets: ['routes/order.ts'],
            lastResolutionStep: 'match_endpoint',
            hasAgentPatch: true,
            retryable: true,
          },
        ],
        patchHistory: [
          { id: 'p1', patchType: 'route_patch', status: 'APPLIED' },
        ],
      },
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([candidate]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-proof');
    expect(screen.getByTestId('frontier-queue')).toBeTruthy();
    expect(screen.getByText(/Frontier Queue/)).toBeTruthy();
    expect(screen.getByText(/reason PATH_NOT_MATCHED/)).toBeTruthy();

    fireEvent.click(screen.getByText('Proof chain drill-down'));
    await screen.findByText('source function: OrderController.getOrders');
    await screen.findByText('resolved provider endpoint: GET /orders');
    await screen.findByText('route chain: gateway -> orders');
    await screen.findByText('frontier history: PATH_NOT_MATCHED');
    await screen.findByText('patch history: route_patch(APPLIED)');
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

  it('Smart 모드 실패 시 proof engine 요청 body를 유지하고 사용자 메시지를 표시해야 한다', async () => {
    window.localStorage.setItem('archi-navi:ai-provider', 'openai');
    window.localStorage.setItem('archi-navi:ai-api-key', 'test-key');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/api/scan/paths?')) {
        return Promise.resolve(jsonResponse({
          paths: ['/tmp/orders-service'],
          parentDirs: ['/tmp'],
        }));
      }
      if (url === '/api/inference/smart') {
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/json',
          'x-ai-provider': 'openai',
          'x-ai-api-key': 'test-key',
        });
        return Promise.resolve(jsonResponse({
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'analysisMode is no longer supported',
          },
        }, false));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('analysisMode is no longer supported');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inference/smart',
      expect.objectContaining({
        body: JSON.stringify({
          workspaceId: 'ws-1',
          repoRoots: ['/tmp/orders-service'],
          useServiceMetadataPaths: true,
          async: true,
          pipeline: 'reinforced',
          pipelineVersion: 'reinforced-v1',
        }),
      }),
    );
  });

  it('Smart 모드는 proof summary 응답을 성공 토스트와 viewer에 반영해야 한다', async () => {
    let candidateRequestCount = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        candidateRequestCount += 1;
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/api/scan/paths?')) {
        return Promise.resolve(jsonResponse({
          paths: ['/tmp/orders-service'],
          parentDirs: ['/tmp'],
        }));
      }
      if (url === '/api/inference/smart') {
        return Promise.resolve(jsonResponse({
          success: true,
          queued: true,
          runId: 'smart-run-1',
          pipeline: 'reinforced',
          pipelineVersion: 'reinforced-v1',
          run: {
            id: 'smart-run-1',
            status: 'QUEUED',
          },
          summary: {
            engine: 'intent_proof',
            pipeline: 'reinforced',
            pipelineVersion: 'reinforced-v1',
            intentCount: 0,
            gatewayRouteSeedCount: 0,
            derivedEndpointProofCount: 0,
            proofClosedAtomicCount: 0,
            proofFrontierCount: 0,
            routeFamilyFrontierCount: 0,
            proofRejectedCount: 0,
            projectedCandidateCount: 0,
            serviceTargetProjectionCount: 0,
            agentFrontierCount: 0,
            agentPatchedFrontierCount: 0,
            frontierBreakdown: {},
            targetBreakdown: {},
          },
          sources: [],
        }, true));
      }
      if (url.includes('/api/inference/smart?workspaceId=ws-1&runId=smart-run-1')) {
        return Promise.resolve(jsonResponse({
          success: true,
          pipeline: 'reinforced',
          pipelineVersion: 'reinforced-v1',
          run: {
            id: 'smart-run-1',
            status: 'SUCCEEDED',
            errorMessage: null,
            stats: {
              proofSummary: {
                engine: 'intent_proof',
                pipeline: 'reinforced',
                pipelineVersion: 'reinforced-v1',
                intentCount: 6,
                gatewayRouteSeedCount: 2,
                derivedEndpointProofCount: 4,
                proofClosedAtomicCount: 4,
                proofFrontierCount: 1,
                routeFamilyFrontierCount: 1,
                proofRejectedCount: 1,
                projectedCandidateCount: 4,
                serviceTargetProjectionCount: 0,
                agentFrontierCount: 1,
                agentPatchedFrontierCount: 1,
                frontierBreakdown: {
                  PATH_NOT_MATCHED: 1,
                },
                targetBreakdown: {
                  api_endpoint: 4,
                },
              },
            },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Smart 추론 완료 — intent 6개, route-family seed 2개, derived endpoint proof 4개, closed 4개, frontier 1개, rejected 1개, atomic candidate 4개, route-family frontier 1개, agent 대상 frontier 1개, agent patch 반영 1개',
      );
    });
    const viewer = await screen.findByTestId('smart-trace-viewer');
    expect(viewer.textContent).toContain('Intent Proof Summary');
    expect(viewer.textContent).toContain('pipeline reinforced');
    expect(viewer.textContent).toContain('reinforced-v1');
    expect(viewer.textContent).toContain('intent 6개');
    expect(viewer.textContent).toContain('route-family seed 2개');
    expect(viewer.textContent).toContain('derived endpoint proof 4개');
    expect(viewer.textContent).toContain('closed 4개');
    expect(viewer.textContent).toContain('frontier 1개');
    expect(viewer.textContent).toContain('route-family frontier 1개');
    expect(viewer.textContent).toContain('Frontier breakdown: PATH_NOT_MATCHED 1개');
    expect(viewer.textContent).toContain('Target breakdown: api_endpoint 4개');
    expect(candidateRequestCount).toBe(2);
  });

  it('Smart trace viewer는 breakdown 정보가 없어도 안전하게 렌더링해야 한다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/api/scan/paths?')) {
        return Promise.resolve(jsonResponse({
          paths: ['/tmp/orders-service'],
          parentDirs: ['/tmp'],
        }));
      }
      if (url === '/api/inference/smart') {
        return Promise.resolve(jsonResponse({
          success: true,
          queued: true,
          runId: 'smart-run-2',
          pipeline: 'reinforced',
          pipelineVersion: 'reinforced-v1',
          run: {
            id: 'smart-run-2',
            status: 'QUEUED',
          },
          sources: [],
        }));
      }
      if (url.includes('/api/inference/smart?workspaceId=ws-1&runId=smart-run-2')) {
        return Promise.resolve(jsonResponse({
          success: true,
          pipeline: 'reinforced',
          pipelineVersion: 'reinforced-v1',
          run: {
            id: 'smart-run-2',
            status: 'SUCCEEDED',
            errorMessage: null,
            stats: {
              proofSummary: {
                engine: 'intent_proof',
                pipeline: 'reinforced',
                pipelineVersion: 'reinforced-v1',
                intentCount: 1,
                gatewayRouteSeedCount: 1,
                derivedEndpointProofCount: 0,
                proofClosedAtomicCount: 0,
                proofFrontierCount: 1,
                routeFamilyFrontierCount: 1,
                proofRejectedCount: 0,
                projectedCandidateCount: 0,
                serviceTargetProjectionCount: 0,
                agentFrontierCount: 0,
                agentPatchedFrontierCount: 0,
                frontierBreakdown: {},
                targetBreakdown: {},
              },
            },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        'Smart 추론 완료 — atomic 후보 0개 (intent 1개, route-family seed 1개, frontier 1개, rejected 0개, route-family frontier 1개)',
      );
    });
    const viewer = await screen.findByTestId('smart-trace-viewer');
    expect(viewer.textContent).toContain('pipeline reinforced');
    expect(viewer.textContent).toContain('이번 실행에서 추가 breakdown 정보가 없습니다.');
  });

  it('정적 분석 0건이라도 config artifact가 있으면 설정 파일 없음 오진 토스트를 띄우지 않아야 한다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/api/scan/paths?')) {
        return Promise.resolve(jsonResponse({
          paths: ['/tmp/orders-service'],
          parentDirs: ['/tmp'],
        }));
      }
      if (url === '/api/inference/run') {
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(parsedBody).toMatchObject({
          workspaceId: 'ws-1',
          repoRoots: ['/tmp/orders-service'],
          useServiceMetadataPaths: true,
        });
        return Promise.resolve(jsonResponse({
          summary: { relationCandidatesCreated: 0 },
          results: {
            config: {
              fileCount: 1,
              processedFileCount: 0,
              skippedFileCount: 0,
              aliasBindingCount: 2,
              routeTransformCount: 1,
              interactionIntentCount: 1,
            },
            code: {
              signalCount: 0,
              enginesUsed: ['hybrid'],
              fallbackCount: 0,
              scanFailures: [],
            },
          },
          warnings: [],
          llmBoost: {
            skippedReason: 'DISABLED',
            codeIntentAnalysis: { generatedCount: 0 },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith('추론 실행 완료 — 신규 관계 후보가 생성되지 않았습니다.');
    });
    expect(toast.warning).not.toHaveBeenCalledWith(
      '후보 0개 — 처리된 설정 파일이 없습니다. repoRoot/scanPath를 확인하세요.',
    );
  });

  it('추론 모드 선택은 현재 지원되는 standard/smart 두 옵션만 노출해야 한다', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    const selectors = screen.getAllByLabelText('추론 모드') as HTMLSelectElement[];
    for (const selector of selectors) {
      const optionValues = Array.from(selector.options).map((option) => option.value);
      const optionLabels = Array.from(selector.options).map((option) => option.textContent);
      expect(optionValues).toEqual(['standard', 'smart']);
      expect(optionLabels).toEqual(['정적 분석', 'Smart Proof Engine']);
    }
    const pipelineSelectors = screen.getAllByLabelText('파이프라인') as HTMLSelectElement[];
    for (const selector of pipelineSelectors) {
      const optionValues = Array.from(selector.options).map((option) => option.value);
      const optionLabels = Array.from(selector.options).map((option) => option.textContent);
      expect(optionValues).toEqual(['reinforced', 'redesign']);
      expect(optionLabels).toEqual(['보강형', '재설계']);
    }
  });

  it('mixed atomic/compound 목록에서도 교차 검증 정렬 우선순서를 유지해야 한다', async () => {
    const atomicSingle = {
      ...createCandidate('cand-17', 'GET /orders'),
      objectGranularity: 'ATOMIC' as const,
      objectParentName: 'order-service',
      objectObjectType: 'api_endpoint',
      confidence: 0.95,
      crossValidation: {
        validated: false,
        supportCount: 1,
        supportingSources: ['code'],
      },
    };
    const compoundWarning = {
      ...createCandidate('cand-18', 'billing-service'),
      confidence: 0.4,
      crossValidation: {
        validated: false,
        supportCount: 1,
        supportingSources: ['config'],
        contradictions: [{ ruleId: 'C2', type: 'PHANTOM_CALL' as const, penalty: 0.15 }],
      },
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([atomicSingle, compoundWarning]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('GET /orders');
    const cards = screen.getAllByTestId('approval-candidate-card');
    expect(cards[0]?.textContent).toContain('billing-service');
    expect(cards[1]?.textContent).toContain('GET /orders');
  });

  it('approval 목록은 더 보기로 다음 페이지를 불러온 뒤 정렬/필터해야 한다', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      createCandidate(`cand-page-${index}`, `service-${index}`),
    );
    const secondPage = [
      createCandidate('cand-last', 'late-warning', 'call', {
        validated: false,
        supportCount: 1,
        supportingSources: ['code'],
        contradictions: [{ ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 }],
      }),
    ];

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/inference/candidates') {
        const offset = url.searchParams.get('offset');
        if (offset === '0') return Promise.resolve(jsonResponse(firstPage));
        if (offset === '200') return Promise.resolve(jsonResponse(secondPage));
        throw new Error(`Unexpected offset: ${offset}`);
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-0');
    expect(screen.queryByText('late-warning')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /더 보기/ }));
    await waitFor(() => {
      expect(screen.getByText('late-warning')).toBeTruthy();
    }, { timeout: 10000 });
    fireEvent.change(screen.getByLabelText('교차 검증 필터'), {
      target: { value: 'warnings' },
    });

    expect(screen.getByText('late-warning')).toBeTruthy();
    expect(screen.queryByText('service-0')).toBeNull();
  });

  it('relation approval 카드에 feedback hint 상태를 구분해 표시해야 한다', async () => {
    const noStats = {
      ...createCandidate('cand-feedback-0', 'GET /inventory'),
      objectGranularity: 'ATOMIC' as const,
      objectParentName: 'inventory-service',
      objectObjectType: 'api_endpoint',
      metadata: {
        feedback: {
          key: 'CALL:code:call',
          baseConfidence: 0.6,
          adjustment: 0,
          adjustedConfidence: 0.6,
          applied: false,
          sampleCount: 0,
        },
      },
    };
    const insufficient = {
      ...createCandidate('cand-feedback-1', 'GET /payments'),
      objectGranularity: 'ATOMIC' as const,
      objectParentName: 'payment-service',
      objectObjectType: 'api_endpoint',
      metadata: {
        feedback: {
          key: 'CALL:code:call',
          baseConfidence: 0.62,
          adjustment: 0,
          adjustedConfidence: 0.62,
          applied: false,
          sampleCount: 4,
        },
      },
    };
    const applied = {
      ...createCandidate('cand-feedback-2', 'GET /orders'),
      objectGranularity: 'ATOMIC' as const,
      objectParentName: 'order-service',
      objectObjectType: 'api_endpoint',
      metadata: {
        feedback: {
          key: 'CALL:code:call',
          baseConfidence: 0.6,
          adjustment: 0.06,
          adjustedConfidence: 0.66,
          applied: true,
          sampleCount: 12,
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([noStats, insufficient, applied]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    const cards = await screen.findAllByTestId('approval-candidate-card');
    const appliedCard = cards.find((card) => card.textContent?.includes('GET /orders'));
    const insufficientCard = cards.find((card) => card.textContent?.includes('GET /payments'));
    const noStatsCard = cards.find((card) => card.textContent?.includes('GET /inventory'));

    expect(appliedCard?.textContent).toContain('보정 적용');
    expect(appliedCard?.textContent).toContain('표본 12건');
    expect(appliedCard?.textContent).toContain('+6%p');
    expect(appliedCard?.textContent).toContain('60% → 66%');
    expect(insufficientCard?.textContent).toContain('표본 부족');
    expect(insufficientCard?.textContent).toContain('표본 4건으로 아직 보정 전입니다.');
    expect(noStatsCard?.textContent).toContain('통계 없음');
    expect(noStatsCard?.textContent).toContain('이 후보 key의 승인/거절 통계가 아직 없습니다.');
  });

  it('COMPOUND 후보의 feedback hint는 세부 매핑 흐름을 깨지 않아야 한다', async () => {
    const compoundCandidate = {
      ...createCandidate('cand-feedback-compound', 'billing-service'),
      metadata: {
        feedback: {
          key: 'CALL:config:dependency_decl',
          baseConfidence: 0.48,
          adjustment: 0.04,
          adjustedConfidence: 0.52,
          applied: true,
          sampleCount: 11,
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([compoundCandidate]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('billing-service');
    const card = screen.getByTestId('approval-candidate-card');
    expect(card.textContent).toContain('세부 매핑 전 prior에 +4%p 보정이 반영되어 있습니다.');
    expect(card.textContent).toContain('실제 승인/거절은 세부 매핑 후 생성되는 atomic 후보에서 진행됩니다.');
  });

  it('Smart summary에 service target projection이 남으면 성공이 아니라 불변식 위반 경고를 표시해야 한다', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/api/scan/paths?')) {
        return Promise.resolve(jsonResponse({
          paths: ['/tmp/orders-service'],
          parentDirs: ['/tmp'],
        }));
      }
      if (url === '/api/inference/smart') {
        return Promise.resolve(jsonResponse({
          success: true,
          queued: true,
          runId: 'smart-run-invariant',
          run: {
            id: 'smart-run-invariant',
            status: 'QUEUED',
          },
          sources: [],
        }));
      }
      if (url.includes('/api/inference/smart?workspaceId=ws-1&runId=smart-run-invariant')) {
        return Promise.resolve(jsonResponse({
          success: true,
          run: {
            id: 'smart-run-invariant',
            status: 'SUCCEEDED',
            errorMessage: null,
            stats: {
              proofSummary: {
                engine: 'intent_proof',
                intentCount: 3,
                gatewayRouteSeedCount: 1,
                derivedEndpointProofCount: 2,
                proofClosedAtomicCount: 2,
                proofFrontierCount: 0,
                routeFamilyFrontierCount: 0,
                proofRejectedCount: 0,
                projectedCandidateCount: 2,
                serviceTargetProjectionCount: 2,
                agentFrontierCount: 0,
                agentPatchedFrontierCount: 0,
                frontierBreakdown: {},
                targetBreakdown: {
                  api_endpoint: 2,
                },
              },
            },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        'Smart 추론 경고 — service target projection 불변식 위반 (intent 3개, route-family seed 1개, derived endpoint proof 2개, closed 2개, frontier 0개, rejected 0개, atomic candidate 0개, service target projection 2개)',
      );
    });
    const viewer = await screen.findByTestId('smart-trace-viewer');
    expect(viewer.textContent).toContain('불변식 위반 service target projection 2개');
  });

  it('LLM 설명이 있으면 후보 카드에 표시해야 한다', async () => {
    const candidate = createCandidate(
      'cand-llm',
      'service-llm',
      'call',
      undefined,
      { summary: 'caller-cand-llm 이 service-llm API 를 호출합니다.' },
    );

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([candidate]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('service-llm');
    expect(screen.getByText('caller-cand-llm 이 service-llm API 를 호출합니다.')).toBeTruthy();
  });

  it('후보가 없으면 다음 행동 링크를 포함한 empty state를 표시해야 한다', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계 후보가 없습니다');
    expect(screen.getByRole('link', { name: 'Object 목록 열기' }).getAttribute('href')).toBe('/services');
    expect(screen.getByRole('link', { name: '추론 이력 보기' }).getAttribute('href')).toBe('/inference-runs');
  });
});
