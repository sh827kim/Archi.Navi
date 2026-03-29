import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        status: 'ACTIVE',
        message: null,
      },
    ],
    events: [
      {
        id: 'evt-1',
        level: 'INFO',
        eventType: 'RUN_STARTED',
        message: '실행 시작',
        createdAt: '2026-03-17T12:00:10.000Z',
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
});
