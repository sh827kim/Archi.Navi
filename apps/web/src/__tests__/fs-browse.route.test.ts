// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { readdirSyncMock, statSyncMock } = vi.hoisted(() => ({
  readdirSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readdirSync: readdirSyncMock,
    statSync: statSyncMock,
    default: {
      ...actual,
      readdirSync: readdirSyncMock,
      statSync: statSyncMock,
    },
  };
});

import { GET } from '@/app/api/fs/browse/route';

describe('GET /api/fs/browse', () => {
  it('Windows 절대 경로 prefix도 자동완성 대상으로 허용해야 한다', async () => {
    statSyncMock.mockImplementation((input: string) => {
      if (input === 'C:\\repo') {
        return { isDirectory: () => true };
      }
      if (input === 'C:\\repo\\src') {
        return { isDirectory: () => true };
      }
      throw new Error(`unexpected path: ${input}`);
    });
    readdirSyncMock.mockReturnValue(['src']);

    const response = await GET(
      new NextRequest('http://localhost/api/fs/browse?prefix=C:%5Crepo'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      parent: 'C:\\repo',
      dirs: [{ name: 'src', path: 'C:\\repo\\src' }],
    });
  });

  it('POSIX 절대 경로는 win32 path API로 우회하지 않아야 한다', async () => {
    statSyncMock.mockImplementation((input: string) => {
      if (input === '/tmp') {
        return { isDirectory: () => true };
      }
      if (input === '/tmp/src') {
        return { isDirectory: () => true };
      }
      throw new Error(`unexpected path: ${input}`);
    });
    readdirSyncMock.mockReturnValue(['src']);

    const response = await GET(
      new NextRequest('http://localhost/api/fs/browse?prefix=%2Ftmp'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      parent: '/tmp',
      dirs: [{ name: 'src', path: '/tmp/src' }],
    });
    expect(statSyncMock).not.toHaveBeenCalledWith('\\tmp');
  });
});
