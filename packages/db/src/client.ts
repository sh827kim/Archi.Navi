/**
 * DB 클라이언트 팩토리
 * - 외부 PostgreSQL 서버 또는 embedded-postgres를 사용
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema/index.js';
import {
  DEFAULT_EMBEDDED_POSTGRES_PASSWORD,
  DEFAULT_EMBEDDED_POSTGRES_USER,
  resolveDatabaseTarget,
  resolveEmbeddedPostgresRuntimeConfigFromEnv,
} from './runtime-config.js';
import { ensureEmbeddedPostgresConnection, type EmbeddedPostgresConnection } from './embedded-postgres-runtime.js';
import { ensurePostgresDatabase, getPostgresDataDirectory } from './postgres-utils.js';

type SqlClient = ReturnType<typeof postgres>;

export type DbClient = ReturnType<typeof createDb>;

let _sql: SqlClient | null = null;
let _client: DbClient | null = null;
let _clientPromise: Promise<DbClient> | null = null;
let _stopRuntime: (() => Promise<void>) | null = null;
let _shutdownHookInstalled = false;

let _sharedTestRuntimePromise: Promise<TestRuntime> | null = null;
let _testDatabaseCounter = 0;
const DEFAULT_MIGRATIONS_FOLDER = existsSync(resolve(__dirname, 'migrations'))
  ? resolve(__dirname, 'migrations')
  : resolve(__dirname, '..', 'src', 'migrations');
const DEFAULT_TEST_SHARED_DATA_DIR = resolve(__dirname, '..', '..', '..', 'apps', 'web', '.archi-navi', 'dev-db');
const DEFAULT_TEST_SHARED_PORT = 54329;

type TestRuntime =
  | {
      mode: 'postgres';
      adminConnectionString: string;
      stop(): Promise<void>;
    }
  | {
      mode: 'embedded-postgres';
      adminConnectionString: string;
      stop(): Promise<void>;
    };

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return drizzlePg(sql, { schema });
}

function createDbWithSql(sql: SqlClient) {
  return drizzlePg(sql, { schema });
}

async function closeSql(): Promise<void> {
  if (!_sql) return;
  try {
    await _sql.end();
  } catch (error) {
    console.warn('[archi-navi/db] postgres client 종료 중 경고:', error);
  } finally {
    _sql = null;
  }
}

export async function closeDb(): Promise<void> {
  try {
    await closeSql();
    if (_stopRuntime) {
      await _stopRuntime();
    }
  } catch (error) {
    console.warn('[archi-navi/db] DB 종료 중 경고:', error);
  } finally {
    _client = null;
    _clientPromise = null;
    _stopRuntime = null;
  }
}

function installShutdownHook(): void {
  if (_shutdownHookInstalled) return;
  _shutdownHookInstalled = true;

  process.once('SIGINT', () => {
    void closeDb();
  });
  process.once('SIGTERM', () => {
    void closeDb();
  });
  process.once('beforeExit', () => {
    void closeDb();
  });
}

export async function applyMigrations(url: string): Promise<void> {
  const migrationsFolder = process.env['MIGRATIONS_FOLDER']?.trim() || DEFAULT_MIGRATIONS_FOLDER;

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}

async function initializeDb(): Promise<DbClient> {
  const target = resolveDatabaseTarget();
  let runtime: EmbeddedPostgresConnection | null = null;
  let connectionString: string;

  if (target.mode === 'embedded-postgres') {
    runtime = await ensureEmbeddedPostgresConnection(target.dataDir, target.port, target.databaseName, {
      user: target.user,
      password: target.password,
    });
    connectionString = runtime.connectionString;
  } else {
    connectionString = target.connectionString;
  }

  await applyMigrations(connectionString);

  _sql = postgres(connectionString, { max: 10, onnotice: () => {} });
  _client = createDbWithSql(_sql);
  _stopRuntime = runtime?.stop ?? null;
  installShutdownHook();
  return _client;
}

export async function getDb(): Promise<DbClient> {
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;

  _clientPromise = initializeDb().finally(() => {
    if (_client) return;
    _clientPromise = null;
  });

  return _clientPromise;
}

function nextTestDatabaseName(): string {
  _testDatabaseCounter += 1;
  const hash = createHash('sha1')
    .update(`${process.pid}-${Date.now()}-${_testDatabaseCounter}`)
    .digest('hex')
    .slice(0, 12);
  return `anavi_test_${hash}`;
}

function resolveSharedTestRuntimeConfig() {
  return resolveEmbeddedPostgresRuntimeConfigFromEnv({
    dataDirEnvVar: 'ARCHI_NAVI_TEST_DB_DATA_DIR',
    portEnvVar: 'ARCHI_NAVI_TEST_DB_PORT',
    userEnvVar: 'ARCHI_NAVI_TEST_DB_USER',
    passwordEnvVar: 'ARCHI_NAVI_TEST_DB_PASSWORD',
    databaseNameEnvVar: 'ARCHI_NAVI_TEST_DB_NAME',
    fallbackDataDir: DEFAULT_TEST_SHARED_DATA_DIR,
    fallbackPort: DEFAULT_TEST_SHARED_PORT,
    fallbackUser: DEFAULT_EMBEDDED_POSTGRES_USER,
    fallbackPassword: DEFAULT_EMBEDDED_POSTGRES_PASSWORD,
    fallbackDatabaseName: 'postgres',
  });
}

function resolveExternalTestDatabaseUrl(): string | null {
  const value = process.env['ARCHI_NAVI_TEST_DATABASE_URL']?.trim();
  return value && value.length > 0 ? value : null;
}

function replaceDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function getSharedTestRuntime(): Promise<TestRuntime> {
  if (_sharedTestRuntimePromise) return _sharedTestRuntimePromise;

  _sharedTestRuntimePromise = (async () => {
    const externalConnectionString = resolveExternalTestDatabaseUrl();
    if (externalConnectionString) {
      return {
        mode: 'postgres',
        adminConnectionString: externalConnectionString,
        stop: async () => {},
      };
    }

    const { dataDir, port: preferredPort, user, password, databaseName } = resolveSharedTestRuntimeConfig();
    mkdirSync(resolve(dataDir, '..'), { recursive: true });
    const runtime = await ensureEmbeddedPostgresConnection(dataDir, preferredPort, databaseName, {
      user,
      password,
    });
    return {
      mode: 'embedded-postgres',
      adminConnectionString: runtime.connectionString,
      stop: runtime.stop,
    };
  })();

  return _sharedTestRuntimePromise;
}

export async function createTestDb(): Promise<DbClient> {
  const runtime = await getSharedTestRuntime();
  const databaseName = nextTestDatabaseName();
  await ensurePostgresDatabase(runtime.adminConnectionString, databaseName);
  const connectionString = replaceDatabaseName(runtime.adminConnectionString, databaseName);
  await applyMigrations(connectionString);
  return createDb(connectionString);
}
