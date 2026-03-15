import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  createPgliteClient,
  inferenceRunEvents,
  inferenceRuns,
  inferenceRunSources,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { createInferenceRun, executeInferenceRun } from '@/orchestration/inferenceRuns';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000020';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function createWorkspaceAndService(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'orchestrator-test' });
  const serviceId = generateId();
  await db.insert(objects).values({
    id: serviceId,
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name: 'order-service',
    path: `/${serviceId}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });
}

describe('inference orchestration runs', () => {
  let db: TestDb;
  let tempDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    tempDir = join(tmpdir(), `archi-navi-infrun-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    await createWorkspaceAndService(db);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('local source + config mode 실행 시 run이 SUCCEEDED로 완료되어야 한다', async () => {
    writeFileSync(
      join(tempDir, 'application.yml'),
      `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.run.status).toBe('SUCCEEDED');
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]?.status).toBe('SUCCEEDED');
    expect(detail.events.some((event) => event.eventType === 'RUN_COMPLETED')).toBe(true);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('github source 준비 실패 시 run/source가 FAILED로 기록되어야 한다', async () => {
    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config', 'code'],
      sources: [{ type: 'githubRepo', ref: 'https://github.com/example/repo' }],
    });
    const detail = await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(detail.run.status).toBe('FAILED');
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]?.status).toBe('FAILED');
    expect(detail.events.some((event) => event.eventType === 'SOURCE_RESOLVE_FAILED')).toBe(true);

    const refreshedRunRows = await db
      .select()
      .from(inferenceRuns)
      .where(and(eq(inferenceRuns.workspaceId, workspaceId), eq(inferenceRuns.id, run.id)));
    expect(refreshedRunRows[0]?.status).toBe('FAILED');

    const sourceRows = await db
      .select()
      .from(inferenceRunSources)
      .where(and(eq(inferenceRunSources.workspaceId, workspaceId), eq(inferenceRunSources.runId, run.id)));
    expect(sourceRows[0]?.status).toBe('FAILED');

    const eventRows = await db
      .select()
      .from(inferenceRunEvents)
      .where(and(eq(inferenceRunEvents.workspaceId, workspaceId), eq(inferenceRunEvents.runId, run.id)));
    expect(eventRows.length).toBeGreaterThan(0);
  });
});
