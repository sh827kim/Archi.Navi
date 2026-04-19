// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DomainSemanticClient } from '@/components/domains/domain-semantic-client';

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('@/lib/client-ai-settings', () => ({
  getClientAiRequestHeaders: () => ({}),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('lucide-react', () => ({
  Download: () => null,
  Loader2: () => null,
  Sparkles: () => null,
  RefreshCw: () => null,
  ArrowLeft: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe('DomainSemanticClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ success: false, error: { code: 'NOT_FOUND', message: '없음' } }),
        } as Response),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('목록으로 링크는 /domains 를 가리켜야 한다', async () => {
    render(<DomainSemanticClient domainId="dom-1" />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });

    expect(screen.getByRole('link', { name: '목록으로' }).getAttribute('href')).toBe('/domains');
  });
});
