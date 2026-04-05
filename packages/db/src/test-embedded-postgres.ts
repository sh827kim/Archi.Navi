import postgres from 'postgres';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureEmbeddedPostgresConnection } from './embedded-postgres-runtime.js';

const DEFAULT_TEST_SHARED_DATA_DIR = resolve(__dirname, '..', '..', '..', 'apps', 'web', '.archi-navi', 'dev-db');
const DEFAULT_TEST_SHARED_PORT = 54329;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type TestDatabaseSupport = {
  supported: boolean;
  mode?: 'postgres' | 'embedded-postgres';
  source?: 'ARCHI_NAVI_TEST_DATABASE_URL' | 'embedded-postgres';
  reason?: string;
};

let supportPromise: Promise<TestDatabaseSupport> | null = null;

function resolveExternalTestDatabaseUrl(): string | null {
  const value = process.env['ARCHI_NAVI_TEST_DATABASE_URL']?.trim();
  return value && value.length > 0 ? value : null;
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
          return {
            supported: false,
            mode: 'postgres',
            source: 'ARCHI_NAVI_TEST_DATABASE_URL',
            reason: error instanceof Error ? error.message : String(error),
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
        return {
          supported: false,
          reason: error instanceof Error ? error.message : String(error),
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
