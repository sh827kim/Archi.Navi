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
    targetType?: 'api_endpoint' | 'service';
    analysisMode?: string;
    fallbackReason?: 'NO_ENDPOINT_OBJECTS' | 'PATH_NOT_MATCHED' | 'METHOD_NOT_MATCHED' | 'INSUFFICIENT_CONTEXT';
    fallbackContext?: {
      attemptedMethod: string;
      attemptedPath: string;
      evidenceSummary?: string;
    };
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

  it('Smart 모드 실패 시 객체 에러에서도 사용자 메시지를 표시해야 한다', async () => {
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
            code: 'LLM_NOT_CONFIGURED',
            message: 'AI 제공자가 설정되지 않았습니다. 설정 > AI Settings에서 API 키를 입력해주세요.',
          },
        }, false));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'AI 제공자가 설정되지 않았습니다. 설정 > AI Settings에서 API 키를 입력해주세요.',
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inference/smart',
      expect.objectContaining({
        body: JSON.stringify({
          workspaceId: 'ws-1',
          repoRoots: ['/tmp'],
          useServiceMetadataPaths: true,
        }),
      }),
    );
  });

  it('Smart 모드가 중첩된 summary 응답도 성공 토스트로 처리해야 한다', async () => {
    let candidateRequestCount = 0;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
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
          data: {
            phase2: { analyzedServiceCount: 2, servicePairCount: 3 },
            phase3: {
              analyzedServiceCount: 3,
              candidateCount: 4,
              atomicCandidateCount: 2,
              serviceFallbackCount: 1,
              deepInspectionCount: 2,
              deepInspectionTrace: {
                attemptedCount: 2,
                failureCount: 1,
                triggerBreakdown: {
                  lowConfidence: 1,
                  insufficientContext: 1,
                },
                details: [
                  {
                    consumerServiceName: 'gateway',
                    providerServiceName: 'orders',
                    trigger: {
                      lowConfidence: true,
                      insufficientContext: false,
                    },
                    status: 'succeeded',
                    fallbackReasons: ['PATH_NOT_MATCHED'],
                    toolUsage: {
                      searchCalls: 2,
                      readCalls: 1,
                      endpointListCalls: 1,
                      totalCalls: 4,
                    },
                    recoveredCall: {
                      httpMethod: 'GET',
                      path: '/api/orders/{id}',
                    },
                  },
                ],
              },
              fallbackReasonBreakdown: {
                NO_ENDPOINT_OBJECTS: 1,
                PATH_NOT_MATCHED: 0,
                METHOD_NOT_MATCHED: 0,
                INSUFFICIENT_CONTEXT: 0,
              },
            },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Smart 추론 완료 — 후보 4개 생성 (Config LLM 2회, Pair LLM 3회, 서비스 쌍 3개, 원자 후보 2개, 서비스 fallback 1개 (엔드포인트 객체 없음 1개), Deep inspect 2회 (저신뢰 1개, 컨텍스트 부족 1개, 실패 1개))',
      );
    });
    const viewer = await screen.findByTestId('smart-trace-viewer');
    expect(viewer.textContent).toContain('Smart Deep Inspection Trace');
    expect(viewer.textContent).toContain('gateway -> orders');
    expect(viewer.textContent).toContain('트리거 저신뢰');
    expect(viewer.textContent).toContain('상태 성공');
    expect(viewer.textContent).toContain('도구 사용 search/read/endpoint/total = 2/1/1/4');
    expect(viewer.textContent).toContain('복구 호출 GET /api/orders/{id}');
    expect(candidateRequestCount).toBe(2);
    if (typeof window.localStorage?.removeItem === 'function') {
      window.localStorage.removeItem('archi-navi:ai-provider');
      window.localStorage.removeItem('archi-navi:ai-api-key');
    }
  });

  it('Smart trace detail 필드가 없어도 viewer를 안전하게 렌더링해야 한다', async () => {
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
          data: {
            phase2: { analyzedServiceCount: 1, servicePairCount: 1 },
            phase3: {
              analyzedServiceCount: 1,
              candidateCount: 0,
              atomicCandidateCount: 0,
              serviceFallbackCount: 1,
              deepInspectionCount: 1,
              deepInspectionTrace: {
                attemptedCount: 1,
                failureCount: 0,
                triggerBreakdown: {
                  lowConfidence: 1,
                  insufficientContext: 0,
                },
              },
              fallbackReasonBreakdown: {
                NO_ENDPOINT_OBJECTS: 0,
                PATH_NOT_MATCHED: 1,
                METHOD_NOT_MATCHED: 0,
                INSUFFICIENT_CONTEXT: 0,
              },
            },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    const viewer = await screen.findByTestId('smart-trace-viewer');
    expect(viewer.textContent).toContain('Deep inspect 1회');
    expect(viewer.textContent).toContain('pair 상세 정보 없음');
  });

  it('Smart trace viewer가 no_result 상태를 결과 없음으로 표시해야 한다', async () => {
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
          data: {
            phase2: { analyzedServiceCount: 1, servicePairCount: 1 },
            phase3: {
              analyzedServiceCount: 1,
              candidateCount: 0,
              atomicCandidateCount: 0,
              serviceFallbackCount: 1,
              deepInspectionCount: 1,
              deepInspectionTrace: {
                attemptedCount: 1,
                failureCount: 0,
                triggerBreakdown: {
                  lowConfidence: 1,
                  insufficientContext: 0,
                },
                details: [
                  {
                    consumerServiceName: 'gateway',
                    providerServiceName: 'orders',
                    trigger: {
                      lowConfidence: true,
                      insufficientContext: false,
                    },
                    status: 'no_result',
                    fallbackReasons: ['INSUFFICIENT_CONTEXT'],
                    toolUsage: {
                      searchCalls: 1,
                      readCalls: 1,
                      endpointListCalls: 1,
                      totalCalls: 3,
                    },
                    recoveredCall: null,
                  },
                ],
              },
              fallbackReasonBreakdown: {
                NO_ENDPOINT_OBJECTS: 0,
                PATH_NOT_MATCHED: 0,
                METHOD_NOT_MATCHED: 0,
                INSUFFICIENT_CONTEXT: 1,
              },
            },
          },
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('승인 대기 중인 관계가 없습니다');
    fireEvent.change(screen.getByLabelText('추론 모드'), {
      target: { value: 'smart' },
    });
    fireEvent.click(screen.getByRole('button', { name: /추론 실행/ }));

    const viewer = await screen.findByTestId('smart-trace-viewer');
    expect(viewer.textContent).toContain('gateway -> orders');
    expect(viewer.textContent).toContain('상태 결과 없음');
    expect(viewer.textContent).toContain('fallback 컨텍스트 부족');
    expect(viewer.textContent).not.toContain('상태 성공');
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

    fireEvent.click(screen.getByRole('button', { name: /더 보기/ }));
    await screen.findByText('late-warning');
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

    await screen.findByText('GET /orders');
    const cards = screen.getAllByTestId('approval-candidate-card');
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

  it('Smart service fallback 후보는 fallback reason hint를 카드에 표시해야 한다', async () => {
    const fallbackCandidate = {
      ...createCandidate('cand-smart-fallback', 'orders-service'),
      metadata: {
        targetType: 'service' as const,
        analysisMode: 'pair_pack',
        fallbackReason: 'PATH_NOT_MATCHED' as const,
        fallbackContext: {
          attemptedMethod: 'GET',
          attemptedPath: '/api/orders/missing',
          evidenceSummary: 'fetch("http://orders/api/orders/missing")',
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/candidates?')) {
        return Promise.resolve(jsonResponse([fallbackCandidate]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ApprovalList />);

    await screen.findByText('orders-service');
    const card = screen.getByTestId('approval-candidate-card');
    expect(card.textContent).toContain('Smart fallback');
    expect(card.textContent).toContain('경로 불일치');
    expect(card.textContent).toContain('호출 경로와 일치하는 endpoint를 찾지 못해 서비스 레벨 후보로 남았습니다.');
    expect(card.textContent).toContain('시도 호출 GET /api/orders/missing');
    expect(card.textContent).toContain('근거 fetch("http://orders/api/orders/missing")');
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
});
