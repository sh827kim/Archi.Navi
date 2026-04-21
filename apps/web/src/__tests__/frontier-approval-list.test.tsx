// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

    await screen.findByText('보류됨');
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
            acceptedCount: 1,
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
      expect(toast.success).toHaveBeenCalledWith('Smart 재검토 완료 (accepted 1, pending 0, skipped 0)');
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
          summary: { acceptedCount: 1, pendingCount: 0, skippedCount: 1 },
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
});
