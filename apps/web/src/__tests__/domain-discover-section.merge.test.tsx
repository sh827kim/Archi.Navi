// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DomainDiscoverSection } from '@/components/domains/domain-discover-section';

vi.mock('@/lib/client-ai-settings', () => ({
  getClientAiRequestHeaders: () => ({}),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('lucide-react', () => ({
  CheckCircle2: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  GitMerge: () => null,
  Loader2: () => null,
  Search: () => null,
  XCircle: () => null,
}));

vi.mock('@archi-navi/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

function member(objectId: string) {
  return {
    objectId,
    pathPrefixMatch: 0,
    routePrefixMatch: 1,
    topicPrefixMatch: 0,
    nameTokenJaccard: 0,
    codeFamilyMatch: 0,
    tableFamilyMatch: 0,
    seedSources: [`route:/${objectId}`],
    affinity: 0.6,
    relationCohesion: 0.2,
    objectName: objectId,
    objectType: 'function',
  };
}

function candidate(id: string, autoName: string, objectId: string) {
  return {
    id,
    autoName,
    signals: {
      topPathPrefix: null,
      topRoutePrefix: `/${id}`,
      topTopicPrefix: null,
      topCodeFamily: null,
      topTableFamily: null,
      seedSourceSummary: [{ source: 'route', value: `/${id}` }],
    },
    members: [member(objectId)],
    review: null,
    implementingServices: [],
  };
}

describe('DomainDiscoverSection candidate merge UX', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('선택한 후보 2개를 merge API 로 병합하고 미리보기 목록을 교체한다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [
          { id: 'svc-cart', name: 'cart-service', displayName: 'Cart Service', path: '/cart' },
        ],
      })
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            llmReviewed: false,
            candidates: [
              candidate('cart', '장바구니', 'fn-cart'),
              candidate('cart-query', '장바구니조회', 'fn-cart-query'),
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            candidate: {
              ...candidate('merged-cart-cart-query', '장바구니', 'fn-cart'),
              members: [member('fn-cart'), member('fn-cart-query')],
              origin: 'manual_merge',
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<DomainDiscoverSection workspaceId="ws-1" onApproved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Cart Service 서비스 선택')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '도메인 발견' }));

    await waitFor(() => {
      expect(screen.getByLabelText('장바구니 후보 선택')).toBeTruthy();
      expect(screen.getByLabelText('장바구니조회 후보 선택')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('장바구니 후보 선택'));
    fireEvent.click(screen.getByLabelText('장바구니조회 후보 선택'));
    fireEvent.click(screen.getByRole('button', { name: /선택 병합/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const mergeRequest = JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body);
    expect(mergeRequest).toMatchObject({
      workspaceId: 'ws-1',
      name: '장바구니',
    });
    expect(mergeRequest.candidates.map((c: { id: string }) => c.id)).toEqual([
      'cart',
      'cart-query',
    ]);

    await waitFor(() => {
      expect(screen.getByText('수동 병합 후보')).toBeTruthy();
      expect(screen.getByText('멤버 2')).toBeTruthy();
    });
    expect(screen.queryByLabelText('장바구니조회 후보 선택')).toBeNull();
  });

  it('선택한 물리 service id 를 discover 요청에 포함한다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [
          { id: 'svc-cart', name: 'cart-service', displayName: 'Cart Service', path: '/cart' },
          { id: 'svc-order', name: 'order-service', displayName: 'Order Service', path: '/order' },
        ],
      })
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: { llmReviewed: false, candidates: [] },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<DomainDiscoverSection workspaceId="ws-1" onApproved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Cart Service 서비스 선택')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('Cart Service 서비스 선택'));
    fireEvent.click(screen.getByRole('button', { name: '도메인 발견' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const discoverRequest = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(discoverRequest).toEqual({
      workspaceId: 'ws-1',
      selectedServiceIds: ['svc-cart'],
    });
  });
});
