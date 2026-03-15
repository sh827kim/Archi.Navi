import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import {
  createPgliteClient,
  objectRelations,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { bindConfigToCodeEndpoints } from '@/relation/configCodeBinding';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000041';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('bindConfigToCodeEndpoints', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'binding-test' });
  });

  it('이미 확정된 endpoint relation이 있으면 크로스 바인딩 후보를 생성하지 않아야 한다', async () => {
    const sourceServiceId = generateId();
    const targetServiceId = generateId();
    const endpointId = generateId();
    const compoundCandidateId = generateId();

    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${sourceServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: targetServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'orders',
        path: `/orders/${targetServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: targetServiceId,
        path: `/orders/${targetServiceId}/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    await db.insert(relationCandidates).values({
      id: compoundCandidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: targetServiceId,
      confidence: 0.8,
      metadata: {},
      status: 'PENDING',
    });

    await db.insert(objectRelations).values({
      id: generateId(),
      workspaceId,
      relationType: 'call',
      subjectObjectId: sourceServiceId,
      objectId: endpointId,
      confidence: 1,
      status: 'APPROVED',
      source: 'MANUAL',
      metadata: {},
    });

    const result = await bindConfigToCodeEndpoints(db, { workspaceId });

    expect(result.compoundCandidateCount).toBe(1);
    expect(result.createdEndpointCandidateCount).toBe(0);

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, sourceServiceId),
          eq(relationCandidates.objectId, endpointId),
        ),
      );

    expect(endpointCandidates).toHaveLength(0);
  });
});
