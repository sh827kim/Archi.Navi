import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InferenceRunList } from '@/components/inference/inference-run-list';

const {
  listDashboardInferenceRunsMock,
  mutateDashboardInferenceRunMock,
  getDashboardInferenceRunDetailMock,
} = vi.hoisted(() => ({
  listDashboardInferenceRunsMock: vi.fn(),
  mutateDashboardInferenceRunMock: vi.fn(),
  getDashboardInferenceRunDetailMock: vi.fn(),
}));

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast }));

vi.mock('@/actions/inference-runs', () => ({
  listDashboardInferenceRuns: listDashboardInferenceRunsMock,
  mutateDashboardInferenceRun: mutateDashboardInferenceRunMock,
  getDashboardInferenceRunDetail: getDashboardInferenceRunDetailMock,
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('lucide-react', () => ({
  CheckCircle: () => null,
  XCircle: () => null,
  Clock: () => null,
  Loader2: () => null,
  Ban: () => null,
  RotateCcw: () => null,
  RefreshCw: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  FolderOpen: () => null,
  Zap: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Spinner: () => <div>loading...</div>,
}));

interface InferenceRunItem {
  id: string;
  status: string;
  triggerType: string;
  requestedModes: string[];
  requestedCodeEngine: string | null;
  requestedIncremental: boolean;
  attemptCount: number;
  maxAttempts: number;
  sourceSummary: Record<string, number>;
  stats: Record<string, unknown>;
  warnings: string[];
  errors: Array<{ mode: string; message: string }>;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

function createRun(overrides?: Partial<InferenceRunItem>): InferenceRunItem {
  return {
    id: 'run-1',
    status: 'RUNNING',
    triggerType: 'MANUAL',
    requestedModes: ['config'],
    requestedCodeEngine: null,
    requestedIncremental: true,
    attemptCount: 1,
    maxAttempts: 2,
    sourceSummary: { local: 1 },
    stats: { summary: { relationCandidatesCreated: 0 } },
    warnings: [],
    errors: [],
    errorMessage: null,
    startedAt: '2026-03-17T12:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-03-17T12:00:00.000Z',
    ...overrides,
  };
}

function createDetail() {
  return {
    run: createRun(),
    sources: [
      {
        id: 'src-1',
        sourceType: 'GITHUB',
        sourceRef: 'repo://acme/core',
        resolvedRepoRoot: '/tmp/repo',
        status: 'SUCCEEDED',
        message: null,
      },
    ],
    events: [
      {
        id: 'evt-1',
        level: 'INFO',
        eventType: 'RUN_STARTED',
        message: '실행 시작',
        payload: {
          attemptedFrontierCount: 1,
          skippedReason: 'DISABLED',
        },
        createdAt: '2026-03-17T12:00:10.000Z',
      },
    ],
    proofs: [
      {
        id: 'proof-1',
        intentId: 'intent-1',
        intentType: 'http_call',
        sourceServiceName: 'gateway',
        sourceFunctionName: 'OrderController.getOrders',
        parentProofStateId: null,
        childProofStateIds: ['proof-2'],
        proofType: 'http_endpoint',
        status: 'CLOSED_ATOMIC',
        targetObjectName: 'GET /orders',
        targetObjectType: 'api_endpoint',
        providerServiceName: 'orders-service',
        methodResolved: 'GET',
        externalPathResolved: '/orders',
        internalPathResolved: '/internal/orders',
        routeChain: ['gateway', 'orders-service'],
        ambiguityCount: 0,
        contradictionCount: 1,
        confidence: 0.82,
        confidenceBreakdown: {
          summaryQuality: 0.9,
          slotCompleteness: 1,
          corroboration: 0.75,
        },
        frontier: {
          frontierReason: 'HOST_ALIAS_UNRESOLVED',
          frontierClass: 'alias_binding',
          retryStrategy: 'agent_patch',
          priority: 10,
          detail: {
            hostAlias: 'orders.internal',
          },
        },
        rejectedReason: null,
        steps: [
          {
            id: 'step-1',
            stepOrder: 1,
            stepType: 'resolve_alias',
            status: 'SUCCEEDED',
            message: 'resolved',
            inputSnapshot: { alias: 'orders.internal' },
            outputSnapshot: { providerServiceId: 'svc-orders' },
          },
        ],
      },
    ],
  };
}

describe('InferenceRunList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDashboardInferenceRunsMock.mockResolvedValue([createRun()]);
    mutateDashboardInferenceRunMock.mockResolvedValue({ canceled: true, status: 'CANCELED' });
    getDashboardInferenceRunDetailMock.mockResolvedValue(createDetail());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('목록 조회와 액션 요청을 서버 액션으로 수행해야 한다', async () => {
    render(<InferenceRunList />);

    await screen.findByRole('button', { name: /취소/ });

    expect(listDashboardInferenceRunsMock).toHaveBeenNthCalledWith(1, {
      workspaceId: 'ws-1',
      limit: 30,
    });

    fireEvent.click(screen.getByRole('button', { name: /취소/ }));

    await waitFor(() => {
      expect(mutateDashboardInferenceRunMock).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        runId: 'run-1',
        action: 'cancel',
      });
    });

    expect(listDashboardInferenceRunsMock).toHaveBeenCalledTimes(2);
  });

  it('실행 카드를 클릭하면 상세를 조회하고 sources/events를 렌더링해야 한다', async () => {
    render(<InferenceRunList />);

    await screen.findByRole('button', { name: /취소/ });

    fireEvent.click(screen.getByRole('button', { name: /실행 중/ }));

    await waitFor(() => {
      expect(getDashboardInferenceRunDetailMock).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        runId: 'run-1',
      });
    });

    expect(await screen.findByText('소스 (1)')).toBeTruthy();
    expect(screen.getByText('repo://acme/core')).toBeTruthy();
    expect(screen.getByText('이벤트 로그 (1)')).toBeTruthy();
    expect(screen.getByText('실행 시작')).toBeTruthy();
  });

  it('동일 run을 다시 펼칠 때 cache가 있으면 상세 재조회하지 않아야 한다', async () => {
    render(<InferenceRunList />);

    await screen.findByRole('button', { name: /취소/ });
    const runCardButton = screen.getByRole('button', { name: /실행 중/ });

    fireEvent.click(runCardButton);
    expect(await screen.findByText('repo://acme/core')).toBeTruthy();
    expect(getDashboardInferenceRunDetailMock).toHaveBeenCalledTimes(1);

    fireEvent.click(runCardButton);
    await waitFor(() => {
      expect(screen.queryByText('repo://acme/core')).toBeNull();
    });

    fireEvent.click(runCardButton);
    expect(await screen.findByText('repo://acme/core')).toBeTruthy();
    expect(getDashboardInferenceRunDetailMock).toHaveBeenCalledTimes(1);
  });

  it('상세 조회 결과가 null이면 실패 toast를 띄우고 cache 없이 재조회해야 한다', async () => {
    getDashboardInferenceRunDetailMock.mockResolvedValueOnce(null);

    render(<InferenceRunList />);

    await screen.findByRole('button', { name: /취소/ });
    const runCardButton = screen.getByRole('button', { name: /실행 중/ });
    fireEvent.click(runCardButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('상세 정보 로드 실패');
    });
    expect(screen.queryByText('repo://acme/core')).toBeNull();
    expect(getDashboardInferenceRunDetailMock).toHaveBeenCalledTimes(1);

    fireEvent.click(runCardButton);

    await waitFor(() => {
      expect(getDashboardInferenceRunDetailMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('repo://acme/core')).toBeTruthy();
  });

  it('상세 로드 실패 시 에러 toast를 표시해야 한다', async () => {
    getDashboardInferenceRunDetailMock.mockRejectedValueOnce(new Error('network error'));

    render(<InferenceRunList />);

    await screen.findByRole('button', { name: /취소/ });
    fireEvent.click(screen.getByRole('button', { name: /실행 중/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('상세 정보 로드 실패');
    });
  });

  it('proofSummary 핵심 수치와 상세 소스 메시지를 렌더링해야 한다', async () => {
    listDashboardInferenceRunsMock.mockResolvedValue([
      createRun({
        status: 'SUCCEEDED',
        stats: {
          summary: {
            engine: 'intent_proof',
            intentCount: 7,
            gatewayRouteSeedCount: 2,
            derivedEndpointProofCount: 5,
            proofClosedAtomicCount: 5,
            proofFrontierCount: 1,
            routeFamilyFrontierCount: 1,
            proofRejectedCount: 1,
            projectedCandidateCount: 5,
            serviceTargetProjectionCount: 0,
          },
          frontierAgent: {
            attemptedFrontierCount: 2,
            proposedPatchCount: 1,
            appliedPatchCount: 1,
            rejectedPatchCount: 0,
          },
          requestedAgentPatches: {
            enabled: true,
            maxFrontiers: 5,
          },
        },
        finishedAt: '2026-03-17T12:01:00.000Z',
      }),
    ]);
    getDashboardInferenceRunDetailMock.mockResolvedValue({
      ...createDetail(),
      sources: [
        {
          id: 'src-1',
          sourceType: 'LOCAL',
          sourceRef: 'repo://acme/core',
          resolvedRepoRoot: '/tmp/repo',
          status: 'SKIPPED',
          message: 'repo root 확인 필요',
        },
      ],
    });

    render(<InferenceRunList />);

    await screen.findByText('후보 5개 생성');
    expect(screen.getByText('intent 7개')).toBeTruthy();
    expect(screen.getByText('route-family seed 2개')).toBeTruthy();
    expect(screen.getByText('derived endpoint proof 5개')).toBeTruthy();
    expect(screen.getByText('closed 5개')).toBeTruthy();
    expect(screen.getByText('frontier 1개')).toBeTruthy();
    expect(screen.getByText('route-family frontier 1개')).toBeTruthy();
    expect(screen.getByText('rejected 1개')).toBeTruthy();
    expect(screen.getByText('agent 시도 2개')).toBeTruthy();
    expect(screen.getByText('agent 적용 1개')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /성공/ }));

    expect(await screen.findByText('Proof/Frontier 요약')).toBeTruthy();
    expect(screen.getByText('patch 적용 1개')).toBeTruthy();
    expect(screen.getByText('Proof lineage (1)')).toBeTruthy();
    expect(screen.getByText('source service: gateway')).toBeTruthy();
    fireEvent.click(screen.getByText(/http_call/));
    expect(await screen.findByText('Confidence breakdown')).toBeTruthy();
    expect(screen.getByText('summaryQuality')).toBeTruthy();
    expect(screen.getByText('Frontier')).toBeTruthy();
    expect(screen.getByText('reason: HOST_ALIAS_UNRESOLVED')).toBeTruthy();
    fireEvent.click(screen.getByText(/1. resolve_alias/));
    expect(await screen.findByText('providerServiceId')).toBeTruthy();
    expect(await screen.findByText('repoRoot: /tmp/repo')).toBeTruthy();
    expect(screen.getByText('메시지: repo root 확인 필요')).toBeTruthy();
    expect(screen.getByText('건너뜀')).toBeTruthy();
    expect(screen.getByText('RUN_STARTED')).toBeTruthy();
    fireEvent.click(screen.getByText('payload'));
    expect(await screen.findByText('attemptedFrontierCount')).toBeTruthy();
  });

  it('service target projection이 감지되면 성공 카드 대신 불변식 위반 경고를 보여야 한다', async () => {
    listDashboardInferenceRunsMock.mockResolvedValue([
      createRun({
        status: 'SUCCEEDED',
        stats: {
          summary: {
            engine: 'intent_proof',
            intentCount: 4,
            gatewayRouteSeedCount: 1,
            derivedEndpointProofCount: 2,
            proofClosedAtomicCount: 2,
            proofFrontierCount: 0,
            routeFamilyFrontierCount: 0,
            proofRejectedCount: 0,
            projectedCandidateCount: 2,
            serviceTargetProjectionCount: 2,
          },
        },
        finishedAt: '2026-03-17T12:01:00.000Z',
      }),
    ]);

    render(<InferenceRunList />);

    expect(await screen.findByText('불변식 위반: service target projection 2개 감지')).toBeTruthy();
    expect(screen.queryByText('후보 0개 생성')).toBeNull();
    expect(screen.queryByText('후보 2개 생성')).toBeNull();
  });

  it('RUNNING 또는 QUEUED 항목이 있으면 polling으로 자동 새로고침해야 한다', async () => {
    vi.useFakeTimers();
    listDashboardInferenceRunsMock.mockResolvedValue([
      createRun({
        status: 'QUEUED',
        startedAt: null,
      }),
    ]);

    await act(async () => {
      render(<InferenceRunList />);
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(listDashboardInferenceRunsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(listDashboardInferenceRunsMock).toHaveBeenCalledTimes(2);
  });
});
