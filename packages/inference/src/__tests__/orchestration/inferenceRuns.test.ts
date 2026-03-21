import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import * as codeSignalEngineModule from '@/code/codeSignalEngine';
import * as configBasedModule from '@/relation/configBased';
import * as configCodeBindingModule from '@/relation/configCodeBinding';
import * as crossValidationModule from '@/relation/crossSignalValidation';
import {
  cancelInferenceRun,
  createInferenceRun,
  executeInferenceRun,
  retryInferenceRun,
} from '@/orchestration/inferenceRuns';

vi.mock('@/relation/configBased', async () => {
  const actual = await vi.importActual<typeof import('@/relation/configBased')>('@/relation/configBased');
  return {
    ...actual,
    inferRelationsFromConfig: vi.fn(actual.inferRelationsFromConfig),
  };
});

vi.mock('@/relation/configCodeBinding', async () => {
  const actual = await vi.importActual<typeof import('@/relation/configCodeBinding')>('@/relation/configCodeBinding');
  return {
    ...actual,
    bindConfigToCodeEndpoints: vi.fn(actual.bindConfigToCodeEndpoints),
  };
});

vi.mock('@/relation/crossSignalValidation', async () => {
  const actual = await vi.importActual<typeof import('@/relation/crossSignalValidation')>('@/relation/crossSignalValidation');
  return {
    ...actual,
    crossValidatePendingRelationCandidates: vi.fn(actual.crossValidatePendingRelationCandidates),
  };
});

vi.mock('@/code/codeSignalEngine', async () => {
  const actual = await vi.importActual<typeof import('@/code/codeSignalEngine')>('@/code/codeSignalEngine');
  return {
    ...actual,
    extractCodeSignalsWithEngine: vi.fn(actual.extractCodeSignalsWithEngine),
  };
});

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

function createRetryRaceDb() {
  const run = {
    id: 'retry-run-1',
    workspaceId,
    status: 'FAILED',
    attemptCount: 0,
    maxAttempts: 2,
  };
  let selectCount = 0;
  let appendedEventCount = 0;

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  selectCount += 1;
                  if (selectCount === 1) return [run];
                  return [{ status: 'RUNNING' }];
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                async returning() {
                  return [];
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        async values() {
          appendedEventCount += 1;
          return [];
        },
      };
    },
  };

  return {
    db: db as unknown as TestDb,
    getAppendedEventCount: () => appendedEventCount,
  };
}

