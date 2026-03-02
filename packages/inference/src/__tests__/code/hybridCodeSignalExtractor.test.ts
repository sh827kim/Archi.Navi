import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createPgliteClient } from '@archi-navi/db';
import { codeArtifacts, codeCallEdges, evidences, objects, workspaces } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { extractHybridCodeSignals } from '../../code/hybridCodeSignalExtractor';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000002';

async function createFixtures(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });

  const orderServiceId = generateId();
  await db.insert(objects).values({
    id: orderServiceId,
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name: 'order-service',
    path: `/${orderServiceId}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });
}

describe('extractHybridCodeSignals', () => {
  let db: TestDb;
  let tempDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    tempDir = join(tmpdir(), `archi-navi-hybrid-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  it('파일 재처리 시 기존 edge 연결 evidence를 정리하고 최신 evidence만 유지해야 한다', async () => {
    await createFixtures(db);

    const srcDir = join(tempDir, 'order-service', 'src');
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, 'OrderController.java');

    writeFileSync(filePath, `@GetMapping("/api/orders")\npublic class C {}`);
    await extractHybridCodeSignals(db, { workspaceId, repoRoot: tempDir });

    const firstEvidences = await db
      .select()
      .from(evidences)
      .where(eq(evidences.workspaceId, workspaceId));
    const firstEvidenceIds = new Set(firstEvidences.map((row) => row.id));
    expect(firstEvidences.length).toBeGreaterThan(0);

    writeFileSync(filePath, `@GetMapping("/api/orders")\n@PostMapping("/api/orders")\npublic class C {}`);
    await extractHybridCodeSignals(db, { workspaceId, repoRoot: tempDir });

    const refreshedEvidences = await db
      .select()
      .from(evidences)
      .where(eq(evidences.workspaceId, workspaceId));
    const refreshedEdges = await db
      .select()
      .from(codeCallEdges)
      .where(eq(codeCallEdges.workspaceId, workspaceId));
    const refreshedArtifacts = await db
      .select()
      .from(codeArtifacts)
      .where(
        and(eq(codeArtifacts.workspaceId, workspaceId), eq(codeArtifacts.filePath, filePath)),
      );

    expect(refreshedArtifacts).toHaveLength(1);
    expect(refreshedEvidences).toHaveLength(refreshedEdges.length);
    expect(refreshedEvidences.every((row) => firstEvidenceIds.has(row.id))).toBe(false);
    expect(refreshedEdges.every((row) => row.evidenceId !== null)).toBe(true);
  });
});
