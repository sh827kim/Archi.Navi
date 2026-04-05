import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
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

import { createTestDb as createEmbeddedTestDb, objects, workspaces } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { registerProjects } from '@/commands/scan';

const workspaceId = '00000000-0000-0000-0000-000000000081';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

describe('registerProjects (cli)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    getDbMock.mockResolvedValue(db);
    await db.insert(workspaces).values({ id: workspaceId, name: 'scan-cli-test' });
  }, 30_000);

  it('동일 이름의 비서비스 Object는 건드리지 않고 서비스 Object를 신규 생성해야 한다', async () => {
    const topicId = generateId();
    await db.insert(objects).values({
      id: topicId,
      workspaceId,
      objectType: 'topic',
      category: 'BUSINESS',
      granularity: 'ATOMIC',
      name: 'orders',
      displayName: null,
      path: `/objects/${topicId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { owner: 'topic-team' },
    });

    const result = await registerProjects(
      workspaceId,
      [{ name: 'orders', path: '/tmp/orders-service', language: 'java', markerFile: 'pom.xml' }],
      false,
    );

    expect(result).toEqual({ registered: 1, skipped: 0 });

    const sameNamedObjects = await db
      .select({ id: objects.id, objectType: objects.objectType, metadata: objects.metadata })
      .from(objects)
      .where(eq(objects.name, 'orders'));

    expect(sameNamedObjects).toHaveLength(2);
    expect(sameNamedObjects.find((obj) => obj.id === topicId)?.metadata).toEqual({
      owner: 'topic-team',
    });

    const createdService = sameNamedObjects.find((obj) => obj.objectType === 'service');
    expect(createdService?.metadata).toEqual({
      scanPath: '/tmp/orders-service',
      language: 'java',
      markerFile: 'pom.xml',
    });
  });
});
