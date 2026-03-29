// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';

const {
  getDbMock,
  extractCodeSignalsWithEngineMock,
  inferRelationsFromCodeSignalsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  extractCodeSignalsWithEngineMock: vi.fn(),
  inferRelationsFromCodeSignalsMock: vi.fn(),
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: getDbMock,
  };
});

vi.mock('@archi-navi/inference', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/inference')>('@archi-navi/inference');
  return {
    ...actual,
    extractCodeSignalsWithEngine: extractCodeSignalsWithEngineMock,
    inferRelationsFromCodeSignals: inferRelationsFromCodeSignalsMock,
  };
});

import { createPgliteClient, objects, workspaces } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { bootstrapScannedProjects, registerProjects } from '@/app/api/scan/route';

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
  }, 30_000);

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

  it('동일 이름의 비서비스 Object는 건드리지 않고 서비스 Object를 신규 생성해야 한다', async () => {
    const domainId = generateId();
    await db.insert(objects).values({
      id: domainId,
      workspaceId,
      objectType: 'domain',
      category: 'BUSINESS',
      granularity: 'COMPOUND',
      name: 'orders',
      displayName: null,
      path: `/objects/${domainId}`,
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { owner: 'domain-team' },
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
    expect(sameNamedObjects.find((obj) => obj.id === domainId)?.metadata).toEqual({
      owner: 'domain-team',
    });

    const createdService = sameNamedObjects.find((obj) => obj.objectType === 'service');
    expect(createdService?.metadata).toEqual({
      scanPath: '/tmp/orders-service',
      language: 'java',
      markerFile: 'pom.xml',
    });
  });

  it('스캔 후 1차 코드 분석이 atomic bootstrap 요약을 반환해야 한다', async () => {
    extractCodeSignalsWithEngineMock.mockResolvedValue({
      signalCount: 5,
      warning: null,
      scanFailures: [],
    });
    inferRelationsFromCodeSignalsMock.mockResolvedValue({
      candidateCount: 2,
      createdEndpointCount: 3,
      createdTopicCount: 1,
      createdQueueCount: 0,
      createdDatabaseCount: 1,
      createdDbTableCount: 2,
    });

    const summary = await bootstrapScannedProjects(
      workspaceId,
      [
        {
          name: 'orders',
          path: process.cwd(),
          language: 'typescript',
          markerFile: 'package.json',
        },
      ],
      false,
    );

    expect(extractCodeSignalsWithEngineMock).toHaveBeenCalledWith(db, {
      workspaceId,
      repoRoot: process.cwd(),
      codeEngine: 'regex',
    });
    expect(inferRelationsFromCodeSignalsMock).toHaveBeenCalledWith(db, {
      workspaceId,
      repoRoot: process.cwd(),
    });
    expect(summary).toEqual({
      analyzedProjectCount: 1,
      signalCount: 5,
      candidateCount: 2,
      createdEndpointCount: 3,
      createdAtomicCount: 7,
      warnings: [],
    });
  });
});
