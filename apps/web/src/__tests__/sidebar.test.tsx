// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/layout/sidebar';
import { useSidebarStore } from '@/stores/sidebar';

const { setThemeMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: 'dark',
    resolvedTheme: 'dark',
    setTheme: setThemeMock,
  }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@archi-navi/ui', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));

vi.mock('@/components/workspace/workspace-switcher', () => ({
  WorkspaceSwitcher: ({ collapsed }: { collapsed?: boolean }) => (
    <div data-testid="workspace-switcher">{collapsed ? 'collapsed' : 'expanded'}</div>
  ),
}));

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
  };
}

describe('Sidebar', () => {
  beforeEach(() => {
    const localStorageMock = createLocalStorageMock();
    vi.stubGlobal('localStorage', localStorageMock);
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });
    useSidebarStore.setState({ collapsed: false });
    setThemeMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('홈 네비게이션을 표시하고 collapse 상태를 전환해야 한다', () => {
    render(<Sidebar />);

    expect(screen.getByRole('link', { name: '홈' }).getAttribute('href')).toBe('/home');
    expect(screen.getByText('홈')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '사이드바 접기' }));

    expect(useSidebarStore.getState().collapsed).toBe(true);
    expect(screen.queryByText('아키텍처 뷰')).toBeNull();
    expect(screen.getByTestId('workspace-switcher').textContent).toBe('collapsed');
  });

  it('테마 토글 버튼이 setTheme를 호출해야 한다', () => {
    render(<Sidebar />);

    fireEvent.click(screen.getByRole('button', { name: '라이트 모드로 전환' }));
    expect(setThemeMock).toHaveBeenCalledWith('light');
  });
});
