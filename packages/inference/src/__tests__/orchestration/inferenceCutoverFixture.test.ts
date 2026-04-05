import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDb as createEmbeddedTestDb, objects, workspaces } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  buildIntentProofCutoverReport,
  createInferenceRun,
  executeInferenceRun,
  type IntentProofCutoverTruthCorpus,
} from '@/index';

const workspaceId = '00000000-0000-0000-0000-000000000651';
const fixtureDir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(fixtureDir, '..', 'fixtures', 'intent-proof-cutover-representative');
const TRUTH_FIXTURE_PATH = join(
  fixtureDir,
  '..',
  'fixtures',
  'intent-proof-cutover-representative.truth.v1.json',
);
const isolatedTestDbDataDir = mkdtempSync(join(tmpdir(), 'archi-navi-cutover-db-'));
const isolatedTestDbPort = 56000 + (process.pid % 1000);
const previousTestDbDataDir = process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'];
const previousTestDbPort = process.env['ARCHI_NAVI_TEST_DB_PORT'];

async function createTestDb() {
  return await createEmbeddedTestDb();
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

function readTruthFixture(): IntentProofCutoverTruthCorpus {
  return JSON.parse(
    readFileSync(TRUTH_FIXTURE_PATH, 'utf-8'),
  ) as IntentProofCutoverTruthCorpus;
}

async function seedRepresentativeWorkspace(db: TestDb, repoRoot: string) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'cutover-fixture' });

  const gatewayDir = join(repoRoot, 'gateway');
  const ordersDir = join(repoRoot, 'orders');
  const gatewayServiceId = generateId();
  const ordersServiceId = generateId();
  const ordersEndpointId = generateId();
  await db.insert(objects).values([
    {
      id: gatewayServiceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'gateway',
      path: '/gateway',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { scanPath: gatewayDir },
    },
    {
      id: ordersServiceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'orders',
      path: '/orders',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { scanPath: ordersDir },
    },
    {
      id: ordersEndpointId,
      workspaceId,
      objectType: 'api_endpoint',
      category: 'CHANNEL',
      granularity: 'ATOMIC',
      name: 'GET /api/orders',
      parentId: ordersServiceId,
      path: `/${ordersEndpointId}`,
      depth: 1,
      visibility: 'VISIBLE',
      metadata: {
        method: 'GET',
        path: '/api/orders',
      },
    },
  ]);
}

describe('representative cutover fixture', () => {
  let db: TestDb;
  let repoRoot: string | undefined;

  beforeAll(() => {
    process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'] = isolatedTestDbDataDir;
    process.env['ARCHI_NAVI_TEST_DB_PORT'] = `${isolatedTestDbPort}`;
  });

  beforeEach(async () => {
    db = await createTestDb();
    repoRoot = mkdtempSync(join(tmpdir(), 'archi-navi-cutover-fixture-'));
    cpSync(FIXTURE_ROOT, repoRoot, { recursive: true });
    await seedRepresentativeWorkspace(db, repoRoot);
  });

  afterEach(() => {
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = undefined;
    }
  });

  afterAll(() => {
    if (previousTestDbDataDir === undefined) delete process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'];
    else process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'] = previousTestDbDataDir;

    if (previousTestDbPort === undefined) delete process.env['ARCHI_NAVI_TEST_DB_PORT'];
    else process.env['ARCHI_NAVI_TEST_DB_PORT'] = previousTestDbPort;
  });

  it('produces a non-zero baseline/candidate run pair and a meaningful cutover delta', async () => {
    const baselineRun = await createInferenceRun(db, {
      workspaceId,
      modes: ['config', 'db'],
      sources: [{ type: 'local', ref: repoRoot }],
    });
    const baselineDetail = await executeInferenceRun(db, {
      workspaceId,
      runId: baselineRun.id,
    });

    const candidateRun = await createInferenceRun(db, {
      workspaceId,
      modes: ['config', 'code', 'db'],
      sources: [{ type: 'local', ref: repoRoot }],
    });
    const candidateDetail = await executeInferenceRun(db, {
      workspaceId,
      runId: candidateRun.id,
    });

    const baselineArtifact = (
      baselineDetail.run.stats as Record<string, unknown>
    )['cutoverArtifact'] as {
      relations: Array<{ subject: string; relationType: string; object: string }>;
    };
    const candidateArtifact = (
      candidateDetail.run.stats as Record<string, unknown>
    )['cutoverArtifact'] as {
      relations: Array<{ subject: string; relationType: string; object: string }>;
    };

    expect(baselineDetail.run.status).toBe('SUCCEEDED');
    expect(candidateDetail.run.status).toBe('SUCCEEDED');
    expect(baselineArtifact.relations).toEqual([]);
    expect(candidateArtifact.relations).toEqual([
      {
        subject: 'service:/gateway',
        relationType: 'call',
        object: 'api_endpoint:GET /api/orders',
      },
    ]);
    expect(candidateArtifact.relations.length).toBeGreaterThan(
      baselineArtifact.relations.length,
    );

    const report = buildIntentProofCutoverReport({
      baseline: {
        label: `run:${baselineRun.id}`,
        relations: baselineArtifact.relations,
      },
      candidate: {
        label: `run:${candidateRun.id}`,
        relations: candidateArtifact.relations,
      },
      truth: readTruthFixture(),
      metadata: {
        commitSha: 'fixture-commit',
        corpusRef: 'packages/inference/src/__tests__/fixtures/intent-proof-cutover-representative',
        baselineCommand: 'pnpm --filter @archi-navi/inference test:cutover-fixture',
        candidateCommand: 'pnpm --filter @archi-navi/inference test:cutover-fixture',
        baselineArtifactPath: `run:${baselineRun.id}`,
        candidateArtifactPath: `run:${candidateRun.id}`,
      },
    });

    expect(report.metrics.truthRelationCount).toBe(1);
    expect(report.metrics.baselineRelationCount).toBe(0);
    expect(report.metrics.candidateRelationCount).toBe(1);
    expect(report.metrics.baselineRecall).toBeLessThan(report.metrics.candidateRecall);
    expect(report.metrics.precisionDelta).toBe(0);
    expect(report.metrics.recallDelta).toBeGreaterThan(0);
    expect(report.metrics.approvalCountDelta).toBe(1);
    expect(report.recommendation.decision).toBe('NO_GO');
    expect(report.failedChecks[0]).toContain('approvalCountDelta 1 exceeded 0');
  });
});
