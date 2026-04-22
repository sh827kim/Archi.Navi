// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

vi.mock('@/components/shared/empty-state-guide', () => ({
  EmptyStateGuide: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('@/lib/client-ai-settings', () => ({
  getClientAiRequestHeaders: () => ({ 'x-ai-provider': 'openai' }),
}));

vi.mock('@archi-navi/ui', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div data-testid="frontier-sheet">{children}</div> : null
  ),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Spinner: () => <div>loading...</div>,
}));

import { FrontierApprovalList } from '@/components/approval/frontier-approval-list';

interface FrontierListItem {
  proofStateId: string;
  intentId: string | null;
  intentType: string | null;
  sourceServiceId: string | null;
  sourceServiceName: string | null;
  sourceFunctionId: string | null;
  sourceFunctionName: string | null;
  providerServiceId: string | null;
  providerServiceName: string | null;
  status: string | null;
  frontierReason: string;
  frontierClass: string;
  retryStrategy: string;
  priority: number;
  detail: Record<string, unknown>;
  gatewayKind?: string | null;
  externalRoutePattern?: string | null;
  methodResolved: string | null;
  externalPathResolved: string | null;
  internalPathResolved: string | null;
  confidence: number;
  latestPatch?: {
    id: string;
    patchType: string;
    validationStatus: string;
    sourceKind: string;
    createdAt: string;
  } | null;
}

interface FrontierDetail extends FrontierListItem {
  patchableActions: Array<
    'alias_binding'
    | 'provider_service_selection'
    | 'endpoint_disambiguation'
    | 'method_path_hint'
    | 'route_transform_patch'
  >;
  candidateServices: Array<{ id: string; name: string }>;
  candidateEndpoints: Array<{ id: string; name: string; parentId: string | null }>;
  suggestedServices: Array<{ id: string; name: string }>;
  recentProofSteps: Array<{
    id: string;
    stepOrder: number;
    stepType: string;
    status: string;
    message: string | null;
  }>;
}

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

function createFrontierItem(): FrontierListItem {
  return {
    proofStateId: 'proof-1',
    intentId: 'intent-1',
    intentType: 'HTTP_CLIENT',
    sourceServiceId: 'svc-source',
    sourceServiceName: 'source-service',
    sourceFunctionId: 'fn-1',
    sourceFunctionName: 'callApi',
    providerServiceId: 'svc-provider',
    providerServiceName: 'provider-a',
    status: 'FRONTIER',
    frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
    frontierClass: 'TARGET',
    retryStrategy: 'manual_review',
    priority: 10,
    detail: { candidateProviderIds: ['svc-a', 'svc-b'] },
    gatewayKind: null,
    externalRoutePattern: null,
    methodResolved: 'GET',
    externalPathResolved: '/orders',
    internalPathResolved: null,
    confidence: 0,
  };
}

function createFrontierDetail(): FrontierDetail {
  return {
    ...createFrontierItem(),
    patchableActions: ['provider_service_selection'],
    candidateServices: [
      { id: 'svc-a', name: 'provider-a' },
      { id: 'svc-b', name: 'provider-b' },
    ],
    candidateEndpoints: [],
    suggestedServices: [],
    recentProofSteps: [
      {
        id: 'step-1',
        stepOrder: 1,
        stepType: 'resolve_provider',
        status: 'FRONTIER',
        message: 'candidate conflict',
      },
    ],
  };
}

