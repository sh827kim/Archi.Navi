// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DashboardHomeClient } from '@/components/dashboard/dashboard-home-client';

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceName: 'Alpha Workspace' }),
}));

vi.mock('@archi-navi/ui', () => ({
  Button: ({
    asChild,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean; children: React.ReactNode }) =>
    asChild ? <>{children}</> : <button type="button" {...props}>{children}</button>,
  Spinner: () => <div>loading...</div>,
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));

describe('DashboardHomeClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            counts: {
              objects: 18,
              services: 6,
              domains: 3,
              pendingRelations: 4,
            },
            recentRuns: [
              {
                id: 'run-1',
                status: 'SUCCEEDED',
                triggerType: 'MANUAL',
                requestedModes: ['config', 'code'],
                createdAt: '2026-03-29T10:00:00.000Z',
                finishedAt: '2026-03-29T10:10:00.000Z',
                errorMessage: null,
                sourceSummary: { local: 2 },
              },
            ],
          }),
        } as Response),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('운영 요약과 빠른 액션을 렌더링해야 한다', async () => {
    render(<DashboardHomeClient />);

    await screen.findByText('Alpha Workspace 운영 요약');
    expect(screen.getByTestId('dashboard-hero-surface').className).toContain('rgba(45,212,191,0.14)');
    expect(screen.getByTestId('dashboard-hero-surface').className).toContain('rgba(217,119,87,0.14)');
    expect(screen.getByText('총 Object')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('서비스')).toBeTruthy();
    expect(screen.getByText('도메인')).toBeTruthy();
    expect(screen.getByText('최근 추론 실행')).toBeTruthy();
    expect(screen.getByText('SUCCEEDED')).toBeTruthy();
    expect(screen.getByRole('link', { name: '승인 대기 확인' }).getAttribute('href')).toBe('/approval');
    expect(screen.getByRole('link', { name: /추론 실행/ }).getAttribute('href')).toBe('/approval');
    expect(screen.getByRole('link', { name: /코드 스캔/ }).getAttribute('href')).toBe('/settings');
    expect(screen.getByRole('link', { name: /쿼리 엔진/ }).getAttribute('href')).toBe('/query');
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('요약 조회가 실패하면 fallback 안내를 보여야 한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          json: async () => ({ error: 'boom' }),
        } as Response),
      ),
    );

    render(<DashboardHomeClient />);

    await waitFor(() => {
      expect(screen.getByText('운영 요약을 불러오지 못했습니다')).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: 'Object 목록으로 이동' }).getAttribute('href')).toBe('/services');
  });
});
