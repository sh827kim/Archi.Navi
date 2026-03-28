import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
}));

import { EngineSettings } from '@/components/settings/settings-client';

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

  it('feedback 설정 저장과 reset-all UI를 노출하고 상호작용해야 한다', async () => {
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
        feedbackConfig: {
          enabled: true,
          minSamples: 12,
          maxAdjustment: 0.18,
        },
        feedbackSummary: {
          totalKeys: 1,
          eligibleKeys: 1,
          approvedCount: 9,
          rejectedCount: 1,
          totalSamples: 10,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'profile-1',
        feedbackConfig: {
          enabled: true,
          minSamples: 15,
          maxAdjustment: 0.2,
        },
        feedbackSummary: {
          totalKeys: 1,
          eligibleKeys: 0,
          approvedCount: 9,
          rejectedCount: 1,
          totalSamples: 10,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'profile-1',
        feedbackConfig: {
          enabled: true,
          minSamples: 10,
          maxAdjustment: 0.15,
        },
        feedbackSummary: {
          totalKeys: 0,
          eligibleKeys: 0,
          approvedCount: 0,
          rejectedCount: 0,
          totalSamples: 0,
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<EngineSettings workspaceId="ws-1" />);

    await screen.findByDisplayValue('12');
    expect(screen.getByText('key별 상세 통계는 노출하지 않고, 현재 기본 프로필의 누적 요약만 표시합니다.')).toBeTruthy();
    expect(screen.queryByText('call:code:*:*')).toBeNull();

    fireEvent.change(screen.getByLabelText('최소 샘플 수'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('최대 보정치'), { target: { value: '0.2' } });
    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall?.[0]).toBe('/api/inference/profiles/default');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      workspaceId: 'ws-1',
      feedbackConfig: {
        enabled: true,
        minSamples: 15,
        maxAdjustment: 0.2,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    const resetCall = fetchMock.mock.calls[2];
    expect(JSON.parse(String(resetCall?.[1]?.body))).toMatchObject({
      workspaceId: 'ws-1',
      resetAll: true,
    });
    await waitFor(() => {
      expect(screen.getByText('아직 누적된 feedback 집계가 없습니다.')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('10')).toBeTruthy();
    expect(screen.getByDisplayValue('0.15')).toBeTruthy();
  });
});
