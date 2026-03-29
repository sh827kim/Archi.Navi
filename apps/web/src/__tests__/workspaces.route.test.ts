// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as any },
}));

const { persistWorkspaceSnapshotMock } = vi.hoisted(() => ({
  persistWorkspaceSnapshotMock: vi.fn(),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: async () => dbHolder.db,
  };
});

vi.mock('@/lib/workspace-snapshot', () => ({
  persistWorkspaceSnapshot: persistWorkspaceSnapshotMock,
}));

import { createPgliteClient, workspaces } from '@archi-navi/db';
import { DELETE, PATCH } from '@/app/api/workspaces/[id]/route';
import { dynamic, GET, POST } from '@/app/api/workspaces/route';

const MIGRATIONS_FOLDER = join(process.cwd(), '../../packages/db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000091';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('/api/workspaces routes', () => {
  beforeEach(async () => {
    dbHolder.db = await createTestDb();
    persistWorkspaceSnapshotMock.mockResolvedValue(undefined);
  });

  it('GET 목록 응답은 no-store 캐시 정책과 dynamic route 설정을 사용해야 한다', async () => {
    await dbHolder.db.insert(workspaces).values({
      id: workspaceId,
      name: 'workspace-route-test',
    });

    const response = await GET();

    expect(dynamic).toBe('force-dynamic');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject([
      expect.objectContaining({ id: workspaceId, name: 'workspace-route-test' }),
    ]);
  });

  it('POST는 20자를 초과하는 이름을 거부해야 한다', async () => {
    const response = await POST(
      new Request('http://localhost/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a'.repeat(21) }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'name must be at most 20 characters',
    });
  });

  it('PATCH는 20자를 초과하는 이름을 거부해야 한다', async () => {
    const response = await PATCH(
      new Request(`http://localhost/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'b'.repeat(21) }),
      }) as never,
      { params: Promise.resolve({ id: workspaceId }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'name must be at most 20 characters',
    });
  });

  it('POST/PATCH/DELETE 이후 workspace snapshot을 갱신해야 한다', async () => {
    const createResponse = await POST(
      new Request('http://localhost/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'snapshot-test' }),
      }) as never,
    );

    expect(createResponse.status).toBe(201);
    expect(persistWorkspaceSnapshotMock).toHaveBeenCalledTimes(1);

    await dbHolder.db.insert(workspaces).values({
      id: workspaceId,
      name: 'workspace-update-test',
    });

    const patchResponse = await PATCH(
      new Request(`http://localhost/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ws-update-next' }),
      }) as never,
      { params: Promise.resolve({ id: workspaceId }) },
    );
    expect(patchResponse.status).toBe(200);

    const deleteResponse = await DELETE(
      new Request(`http://localhost/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      }) as never,
      { params: Promise.resolve({ id: workspaceId }) },
    );
    expect(deleteResponse.status).toBe(200);

    expect(persistWorkspaceSnapshotMock).toHaveBeenCalledTimes(3);
  });

  it('DELETE는 실제로 워크스페이스를 삭제해야 한다', async () => {
    await dbHolder.db.insert(workspaces).values({
      id: workspaceId,
      name: 'workspace-delete-test',
    });

    const response = await DELETE(
      new Request(`http://localhost/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      }) as never,
      { params: Promise.resolve({ id: workspaceId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const rows = await dbHolder.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it('DELETE는 없는 워크스페이스에 대해 404를 반환해야 한다', async () => {
    const response = await DELETE(
      new Request(`http://localhost/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
      }) as never,
      { params: Promise.resolve({ id: workspaceId }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'workspace not found' });
  });
});
