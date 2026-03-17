import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InferenceRunList } from '@/components/inference/inference-run-list';

const { listDashboardInferenceRunsMock, mutateDashboardInferenceRunMock } = vi.hoisted(() => ({
  listDashboardInferenceRunsMock: vi.fn(),
  mutateDashboardInferenceRunMock: vi.fn(),
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

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

describe('InferenceRunList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDashboardInferenceRunsMock.mockResolvedValue([createRun()]);
    mutateDashboardInferenceRunMock.mockResolvedValue({ canceled: true, status: 'CANCELED' });
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
});
