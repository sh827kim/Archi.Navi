import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Plus: Icon,
    Trash2: Icon,
    Palette: Icon,
    GripVertical: Icon,
    Eye: Icon,
    EyeOff: Icon,
    Check: Icon,
    Bot: Icon,
    FlaskConical: Icon,
    Database: Icon,
    RefreshCw: Icon,
    ScanLine: Icon,
    FolderSearch: Icon,
    Github: Icon,
    Building: Icon,
    Loader2: Icon,
    CheckCircle2: Icon,
    SkipForward: Icon,
    Tag: Icon,
    FolderOpen: Icon,
    History: Icon,
    ChevronRight: Icon,
    ArrowUp: Icon,
  };
});

vi.mock('@archi-navi/ui', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      aria-label="switch"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
    />
  ),
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  ConfirmDialog: () => null,
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

import { EngineSettings, ScanSettings } from '@/components/settings/settings-client';

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

describe('EngineSettings', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('relation/domain feedback summary와 reset을 분리해 렌더링하고 요청해야 한다', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'profile-1',
        wCode: 0.5,
        wDb: 0.3,
        wMsg: 0.2,
        minClusterSize: 3,
        crossValidation: {
          enabled: true,
          boostFactor: 0.3,
          penaltyFactor: 0.85,
        },
        relationFeedbackConfig: {
          enabled: true,
          minSamples: 12,
          maxAdjustment: 0.18,
        },
        relationFeedbackSummary: {
          totalKeys: 2,
          eligibleKeys: 1,
          approvedCount: 16,
          rejectedCount: 4,
          totalSamples: 20,
        },
        relationFeedbackEntries: [
          {
            key: 'READ:db:schema_hint',
            approved: 3,
            rejected: 1,
            total: 4,
            approvalRate: 0.75,
            adjustment: 0,
          },
          {
            key: 'CALL:code:call',
            approved: 13,
            rejected: 3,
            total: 16,
            approvalRate: 0.8125,
            adjustment: 0.05,
          },
        ],
        domainFeedbackConfig: {
          enabled: true,
          minSamples: 6,
          maxAdjustment: 0.12,
        },
        domainFeedbackSummary: {
          totalKeys: 1,
          eligibleKeys: 1,
          approvedCount: 7,
          rejectedCount: 1,
          totalSamples: 8,
        },
        domainFeedbackEntries: [
          {
            key: 'TRACK_A:domain-order:HIGH',
            approved: 7,
            rejected: 1,
            total: 8,
            approvalRate: 0.875,
            adjustment: 0.045,
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'profile-1',
        relationFeedbackConfig: {
          enabled: true,
          minSamples: 15,
          maxAdjustment: 0.2,
        },
        relationFeedbackSummary: {
          totalKeys: 2,
          eligibleKeys: 1,
          approvedCount: 16,
          rejectedCount: 4,
          totalSamples: 20,
        },
        relationFeedbackEntries: [
          {
            key: 'READ:db:schema_hint',
            approved: 3,
            rejected: 1,
            total: 4,
            approvalRate: 0.75,
            adjustment: 0,
          },
          {
            key: 'CALL:code:call',
            approved: 13,
            rejected: 3,
            total: 16,
            approvalRate: 0.8125,
            adjustment: 0.05,
          },
        ],
        domainFeedbackConfig: {
          enabled: true,
          minSamples: 9,
          maxAdjustment: 0.18,
        },
        domainFeedbackSummary: {
          totalKeys: 1,
          eligibleKeys: 0,
          approvedCount: 7,
          rejectedCount: 1,
          totalSamples: 8,
        },
        domainFeedbackEntries: [
          {
            key: 'TRACK_A:domain-order:HIGH',
            approved: 7,
            rejected: 1,
            total: 8,
            approvalRate: 0.875,
            adjustment: 0,
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'profile-1',
        relationFeedbackConfig: {
          enabled: true,
          minSamples: 10,
          maxAdjustment: 0.15,
        },
        relationFeedbackSummary: {
          totalKeys: 0,
          eligibleKeys: 0,
          approvedCount: 0,
          rejectedCount: 0,
          totalSamples: 0,
        },
        relationFeedbackEntries: [],
        domainFeedbackConfig: {
          enabled: true,
          minSamples: 9,
          maxAdjustment: 0.18,
        },
        domainFeedbackSummary: {
          totalKeys: 1,
          eligibleKeys: 0,
          approvedCount: 7,
          rejectedCount: 1,
          totalSamples: 8,
        },
        domainFeedbackEntries: [
          {
            key: 'TRACK_A:domain-order:HIGH',
            approved: 7,
            rejected: 1,
            total: 8,
            approvalRate: 0.875,
            adjustment: 0,
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'profile-1',
        relationFeedbackConfig: {
          enabled: true,
          minSamples: 10,
          maxAdjustment: 0.15,
        },
        relationFeedbackSummary: {
          totalKeys: 0,
          eligibleKeys: 0,
          approvedCount: 0,
          rejectedCount: 0,
          totalSamples: 0,
        },
        relationFeedbackEntries: [],
        domainFeedbackConfig: {
          enabled: true,
          minSamples: 10,
          maxAdjustment: 0.15,
        },
        domainFeedbackSummary: {
          totalKeys: 0,
          eligibleKeys: 0,
          approvedCount: 0,
          rejectedCount: 0,
          totalSamples: 0,
        },
        domainFeedbackEntries: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<EngineSettings workspaceId="ws-1" />);

    await screen.findByDisplayValue('12');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/inference/profiles/default?workspaceId=ws-1&includeFeedbackEntries=true',
    );

    const relationSection = screen.getByTestId('relation-feedback-section');
    const relationTable = within(relationSection).getByTestId('relation-feedback-detail-table');
    const relationRows = within(relationTable).getAllByRole('row');
    expect(relationRows[1]?.textContent).toContain('CALL:code:call');
    expect(relationRows[2]?.textContent).toContain('READ:db:schema_hint');
    expect(within(relationSection).getByText('+5%p')).toBeTruthy();

    const domainSection = screen.getByTestId('domain-feedback-section');
    const domainTable = within(domainSection).getByTestId('domain-feedback-detail-table');
    expect(within(domainTable).getByText('TRACK_A:domain-order:HIGH')).toBeTruthy();
    expect(within(domainSection).getByText('+4.5%p')).toBeTruthy();
    expect(
      screen.getByText(/queued\/orchestrated parity는 여기서 보장하지 않습니다/),
    ).toBeTruthy();

    fireEvent.change(
      within(relationSection).getByLabelText('최소 샘플 수'),
      { target: { value: '15' } },
    );
    fireEvent.change(
      within(relationSection).getByLabelText('최대 보정치'),
      { target: { value: '0.2' } },
    );
    fireEvent.change(
      within(domainSection).getByLabelText('최소 샘플 수'),
      { target: { value: '9' } },
    );
    fireEvent.change(
      within(domainSection).getByLabelText('최대 보정치'),
      { target: { value: '0.18' } },
    );
    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall?.[0]).toBe('/api/inference/profiles/default?includeFeedbackEntries=true');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      workspaceId: 'ws-1',
      relationFeedbackConfig: {
        enabled: true,
        minSamples: 15,
        maxAdjustment: 0.2,
      },
      domainFeedbackConfig: {
        enabled: true,
        minSamples: 9,
        maxAdjustment: 0.18,
      },
    });

    fireEvent.click(within(relationSection).getByRole('button', { name: 'Relation reset' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    const relationResetCall = fetchMock.mock.calls[2];
    expect(relationResetCall?.[0]).toBe('/api/inference/profiles/default?includeFeedbackEntries=true');
    expect(JSON.parse(String(relationResetCall?.[1]?.body))).toMatchObject({
      workspaceId: 'ws-1',
      resetRelationFeedback: true,
    });
    await waitFor(() => {
      expect(within(relationSection).getByText('아직 누적된 relation feedback 집계가 없습니다.')).toBeTruthy();
    });
    expect(within(domainSection).getByTestId('domain-feedback-detail-table')).toBeTruthy();

    fireEvent.click(within(domainSection).getByRole('button', { name: 'Domain reset' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
    const domainResetCall = fetchMock.mock.calls[3];
    expect(domainResetCall?.[0]).toBe('/api/inference/profiles/default?includeFeedbackEntries=true');
    expect(JSON.parse(String(domainResetCall?.[1]?.body))).toMatchObject({
      workspaceId: 'ws-1',
      resetDomainFeedback: true,
    });
    await waitFor(() => {
      expect(within(domainSection).getByText('아직 누적된 domain feedback 집계가 없습니다.')).toBeTruthy();
    });
  });

  it('legacy feedback alias만 내려오면 relation UI는 공개 계약 기본값을 유지해야 한다', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      id: 'profile-1',
      wCode: 0.5,
      wDb: 0.3,
      wMsg: 0.2,
      minClusterSize: 3,
      crossValidation: {
        enabled: true,
        boostFactor: 0.3,
        penaltyFactor: 0.85,
      },
      feedbackConfig: {
        enabled: false,
        minSamples: 99,
        maxAdjustment: 0.9,
      },
      feedbackSummary: {
        totalKeys: 3,
        eligibleKeys: 3,
        approvedCount: 20,
        rejectedCount: 2,
        totalSamples: 22,
      },
      feedbackEntries: [
        {
          key: 'CALL:legacy:alias',
          approved: 20,
          rejected: 2,
          total: 22,
          approvalRate: 0.91,
          adjustment: 0.2,
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<EngineSettings workspaceId="ws-1" />);

    const relationSection = await screen.findByTestId('relation-feedback-section');
    expect(within(relationSection).getByLabelText('최소 샘플 수')).toHaveProperty('value', '10');
    expect(within(relationSection).getByLabelText('최대 보정치')).toHaveProperty('value', '0.15');
    expect(
      within(relationSection).getByText('아직 누적된 relation feedback 집계가 없습니다.'),
    ).toBeTruthy();
    expect(screen.queryByText('CALL:legacy:alias')).toBeNull();
  });

  it('코드 스캔 설정에서 폴더 선택 다이얼로그로 경로를 반영할 수 있어야 한다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/inference/profiles/default?')) {
        return Promise.resolve(jsonResponse({
          id: 'profile-1',
          wCode: 0.5,
          wDb: 0.3,
          wMsg: 0.2,
          minClusterSize: 3,
          crossValidation: {
            enabled: true,
            boostFactor: 0.3,
            penaltyFactor: 0.85,
          },
          relationFeedbackConfig: {
            enabled: true,
            minSamples: 10,
            maxAdjustment: 0.15,
          },
          relationFeedbackSummary: {
            totalKeys: 0,
            eligibleKeys: 0,
            approvedCount: 0,
            rejectedCount: 0,
            totalSamples: 0,
          },
          relationFeedbackEntries: [],
          domainFeedbackConfig: {
            enabled: true,
            minSamples: 10,
            maxAdjustment: 0.15,
          },
          domainFeedbackSummary: {
            totalKeys: 0,
            eligibleKeys: 0,
            approvedCount: 0,
            rejectedCount: 0,
            totalSamples: 0,
          },
          domainFeedbackEntries: [],
        }));
      }
      if (url === '/api/scan/paths?workspaceId=ws-1') {
        return Promise.resolve(
          jsonResponse({
            paths: ['/Users/spark/workspace/project-a'],
            parentDirs: ['/Users/spark/workspace'],
          }),
        );
      }
      if (url === '/api/fs/browse?prefix=%2FUsers%2Fspark%2Fworkspace') {
        return Promise.resolve(
          jsonResponse({
            parent: '/Users/spark/workspace',
            dirs: [{ name: 'project-a', path: '/Users/spark/workspace/project-a' }],
          }),
        );
      }
      if (url === '/api/fs/browse?prefix=%2FUsers%2Fspark%2Fworkspace%2Fproject-a') {
        return Promise.resolve(
          jsonResponse({
            parent: '/Users/spark/workspace/project-a',
            dirs: [],
          }),
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ScanSettings workspaceId="ws-1" />);

    await screen.findByDisplayValue('/Users/spark/workspace');
    fireEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
    await screen.findByText('project-a');

    fireEvent.click(screen.getByRole('button', { name: /project-a/i }));
    fireEvent.click(screen.getByRole('button', { name: '현재 경로 선택' }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('/Users/spark/workspace/project-a')).toBeTruthy();
    });
  });
});
