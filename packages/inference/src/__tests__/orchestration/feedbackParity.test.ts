import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import {
  createTestDb as createEmbeddedTestDb,
  domainInferenceProfiles,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { inferRelationsFromConfig } from '@/relation/configBased';
import { createInferenceRun, executeInferenceRun } from '@/orchestration/inferenceRuns';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function seedWorkspace(db: TestDb, repoRoot: string) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'feedback-parity-test' });
  const gatewayId = generateId();
  const ordersId = generateId();
  await db.insert(objects).values([
    {
      id: gatewayId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'gateway',
      path: '/gateway',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { scanPath: repoRoot },
    },
    {
      id: ordersId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'orders',
      path: '/orders',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { scanPath: repoRoot },
    },
  ]);

  await db.insert(domainInferenceProfiles).values({
    workspaceId,
    name: 'default',
    kind: 'NAMED',
    isDefault: true,
    feedbackConfig: {
      enabled: true,
      minSamples: 10,
      maxAdjustment: 0.15,
    },
    feedbackAdjustments: {
      'CALL:config:route_binding': {
        approved: 9,
        rejected: 1,
        total: 10,
        approvalRate: 0.9,
        adjustment: 0.06,
      },
    },
  });
}

async function selectCallCandidate(db: TestDb) {
  const [candidate] = await db
    .select()
    .from(relationCandidates)
    .where(eq(relationCandidates.workspaceId, workspaceId));
  return candidate;
}

describe('feedback adjustment parity', () => {
  let quickDb: TestDb;
  let queuedDb: TestDb;
  let repoRoot: string;

  beforeEach(async () => {
    quickDb = await createTestDb();
    queuedDb = await createTestDb();
    repoRoot = join(tmpdir(), `archi-navi-feedback-parity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(
      join(repoRoot, 'application.yml'),
      `
spring:
  application:
    name: gateway
zuul:
  routes:
    orders:
      serviceId: orders
`,
    );

    await seedWorkspace(quickDb, repoRoot);
    await seedWorkspace(queuedDb, repoRoot);
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('quick run 경로와 queued run 경로가 같은 feedback 보정 규칙을 적용해야 한다', async () => {
    await inferRelationsFromConfig(quickDb, {
      workspaceId,
      repoRoot,
      incremental: false,
    });

    const run = await createInferenceRun(queuedDb, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: repoRoot }],
    });
    await executeInferenceRun(queuedDb, { workspaceId, runId: run.id });

    const quickCandidate = await selectCallCandidate(quickDb);
    const queuedCandidate = await selectCallCandidate(queuedDb);

    expect(quickCandidate?.confidence).toBe(0.76);
    expect(queuedCandidate?.confidence).toBe(0.76);
    expect(quickCandidate?.metadata).toMatchObject({
      source: 'application_yml',
      feedback: {
        key: 'CALL:config:route_binding',
        baseConfidence: 0.7,
        adjustment: 0.06,
        adjustedConfidence: 0.76,
      },
    });
    expect(queuedCandidate?.metadata).toEqual(quickCandidate?.metadata);
  });
});
