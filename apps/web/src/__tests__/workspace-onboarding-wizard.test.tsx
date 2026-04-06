import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { pushMock, refreshWorkspacesMock, setWorkspaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshWorkspacesMock: vi.fn(),
  setWorkspaceMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({
    setWorkspace: setWorkspaceMock,
    refreshWorkspaces: refreshWorkspacesMock,
  }),
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    ArrowLeft: Icon,
    ArrowRight: Icon,
    Plus: Icon,
    Trash2: Icon,
    FolderOpen: Icon,
    ArrowUp: Icon,
    Loader2: Icon,
    RefreshCw: Icon,
  };
});

vi.mock('@archi-navi/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
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
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

import { WorkspaceOnboardingWizard } from '@/components/workspace/workspace-onboarding-wizard';

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

describe('WorkspaceOnboardingWizard', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('로컬 스캔 모드에서만 폴더 선택 버튼을 노출해야 한다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/workspaces' && method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'ws-1', name: '테스트 워크스페이스' }));
      }
      if (url === '/api/inference/profiles/default' && method === 'PUT') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/layers?workspaceId=ws-1') {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === '/api/layers' && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/tags?workspaceId=ws-1') {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === '/api/tags' && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspaceOnboardingWizard />);

    fireEvent.change(screen.getByPlaceholderText('예: 쇼핑몰 플랫폼'), {
      target: { value: '테스트 워크스페이스' },
    });

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('관계 추론 기본 가중치를 저장합니다.');

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('아키텍처 레이어를 초기 등록합니다.');

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('태그를 미리 등록합니다.');

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('코드 스캔을 실행하거나 건너뛸 수 있습니다.');

    expect(screen.getByRole('button', { name: '폴더 선택' })).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'github-repo' },
    });

    expect(screen.queryByRole('button', { name: '폴더 선택' })).toBeNull();
  });

  it('코드 스캔 실행 시 DB 스캔 옵션을 요청 본문에 포함해야 한다', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: 'complete',
              result: {
                registered: 1,
                skipped: 0,
                projects: [{ name: 'demo' }],
              },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/workspaces' && method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'ws-1', name: '테스트 워크스페이스' }));
      }
      if (url === '/api/inference/profiles/default' && method === 'PUT') {
        return Promise.resolve(jsonResponse({ id: 'profile-1' }));
      }
      if (url === '/api/layers?workspaceId=ws-1') {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === '/api/layers' && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/tags?workspaceId=ws-1') {
        return Promise.resolve(jsonResponse([]));
      }
      if (url === '/api/tags' && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/scan' && method === 'POST') {
        return Promise.resolve({
          ok: true,
          body: stream,
        } as Response);
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspaceOnboardingWizard />);

    fireEvent.change(screen.getByPlaceholderText('예: 쇼핑몰 플랫폼'), {
      target: { value: '테스트 워크스페이스' },
    });

    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('관계 추론 기본 가중치를 저장합니다.');
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('아키텍처 레이어를 초기 등록합니다.');
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('태그를 미리 등록합니다.');
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await screen.findByText('코드 스캔을 실행하거나 건너뛸 수 있습니다.');

    fireEvent.change(screen.getByPlaceholderText('/path/to/workspace'), {
      target: { value: '/tmp/workspace' },
    });
    fireEvent.click(screen.getAllByLabelText('switch')[1]!);
    fireEvent.click(screen.getByRole('button', { name: '스캔 후 완료' }));

    await screen.findByText('코드 스캔을 실행하거나 건너뛸 수 있습니다.');

    const scanCall = fetchMock.mock.calls.find(
      (call) => call[0] === '/api/scan' && (call[1]?.method ?? 'GET') === 'POST',
    );
    expect(scanCall).toBeDefined();
    expect(JSON.parse(String(scanCall?.[1]?.body))).toMatchObject({
      workspaceId: 'ws-1',
      target: '/tmp/workspace',
      enableDbScan: true,
    });
  });
});
