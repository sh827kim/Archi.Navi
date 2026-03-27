// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

import { createPgliteClient, objects, workspaces } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { registerProjects } from '@/app/api/scan/route';

const MIGRATIONS_FOLDER = join(process.cwd(), '../../packages/db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000081';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('registerProjects', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    getDbMock.mockResolvedValue(db);
    await db.insert(workspaces).values({ id: workspaceId, name: 'scan-route-test' });
  });

  it('기존 서비스가 있으면 scanPath metadata를 최신 값으로 갱신해야 한다', async () => {
    const serviceId = generateId();
    await db.insert(objects).values({
      id: serviceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'orders',
      displayName: null,
      path: `/objects/${serviceId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { owner: 'seeded' },
    });

    const result = await registerProjects(
      workspaceId,
      [{
        name: 'orders',
        path: '/tmp/orders-service',
        language: 'java',
        markerFile: 'pom.xml',
      }],
      false,
    );

    expect(result).toEqual({ registered: 0, skipped: 1 });

    const [service] = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(eq(objects.id, serviceId));
    expect(service?.metadata).toEqual({
      owner: 'seeded',
      scanPath: '/tmp/orders-service',
      language: 'java',
      markerFile: 'pom.xml',
    });
  });
});
