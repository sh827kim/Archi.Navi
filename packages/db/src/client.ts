/**
 * DB 클라이언트 팩토리
 * 환경변수에 따라 PGlite(로컬) 또는 PostgreSQL(서버)을 선택
 */
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import * as schema from './schema/index';

/** DB 클라이언트 타입 */
export type DbClient = ReturnType<typeof createPgliteClient>;

let _client: DbClient | null = null;
let _pg: PGlite | null = null;
let _clientPromise: Promise<DbClient> | null = null;
let _shutdownHookInstalled = false;

/**
 * PGlite 로컬 DB 클라이언트 생성
 * @param dataDir - 데이터 저장 경로 (기본: 메모리)
 */
export function createPgliteClient(dataDir?: string) {
  const pg = new PGlite(dataDir ?? 'memory://');
  return drizzlePglite(pg, { schema });
}

async function closePg(): Promise<void> {
  if (!_pg) return;
  try {
    await _pg.close();
  } finally {
    _pg = null;
    _client = null;
    _clientPromise = null;
  }
}

function installShutdownHook(): void {
  if (_shutdownHookInstalled) return;
  _shutdownHookInstalled = true;

  process.once('SIGINT', () => {
    void closePg();
  });
  process.once('SIGTERM', () => {
    void closePg();
  });
  process.once('beforeExit', () => {
    void closePg();
  });
}

function isPgliteAbortedError(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 8) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      break;
    }
    depth += 1;
  }

  const message = messages.join(' | ');
  return message.includes('Aborted()') || message.includes('RuntimeError: Aborted');
}

function resetCorruptedDataDir(dataDir: string): boolean {
  if (dataDir.startsWith('memory://')) return false;
  if (!existsSync(dataDir)) return false;

  try {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function archiveAndResetCorruptedDataDir(dataDir: string): string | null {
  if (dataDir.startsWith('memory://')) return null;
  if (!existsSync(dataDir)) return null;

  const backupDir = `${dataDir}.broken-${Date.now()}`;
  try {
    renameSync(dataDir, backupDir);
    mkdirSync(dataDir, { recursive: true });
    return backupDir;
  } catch {
    if (resetCorruptedDataDir(dataDir)) {
      return null;
    }
    return null;
  }
}

function removeStalePostmasterPid(dataDir: string): boolean {
  if (dataDir.startsWith('memory://')) return false;

  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;

  try {
    rmSync(pidFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function hasStalePostmasterPid(dataDir: string): boolean {
  if (dataDir.startsWith('memory://')) return false;

  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;

  try {
    const firstLine = readFileSync(pidFile, 'utf-8')
      .split(/\r?\n/u)[0]
      ?.trim();
    if (!firstLine) return true;

    const pid = Number(firstLine);
    if (!Number.isInteger(pid) || pid <= 0) {
      return true;
    }

    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return true;
      }
      return false;
    }
  } catch {
    return true;
  }
}

async function createAndVerifyDb(pgliteDataDir: string): Promise<DbClient> {
  _pg = new PGlite(pgliteDataDir);
  _client = drizzlePglite(_pg, { schema });
  await _client.execute('select 1');
  const migrationsFolder = process.env['MIGRATIONS_FOLDER']?.trim();
  if (migrationsFolder) {
    await migrate(_client, { migrationsFolder });
  }
  installShutdownHook();
  return _client;
}

async function initializeDb(pgliteDataDir: string): Promise<DbClient> {
  if (hasStalePostmasterPid(pgliteDataDir) && removeStalePostmasterPid(pgliteDataDir)) {
    console.warn('[archi-navi/db] stale postmaster.pid 감지, pid 파일만 정리');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await createAndVerifyDb(pgliteDataDir);
    } catch (error) {
      lastError = error;
      await closePg();

      if (!isPgliteAbortedError(error) || attempt === 3) {
        throw error;
      }
      const backupDir = archiveAndResetCorruptedDataDir(pgliteDataDir);
      if (backupDir === null && !existsSync(pgliteDataDir)) {
        throw error;
      }

      console.warn(
        backupDir
          ? `[archi-navi/db] PGlite 데이터 손상 감지, ${backupDir} 로 백업 후 재시도 (${attempt}/2)`
          : `[archi-navi/db] PGlite 데이터 손상 감지, 데이터 디렉터리 재생성 후 재시도 (${attempt}/2)`,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 싱글턴 DB 클라이언트 반환
 * - PGLITE_DATA_DIR 환경변수로 데이터 경로 설정
 * - 데이터 디렉토리 없으면 자동 생성
 */
export async function getDb(): Promise<DbClient> {
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;

  const pgliteDataDir = process.env['PGLITE_DATA_DIR'] ?? '.archi-navi/data';

  // PGlite는 부모 디렉토리가 있어야 함 — 없으면 자동 생성
  try {
    mkdirSync(pgliteDataDir, { recursive: true });
  } catch {
    // 이미 존재하면 무시
  }

  _clientPromise = initializeDb(pgliteDataDir).finally(() => {
    if (_client) return;
    _clientPromise = null;
  });

  return _clientPromise;
}
