import postgres from 'postgres';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanupBrokenEmbeddedPostgresDataDir,
  ensureEmbeddedPostgresConnection,
} from './embedded-postgres-runtime.js';
import { resolveTestEmbeddedPostgresDefaults } from './runtime-config.js';

const TEST_RUNTIME_DEFAULTS = resolveTestEmbeddedPostgresDefaults({
  baseDataDir: resolve(__dirname, '..', '..', '..', 'apps', 'web', '.archi-navi', 'dev-db'),
  basePort: 54329,
});
const DEFAULT_TEST_SHARED_DATA_DIR = TEST_RUNTIME_DEFAULTS.dataDir;
const DEFAULT_TEST_SHARED_PORT = TEST_RUNTIME_DEFAULTS.port;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type TestDatabaseSupport = {
  supported: boolean;
  mode?: 'postgres' | 'embedded-postgres';
  source?: 'ARCHI_NAVI_TEST_DATABASE_URL' | 'embedded-postgres';
  reasonCode?:
    | 'EXTERNAL_DATABASE_UNREACHABLE'
    | 'EMBEDDED_POSTGRES_SHARED_MEMORY_UNSUPPORTED'
    | 'EMBEDDED_POSTGRES_BOOTSTRAP_FAILED';
  reason?: string;
  remediation?: string;
};

let supportPromise: Promise<TestDatabaseSupport> | null = null;

function resolveExternalTestDatabaseUrl(): string | null {
  const value = process.env['ARCHI_NAVI_TEST_DATABASE_URL']?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizeTestDatabaseSupportError(
  error: unknown,
  source: 'postgres' | 'embedded-postgres',
): Pick<TestDatabaseSupport, 'reasonCode' | 'reason' | 'remediation'> {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes('could not create shared memory segment')
    || normalized.includes('shmat(')
    || normalized.includes('shared memory')
  ) {
    return {
      reasonCode: 'EMBEDDED_POSTGRES_SHARED_MEMORY_UNSUPPORTED',
      reason: message,
      remediation:
        '이 환경은 embedded PostgreSQL shared memory bootstrap을 지원하지 않습니다. ARCHI_NAVI_TEST_DATABASE_URL로 외부 PostgreSQL을 지정하거나 shared memory 제한을 완화하세요.',
    };
  }

  if (source === 'postgres') {
    return {
      reasonCode: 'EXTERNAL_DATABASE_UNREACHABLE',
      reason: message,
      remediation:
        'ARCHI_NAVI_TEST_DATABASE_URL 대상 PostgreSQL에 연결할 수 없습니다. 접속 정보와 서버 상태를 확인하세요.',
    };
  }

  return {
    reasonCode: 'EMBEDDED_POSTGRES_BOOTSTRAP_FAILED',
    reason: message,
    remediation:
      'embedded PostgreSQL 초기화 또는 기동에 실패했습니다. stale postmaster.pid, 손상된 cluster 디렉터리, shared memory 제한을 확인하세요.',
  };
}

export async function getTestDatabaseSupport(): Promise<TestDatabaseSupport> {
  if (!supportPromise) {
    supportPromise = (async () => {
      const externalConnectionString = resolveExternalTestDatabaseUrl();
      if (externalConnectionString) {
        const sql = postgres(externalConnectionString, { max: 1, onnotice: () => {} });
        try {
          await sql`select 1`;
          return {
            supported: true,
            mode: 'postgres',
            source: 'ARCHI_NAVI_TEST_DATABASE_URL',
          };
        } catch (error) {
          const details = normalizeTestDatabaseSupportError(error, 'postgres');
          return {
            supported: false,
            mode: 'postgres',
            source: 'ARCHI_NAVI_TEST_DATABASE_URL',
            ...details,
          };
        } finally {
          await sql.end().catch(() => undefined);
        }
      }

      try {
        const dataDir = resolve(
          process.env['ARCHI_NAVI_TEST_DB_DATA_DIR']?.trim() || DEFAULT_TEST_SHARED_DATA_DIR,
        );
        const port = Number.parseInt(
          process.env['ARCHI_NAVI_TEST_DB_PORT']?.trim() || `${DEFAULT_TEST_SHARED_PORT}`,
          10,
        );
        cleanupBrokenEmbeddedPostgresDataDir(dataDir);
        mkdirSync(resolve(dataDir, '..'), { recursive: true });
        const runtime = await ensureEmbeddedPostgresConnection(
          dataDir,
          Number.isFinite(port) && port > 0 ? port : DEFAULT_TEST_SHARED_PORT,
          'postgres',
        );
        await runtime.stop().catch(() => undefined);
        return {
          supported: true,
          mode: 'embedded-postgres',
          source: 'embedded-postgres',
        };
      } catch (error) {
        const details = normalizeTestDatabaseSupportError(error, 'embedded-postgres');
        return {
          supported: false,
          mode: 'embedded-postgres',
          source: 'embedded-postgres',
          ...details,
        };
      }
    })();
  }

  return await supportPromise;
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  const support = await getTestDatabaseSupport();
  if (support.supported) {
    return { supported: true };
  }
  return support.reason
    ? {
        supported: false,
        reason: support.reason,
      }
    : {
        supported: false,
      };
}
