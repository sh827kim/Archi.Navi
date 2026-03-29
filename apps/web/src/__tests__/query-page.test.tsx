// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import QueryPage from '@/app/(dashboard)/query/page';

vi.mock('@/components/query/query-client', () => ({
  QueryClient: () => <div data-testid="query-client">query-client-mock</div>,
}));

describe('QueryPage', () => {
  it('/query 페이지에서 QueryClient를 렌더링해야 한다', () => {
    render(<QueryPage />);
    expect(screen.getByTestId('query-client')).toBeTruthy();
  });
});

