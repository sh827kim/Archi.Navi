import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import {
  createPgliteClient,
  evidences,
  objectRelations,
  objects,
  relationCandidates,
  relationEvidences,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { executeSmartPipeline } from '@/orchestration/smartPipeline';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000042';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

function createService(scanPath: string, name: string) {
  return {
    id: generateId(),
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name,
    path: `/${name}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: { scanPath },
  } as const;
}

describe('smartPipeline duplicate guards', () => {
  let db: TestDb;
  let rootDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    rootDir = join(tmpdir(), `archi-navi-smart-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(rootDir, { recursive: true });
    await db.insert(workspaces).values({ id: workspaceId, name: 'smart-pipeline-test' });
  });

  afterEach(() => {
    try {
      rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('이미 확정된 service relation이 있으면 LLM compound 후보를 다시 만들지 않아야 한다', async () => {
    const consumerDir = join(rootDir, 'gateway');
    const providerDir = join(rootDir, 'orders');
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(consumerDir, 'application.yml'), 'spring.application.name=gateway');

    const gateway = createService(consumerDir, 'gateway');
    const orders = createService(providerDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const existingRelationId = generateId();
    await db.insert(objectRelations).values({
      id: existingRelationId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: gateway.id,
      objectId: orders.id,
      confidence: 1,
      status: 'APPROVED',
      source: 'MANUAL',
      metadata: {},
    });

    await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.91,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
    });

    const compoundCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, gateway.id),
          eq(relationCandidates.objectId, orders.id),
          eq(relationCandidates.relationType, 'call'),
        ),
      );
    expect(compoundCandidates).toHaveLength(0);

    const linkedEvidenceRows = await db
      .select()
      .from(relationEvidences)
      .where(
        and(
          eq(relationEvidences.workspaceId, workspaceId),
          eq(relationEvidences.relationId, existingRelationId),
        ),
      );
    expect(linkedEvidenceRows).toHaveLength(1);
  });

  it('이미 확정된 endpoint relation이 있으면 LLM endpoint 후보를 다시 만들지 않아야 한다', async () => {
    const consumerDir = join(rootDir, 'gateway');
    const providerDir = join(rootDir, 'orders');
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(consumerDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(join(consumerDir, 'client.ts'), 'const x = fetch("/api/orders");');

    const gateway = createService(consumerDir, 'gateway');
    const orders = createService(providerDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    await db.insert(objectRelations).values([
      {
        id: generateId(),
        workspaceId,
        relationType: 'call',
        subjectObjectId: gateway.id,
        objectId: orders.id,
        confidence: 1,
        status: 'APPROVED',
        source: 'MANUAL',
        metadata: {},
      },
      {
        id: generateId(),
        workspaceId,
        relationType: 'call',
        subjectObjectId: gateway.id,
        objectId: endpointId,
        confidence: 1,
        status: 'APPROVED',
        source: 'MANUAL',
        metadata: {},
      },
    ]);

    await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway depends on orders',
            confidence: 0.87,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("/api/orders")',
            confidence: 0.92,
          },
        ],
      }),
    });

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, gateway.id),
          eq(relationCandidates.objectId, endpointId),
          eq(relationCandidates.relationType, 'call'),
        ),
      );
    expect(endpointCandidates).toHaveLength(0);

    const codeEvidenceRows = await db
      .select()
      .from(evidences)
      .where(eq(evidences.workspaceId, workspaceId));
    expect(codeEvidenceRows.length).toBeGreaterThan(0);
  });
});
