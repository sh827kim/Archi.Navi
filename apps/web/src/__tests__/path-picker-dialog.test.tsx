import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    ArrowUp: Icon,
    FolderOpen: Icon,
    Loader2: Icon,
    RefreshCw: Icon,
  };
});

vi.mock('@archi-navi/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { PathPickerDialog } from '@/components/shared/path-picker-dialog';

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as Response;
}

describe('PathPickerDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('하위 폴더로 이동한 뒤 현재 경로를 선택할 수 있어야 한다', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/fs/browse') {
        return Promise.resolve(
          jsonResponse({
            parent: '/Users/spark',
            dirs: [{ name: 'workspace', path: '/Users/spark/workspace' }],
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
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onSelect = vi.fn();
    render(<PathPickerDialog value="" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: '폴더 선택' }));

    await screen.findByText('workspace');
    fireEvent.click(screen.getByRole('button', { name: /workspace/i }));

    await screen.findByDisplayValue('/Users/spark/workspace');
    fireEvent.click(screen.getByRole('button', { name: '현재 경로 선택' }));

    expect(onSelect).toHaveBeenCalledWith('/Users/spark/workspace');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