describe('inference orchestration runs', () => {
  let db: TestDb;
  let tempDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    tempDir = join(tmpdir(), `archi-navi-infrun-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    await createWorkspaceAndService(db);
    vi.clearAllMocks();
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
    expect(vi.mocked(crossValidationModule.crossValidatePendingRelationCandidates)).not.toHaveBeenCalled();
  });

  it('code mode 없이 config+db 실행이면 cross validation을 호출하지 않아야 한다', async () => {
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
      modes: ['config', 'db'],
      sources: [{ type: 'local', ref: tempDir }],
    });

    await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(vi.mocked(crossValidationModule.crossValidatePendingRelationCandidates)).not.toHaveBeenCalled();
  });

  it('code mode가 포함된 다중 mode 실행이면 cross validation을 호출해야 한다', async () => {
    writeFileSync(join(tempDir, 'index.ts'), 'export const orderService = true;\n');
    vi.mocked(codeSignalEngineModule.extractCodeSignalsWithEngine).mockResolvedValueOnce({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['code', 'db'],
      sources: [{ type: 'local', ref: tempDir }],
    });

    await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(vi.mocked(crossValidationModule.crossValidatePendingRelationCandidates)).toHaveBeenCalledWith(
      db,
      { workspaceId },
    );
  });

  it('code mode가 포함되어도 code pass가 실패하면 cross validation을 호출하지 않아야 한다', async () => {
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
    vi.mocked(configBasedModule.inferRelationsFromConfig).mockResolvedValueOnce({
      fileCount: 1,
      processedFileCount: 1,
      skippedFileCount: 0,
      candidateCount: 1,
      objectCount: 1,
    });
    vi.mocked(codeSignalEngineModule.extractCodeSignalsWithEngine).mockRejectedValueOnce(
      new Error('parser failed'),
    );

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config', 'code'],
      sources: [{ type: 'local', ref: tempDir }],
    });

    await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(vi.mocked(crossValidationModule.crossValidatePendingRelationCandidates)).not.toHaveBeenCalled();
  });

  it('config+code 실행이면 cross binding을 먼저 수행한 뒤 cross validation을 호출해야 한다', async () => {
    writeFileSync(
      join(tempDir, 'application.yml'),
      `
spring:
  application:
    name: order-service
zuul:
  routes:
    order:
      serviceId: order-service
`,
    );
    writeFileSync(join(tempDir, 'index.ts'), 'export const orderService = true;\n');
    vi.mocked(codeSignalEngineModule.extractCodeSignalsWithEngine).mockResolvedValueOnce({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 1,
      skippedCount: 0,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      warning: null,
      scanFailures: [],
    });

    vi.mocked(configCodeBindingModule.bindConfigToCodeEndpoints).mockResolvedValueOnce({
      compoundCandidateCount: 1,
      createdEndpointCandidateCount: 1,
      skippedNoEndpointCount: 0,
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config', 'code'],
      sources: [{ type: 'local', ref: tempDir }],
    });

    await executeInferenceRun(db, { workspaceId, runId: run.id });

    expect(vi.mocked(configCodeBindingModule.bindConfigToCodeEndpoints)).toHaveBeenCalledWith(
      db,
      { workspaceId },
    );
    expect(vi.mocked(crossValidationModule.crossValidatePendingRelationCandidates)).toHaveBeenCalledWith(
      db,
      { workspaceId },
    );

    const bindingCallOrder = vi.mocked(configCodeBindingModule.bindConfigToCodeEndpoints).mock.invocationCallOrder[0];
    const crossValidationCallOrder =
      vi.mocked(crossValidationModule.crossValidatePendingRelationCandidates).mock.invocationCallOrder[0];

    expect(bindingCallOrder).toBeLessThan(crossValidationCallOrder);
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

  it('RUNNING 중 취소되면 최종 상태를 CANCELED로 유지해야 한다', async () => {
    const inferRelationsFromConfigMock = vi.mocked(configBasedModule.inferRelationsFromConfig);
    let runId = '';
    inferRelationsFromConfigMock.mockImplementationOnce(async () => {
      const cancelResult = await cancelInferenceRun(db, { workspaceId, runId });
      expect(cancelResult).toEqual({ canceled: true, status: 'CANCELED' });
      return {
        fileCount: 1,
        processedFileCount: 1,
        skippedFileCount: 0,
        candidateCount: 0,
        objectCount: 0,
      };
    });

    const run = await createInferenceRun(db, {
      workspaceId,
      modes: ['config'],
      sources: [{ type: 'local', ref: tempDir }],
    });
    runId = run.id;

    const detail = await executeInferenceRun(db, { workspaceId, runId });

    expect(detail.run.status).toBe('CANCELED');
    expect(detail.run.errorMessage).toBe('사용자에 의해 취소됨');
    expect(detail.events.some((event) => event.eventType === 'RUN_CANCELED')).toBe(true);
    expect(detail.events.some((event) => event.eventType === 'RUN_COMPLETED')).toBe(false);
  });

  it('재시도 경쟁 상태에서 상태 전이가 없으면 retried=false를 반환해야 한다', async () => {
    const race = createRetryRaceDb();

    const result = await retryInferenceRun(race.db, {
      workspaceId,
      runId: 'retry-run-1',
    });

    expect(result.retried).toBe(false);
    expect(result.status).toBe('RUNNING');
    expect(result.reason).toContain('상태가 변경');
    expect(race.getAppendedEventCount()).toBe(0);
  });
});
