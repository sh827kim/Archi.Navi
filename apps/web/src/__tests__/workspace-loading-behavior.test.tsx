// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const {
  useWorkspaceMock,
  replaceMock,
  pushMock,
} = vi.hoisted(() => ({
  useWorkspaceMock: vi.fn(),
  replaceMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: useWorkspaceMock,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
    push: pushMock,
  }),
}));

vi.mock('lucide-react', () => ({
  Plus: () => null,
  FolderOpen: () => null,
  ChevronRight: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Card: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

import { WorkspacesPageClient } from '@/components/workspace/workspaces-page-client';
import { WorkspaceSelectionGuard } from '@/components/workspace/workspace-selection-guard';

describe('workspace loading behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('워크스페이스 페이지는 초기 로딩 중 blank 대신 skeleton 을 렌더한다', () => {
    useWorkspaceMock.mockReturnValue({
      workspaces: [],
      workspaceId: null,
      setWorkspace: vi.fn(),
      refreshWorkspaces: vi.fn(() => new Promise(() => {})),
    });

    render(<WorkspacesPageClient />);

    expect(screen.getByTestId('workspace-loading-skeleton')).toBeTruthy();
  });

  it('selection guard 는 초기 로딩 중 blank 대신 skeleton 을 렌더한다', () => {
    useWorkspaceMock.mockReturnValue({
      workspaces: [],
      workspaceId: null,
      refreshWorkspaces: vi.fn(() => new Promise(() => {})),
    });

    render(
      <WorkspaceSelectionGuard>
        <div>dashboard</div>
      </WorkspaceSelectionGuard>,
    );

    expect(screen.getByTestId('workspace-loading-skeleton')).toBeTruthy();
  });
});
