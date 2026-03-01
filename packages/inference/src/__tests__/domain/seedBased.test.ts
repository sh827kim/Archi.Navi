import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import {
  workspaces,
  objects,
  domainCandidates,
  domainInferenceProfiles,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { runSeedBasedInference } from '../../domain/seedBased';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000031';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function setupWorkspace(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'seed-based-test' });
}

async function createObject(
  db: TestDb,
  objectType: 'domain' | 'service',
  name: string,
): Promise<string> {
  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType,
    ...(objectType === 'service' ? { category: 'COMPUTE' } : {}),
    granularity: 'COMPOUND',
    name,
    path: `/${id}`,
    depth: 0,
    metadata: {},
  });
  return id;
}

describe('runSeedBasedInference', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await setupWorkspace(db);
  });

  it('도메인이 없으면 candidateCount=0을 반환해야 한다', async () => {
    await createObject(db, 'service', 'order-service');

    const result = await runSeedBasedInference(db, { workspaceId });
    expect(result.candidateCount).toBe(0);

    const rows = await db.select().from(domainCandidates);
    expect(rows).toHaveLength(0);
  });

  it('신호가 전혀 없으면 후보를 생성하지 않아야 한다', async () => {
    await createObject(db, 'domain', 'order');
    await createObject(db, 'service', 'billing-service');

    const result = await runSeedBasedInference(db, { workspaceId });
    expect(result.candidateCount).toBe(0);

    const rows = await db.select().from(domainCandidates);
    expect(rows).toHaveLength(0);
  });

  it('프로필 가중치가 적용되어 코드 신호 기반 후보를 생성해야 한다', async () => {
    const orderDomainId = await createObject(db, 'domain', 'order');
    await createObject(db, 'domain', 'payment');
    const serviceId = await createObject(db, 'service', 'order-api');

    const profileId = generateId();
    await db.insert(domainInferenceProfiles).values({
      id: profileId,
      workspaceId,
      name: 'seed-code-only',
      wCode: 1.0,
      wDb: 0,
      wMsg: 0,
      secondaryThreshold: 0.2,
    });

    const result = await runSeedBasedInference(db, { workspaceId, profileId });
    expect(result.candidateCount).toBe(1);

    const [candidate] = await db
      .select()
      .from(domainCandidates)
      .where(eq(domainCandidates.objectId, serviceId));
    expect(candidate).toBeDefined();
    expect(candidate?.primaryDomainId).toBe(orderDomainId);
    expect(candidate?.status).toBe('PENDING');

    const signals = (candidate?.signals ?? {}) as Record<string, unknown>;
    const code = (signals['code'] ?? {}) as Record<string, number>;
    expect(code[orderDomainId]).toBeGreaterThan(0);
  });

  it('존재하지 않는 profileId가 주어져도 기본값으로 처리해야 한다', async () => {
    await createObject(db, 'domain', 'order');
    await createObject(db, 'service', 'order-worker');

    const result = await runSeedBasedInference(db, {
      workspaceId,
      profileId: '00000000-0000-0000-0000-000000000099',
    });
    expect(result.candidateCount).toBe(1);
  });
});