describe('FrontierApprovalList', () => {
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

  it('승격 성공 시 frontier detail을 다시 조회하지 않고 시트를 닫아야 한다', async () => {
    const initialItem = createFrontierItem();
    const detail = createFrontierDetail();
    const detailFetches: string[] = [];
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse(detailFetches.length === 0 ? [initialItem] : []));
      }
      if (url.includes('/api/inference/frontiers/proof-1?workspaceId=ws-1')) {
        detailFetches.push(url);
        return Promise.resolve(jsonResponse(detail));
      }
      if (url.endsWith('/api/inference/frontiers/proof-1/patch') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          validationStatus: 'ACCEPTED',
          proofStatus: 'CLOSED_ATOMIC',
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findByTestId('frontier-card');
    fireEvent.click(screen.getByRole('button', { name: '보정' }));
    await screen.findByText('Frontier 보정');

    fireEvent.change(screen.getAllByRole('combobox')[2] as HTMLSelectElement, {
      target: { value: 'svc-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Patch 적용' }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Frontier를 승격했습니다. candidate로 이동했습니다.');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('frontier-sheet')).toBeNull();
    });

    expect(detailFetches).toHaveLength(1);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('frontier 유지 시에는 최신 상태 반영을 위해 detail을 다시 조회해야 한다', async () => {
    const initialItem = createFrontierItem();
    const detail = createFrontierDetail();
    let detailFetchCount = 0;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([initialItem]));
      }
      if (url.includes('/api/inference/frontiers/proof-1?workspaceId=ws-1')) {
        detailFetchCount += 1;
        return Promise.resolve(jsonResponse({
          ...detail,
          recentProofSteps: [
            ...detail.recentProofSteps,
            {
              id: `step-${detailFetchCount + 1}`,
              stepOrder: detailFetchCount + 1,
              stepType: 'replay',
              status: 'FRONTIER',
              message: 'still unresolved',
            },
          ],
        }));
      }
      if (url.endsWith('/api/inference/frontiers/proof-1/patch') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          validationStatus: 'ACCEPTED',
          proofStatus: 'FRONTIER',
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findByTestId('frontier-card');
    fireEvent.click(screen.getByRole('button', { name: '보정' }));
    await screen.findByText('Frontier 보정');

    fireEvent.change(screen.getAllByRole('combobox')[2] as HTMLSelectElement, {
      target: { value: 'svc-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Patch 적용' }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith('Patch를 적용했지만 아직 frontier 상태입니다.');
    });
    await waitFor(() => {
      expect(detailFetchCount).toBe(2);
    });
    expect(screen.getByTestId('frontier-sheet')).toBeTruthy();
  });

  it('보류 저장 시에는 PENDING patch를 저장하고 detail만 새로고침해야 한다', async () => {
    const initialItem = {
      ...createFrontierItem(),
      latestPatch: {
        id: 'patch-old',
        patchType: 'provider_service_selection',
        validationStatus: 'PENDING',
        sourceKind: 'manual',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
    };
    const detail = createFrontierDetail();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const patchRequests: Array<Record<string, unknown>> = [];
    let detailFetchCount = 0;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([initialItem]));
      }
      if (url.includes('/api/inference/frontiers/proof-1?workspaceId=ws-1')) {
        detailFetchCount += 1;
        return Promise.resolve(jsonResponse(detail));
      }
      if (url.endsWith('/api/inference/frontiers/proof-1/patch') && init?.method === 'POST') {
        patchRequests.push(JSON.parse(String(init.body)));
        return Promise.resolve(jsonResponse({
          validationStatus: 'PENDING',
          proofStatus: 'FRONTIER',
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findByText('보류');
    await screen.findByTestId('frontier-card');
    fireEvent.click(screen.getByRole('button', { name: '보정' }));
    await screen.findByText('Frontier 보정');

    fireEvent.change(screen.getAllByRole('combobox')[2] as HTMLSelectElement, {
      target: { value: 'svc-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: '보류 저장' }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Patch를 보류로 저장했습니다. 수동 검토 대기 상태입니다.');
    });
    await waitFor(() => {
      expect(detailFetchCount).toBe(2);
    });

    expect(screen.getByTestId('frontier-sheet')).toBeTruthy();
    expect(patchRequests[0]).toMatchObject({
      workspaceId: 'ws-1',
      patchType: 'provider_service_selection',
      applyMode: 'defer',
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('route_transform_patch는 top-level gatewayKind와 externalRoutePattern을 사용해야 한다', async () => {
    const initialItem = {
      ...createFrontierItem(),
      frontierReason: 'ROUTE_FAMILY_DERIVATION_EMPTY',
      detail: {},
      gatewayKind: 'spring_cloud_gateway',
      externalRoutePattern: '/api/orders/**',
      externalPathResolved: '/api/orders/**',
    };
    const detail: FrontierDetail = {
      ...initialItem,
      patchableActions: ['route_transform_patch'],
      candidateServices: [],
      candidateEndpoints: [],
      suggestedServices: [],
      recentProofSteps: [],
    };
    const patchRequests: Array<Record<string, unknown>> = [];

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([initialItem]));
      }
      if (url.includes('/api/inference/frontiers/proof-1?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse(detail));
      }
      if (url.endsWith('/api/inference/frontiers/proof-1/patch') && init?.method === 'POST') {
        patchRequests.push(JSON.parse(String(init.body)));
        return Promise.resolve(jsonResponse({
          validationStatus: 'ACCEPTED',
          proofStatus: 'FRONTIER',
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findByTestId('frontier-card');
    fireEvent.click(screen.getByRole('button', { name: '보정' }));
    await screen.findByText('Frontier 보정');

    fireEvent.change(screen.getByPlaceholderText('orders-service'), {
      target: { value: 'orders-service' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Patch 적용' }));

    await waitFor(() => {
      expect(patchRequests).toHaveLength(1);
    });
    expect(patchRequests[0]).toMatchObject({
      workspaceId: 'ws-1',
      patchType: 'route_transform_patch',
      payload: {
        gatewayKind: 'spring_cloud_gateway',
        matchPath: '/api/orders/**',
        targetServiceHint: 'orders-service',
      },
    });
  });

  it('PROVIDER_SERVICE_AMBIGUOUS frontier에서 Smart 재검토 성공 시 frontier/candidate를 함께 새로고침해야 한다', async () => {
    const item = createFrontierItem();
    const detail = createFrontierDetail();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    let frontierFetchCount = 0;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        frontierFetchCount += 1;
        return Promise.resolve(jsonResponse([item]));
      }
      if (url.includes('/api/inference/frontiers/proof-1?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse(detail));
      }
      if (url.endsWith('/api/inference/frontiers/smart-review') && init?.method === 'POST') {
        expect(init.headers).toMatchObject({
          'Content-Type': 'application/json',
          'x-ai-provider': 'openai',
        });
        expect(JSON.parse(String(init.body))).toMatchObject({
          workspaceId: 'ws-1',
          proofStateId: 'proof-1',
          smartProof: {
            categories: {
              ambiguityResolution: true,
            },
          },
        });
        return Promise.resolve(jsonResponse({
          success: true,
          summary: {
            reclassifiedCount: 1,
            promotedCount: 1,
            reclassificationCounts: {
              provider_service_selection: 1,
            },
            pendingCount: 0,
            skippedCount: 0,
          },
          remainingProofStateIds: [],
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findByTestId('frontier-card');
    fireEvent.click(screen.getByRole('button', { name: 'Smart 재검토' }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Smart 재검토 완료 (재분류: 제공 서비스 선택 1, 후보 승격 1, 보류 0, 건너뜀 0)');
    });
    await waitFor(() => {
      expect(frontierFetchCount).toBeGreaterThanOrEqual(2);
    });
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
  });

  it('선택한 항목만 일괄 Smart 재검토 요청을 보내야 한다', async () => {
    const item1 = createFrontierItem();
    const item2 = { ...createFrontierItem(), proofStateId: 'proof-2', sourceServiceName: 'source-service-2' };
    const requests: Array<Record<string, unknown>> = [];

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([item1, item2]));
      }
      if (url.endsWith('/api/inference/frontiers/smart-review') && init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)));
        return Promise.resolve(jsonResponse({
          success: true,
          summary: {
            reclassifiedCount: 1,
            promotedCount: 0,
            reclassificationCounts: { provider_service_selection: 1 },
            pendingCount: 0,
            skippedCount: 1,
          },
          remainingProofStateIds: ['proof-2'],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);
    await screen.findAllByTestId('frontier-card');

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: '선택' });
    fireEvent.click(rowCheckboxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: '선택 항목 Smart 재검토 (1)' }));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toMatchObject({
      workspaceId: 'ws-1',
      proofStateId: 'proof-1',
    });
  });

  it('재분류 타입별 집계가 일부만 있어도 총 재분류 수를 toast에 유지해야 한다', async () => {
    const item1 = createFrontierItem();
    const item2 = { ...createFrontierItem(), proofStateId: 'proof-2', sourceServiceName: 'source-service-2' };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([item1, item2]));
      }
      if (url.endsWith('/api/inference/frontiers/smart-review') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          success: true,
          summary: {
            reclassifiedCount: 2,
            promotedCount: 1,
            reclassificationCounts: { provider_service_selection: 1 },
            pendingCount: 0,
            skippedCount: 0,
          },
          remainingProofStateIds: [],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);
    await screen.findAllByTestId('frontier-card');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Smart 대상 전체 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '선택 항목 Smart 재검토 (2)' }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Smart 재검토 완료 (재분류: 제공 서비스 선택 1, 유형 미확인 1, 후보 승격 1, 보류 0, 건너뜀 0)',
      );
    });
  });

  it('단건 Smart 재검토 진행 중에는 선택 항목 Smart 재검토 버튼이 비활성화되어야 한다', async () => {
    const item = createFrontierItem();
    const requests: Array<Record<string, unknown>> = [];
    let resolveSmartReview: ((value: Response) => void) | null = null;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([item]));
      }
      if (url.endsWith('/api/inference/frontiers/smart-review') && init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => {
          resolveSmartReview = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);
    await screen.findByTestId('frontier-card');

    fireEvent.click(screen.getByRole('checkbox', { name: '선택' }));
    const bulkButton = screen.getByRole('button', { name: '선택 항목 Smart 재검토 (1)' });
    const smartButton = screen.getByRole('button', { name: 'Smart 재검토' });

    fireEvent.click(smartButton);

    await waitFor(() => {
      expect(requests).toHaveLength(1);
      expect(bulkButton).toHaveProperty('disabled', true);
    });

    resolveSmartReview?.(jsonResponse({
      success: true,
      summary: {
        reclassifiedCount: 1,
        promotedCount: 1,
        reclassificationCounts: { provider_service_selection: 1 },
        pendingCount: 0,
        skippedCount: 0,
      },
      remainingProofStateIds: [],
    }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Smart 재검토 완료 (재분류: 제공 서비스 선택 1, 후보 승격 1, 보류 0, 건너뜀 0)');
    });
  });

  it('frontier 타입 코드는 카드와 상세에서 한글 라벨과 설명으로 표시해야 한다', async () => {
    const item = { ...createFrontierItem(), frontierClass: 'ALIAS' };
    const detail = { ...createFrontierDetail(), frontierClass: 'ALIAS' };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([item]));
      }
      if (url.includes('/api/inference/frontiers/proof-1?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse(detail));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    const card = await screen.findByTestId('frontier-card');
    expect(screen.getByText('HTTP 호출')).toBeTruthy();
    expect(within(card).getAllByText('제공 서비스 모호')).toHaveLength(1);
    expect(screen.getByTitle('후보 서비스가 여러 개라 호출 대상 서비스를 하나로 확정해야 합니다.')).toBeTruthy();
    expect(screen.queryByText('HTTP_CLIENT · PROVIDER_SERVICE_AMBIGUOUS')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '보정' }));
    await screen.findByText('Frontier 보정');

    expect(screen.getAllByText('제공 서비스 모호').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('별칭 해소').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTitle('설정 키, host alias, service discovery 이름을 실제 서비스와 연결해야 하는 frontier입니다.').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('ALIAS')).toBeNull();
  });

  it('latest patch 타입도 저장 가능한 patch type 전체를 한글로 표시해야 한다', async () => {
    const item = {
      ...createFrontierItem(),
      latestPatch: {
        id: 'patch-summary',
        patchType: 'function_summary_patch',
        validationStatus: 'ACCEPTED',
        sourceKind: 'smart_agent',
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([item]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findByTestId('frontier-card');
    expect(document.body.textContent).toContain('함수 요약 보강');
    expect(document.body.textContent).toContain('재분류 적용');
    expect(screen.queryByText('function_summary_patch')).toBeNull();
  });

  it('DB와 메시지 frontier reason도 한글 라벨과 설명으로 표시해야 한다', async () => {
    const dbItem = {
      ...createFrontierItem(),
      proofStateId: 'proof-db',
      sourceServiceName: 'db-service',
      intentType: 'db_access',
      frontierReason: 'DB_SCHEMA_AMBIGUOUS',
      frontierClass: 'TARGET',
    };
    const messageItem = {
      ...createFrontierItem(),
      proofStateId: 'proof-message',
      sourceServiceName: 'message-service',
      intentType: 'message_publish',
      frontierReason: 'MESSAGE_TARGET_UNRESOLVED',
      frontierClass: 'TARGET',
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([dbItem, messageItem]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findAllByTestId('frontier-card');
    expect(screen.getAllByText('DB 스키마 모호').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('메시지 대상 미해결').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTitle('같은 테이블명이 여러 스키마에 있어 대상 DB 테이블을 하나로 확정해야 합니다.')).toBeTruthy();
    expect(screen.getByTitle('메시지 topic/queue 힌트가 부족하거나 대상 채널을 찾지 못한 상태입니다.')).toBeTruthy();
    expect(screen.queryByText('DB_SCHEMA_AMBIGUOUS')).toBeNull();
    expect(screen.queryByText('MESSAGE_TARGET_UNRESOLVED')).toBeNull();
  });

  it('동적 URI와 gateway frontier reason도 한글 라벨과 설명으로 표시해야 한다', async () => {
    const dynamicUriItem = {
      ...createFrontierItem(),
      proofStateId: 'proof-dynamic-uri',
      sourceServiceName: 'dynamic-uri-service',
      frontierReason: 'DYNAMIC_URI_UNRESOLVED',
      frontierClass: 'METHOD_PATH',
    };
    const broadRouteItem = {
      ...createFrontierItem(),
      proofStateId: 'proof-broad-route',
      sourceServiceName: 'broad-route-service',
      intentType: 'http_gateway_route',
      frontierReason: 'ROUTE_FAMILY_TOO_BROAD',
      frontierClass: 'ROUTE',
    };
    const openEndpointItem = {
      ...createFrontierItem(),
      proofStateId: 'proof-open-endpoint',
      sourceServiceName: 'open-endpoint-service',
      intentType: 'http_gateway_route',
      frontierReason: 'ENDPOINT_SET_OPEN',
      frontierClass: 'ROUTE',
    };

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/inference/frontiers?workspaceId=ws-1')) {
        return Promise.resolve(jsonResponse([dynamicUriItem, broadRouteItem, openEndpointItem]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<FrontierApprovalList />);

    await screen.findAllByTestId('frontier-card');
    expect(screen.getAllByText('동적 URI 미해결').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('라우트 범위 과다').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('엔드포인트 집합 미확정').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByTitle(
        '동적으로 조합된 URI라 호출 대상 경로나 endpoint를 정적으로 확정하지 못한 상태입니다.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByTitle(
        '게이트웨이 라우트가 너무 넓은 endpoint 집합으로 이어져 단일 대상을 확정하지 못한 상태입니다.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByTitle(
        '라우트가 연결될 수 있는 endpoint 집합이 열려 있어 proof를 닫지 못한 상태입니다.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('DYNAMIC_URI_UNRESOLVED')).toBeNull();
    expect(screen.queryByText('ROUTE_FAMILY_TOO_BROAD')).toBeNull();
    expect(screen.queryByText('ENDPOINT_SET_OPEN')).toBeNull();
  });
});
