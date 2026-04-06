import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type DatabaseMode = 'postgres' | 'embedded-postgres';
export type EmbeddedPostgresRuntimeConfig = {
  dataDir: string;
  port: number;
  user: string;
  password: string;
  databaseName: string;
};

export const DEFAULT_EMBEDDED_POSTGRES_PORT = 54329;
export const DEFAULT_EMBEDDED_POSTGRES_USER = 'archi_navi';
export const DEFAULT_EMBEDDED_POSTGRES_PASSWORD = 'archi_navi';
export const DEFAULT_EMBEDDED_POSTGRES_DB_NAME = 'archi_navi';

export type ResolvedDatabaseTarget =
  | {
      mode: 'postgres';
      connectionString: string;
      source: 'DATABASE_URL';
    }
  | ({
      mode: 'embedded-postgres';
      source: `embedded-postgres@${number}`;
    } & EmbeddedPostgresRuntimeConfig);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

export function resolveDefaultEmbeddedPostgresDataDir(): string {
  return resolve(homedir(), '.archi-navi', 'db');
}

function parseWorkerIndex(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveTestEmbeddedPostgresDefaults(input?: {
  baseDataDir?: string;
  basePort?: number;
}): { dataDir: string; port: number } {
  const workerIndex =
    parseWorkerIndex(process.env['VITEST_WORKER_ID'])
    ?? parseWorkerIndex(process.env['JEST_WORKER_ID'])
    ?? 1;
  const baseDataDir = input?.baseDataDir ?? resolve(homedir(), '.archi-navi', 'test-db');
  const basePort = input?.basePort ?? DEFAULT_EMBEDDED_POSTGRES_PORT;
  const pidOffset = Math.abs(process.pid % 20);

  return {
    dataDir: resolve(baseDataDir, `worker-${workerIndex}`, `pid-${process.pid}`),
    port: basePort + ((Math.max(workerIndex - 1, 0) * 20) + pidOffset),
  };
}

export function resolveEmbeddedPostgresRuntimeConfigFromEnv(input: {
  dataDirEnvVar: string;
  portEnvVar: string;
  userEnvVar: string;
  passwordEnvVar: string;
  databaseNameEnvVar: string;
  fallbackDataDir: string;
  fallbackPort?: number;
  fallbackUser?: string;
  fallbackPassword?: string;
  fallbackDatabaseName?: string;
}): EmbeddedPostgresRuntimeConfig {
  const port = parsePositiveInt(
    process.env[input.portEnvVar]?.trim(),
    input.fallbackPort ?? DEFAULT_EMBEDDED_POSTGRES_PORT,
  );

  return {
    dataDir: resolve(
      process.env[input.dataDirEnvVar]?.trim() || input.fallbackDataDir,
    ),
    port,
    user: parseNonEmptyString(
      process.env[input.userEnvVar],
      input.fallbackUser ?? DEFAULT_EMBEDDED_POSTGRES_USER,
    ),
    password: parseNonEmptyString(
      process.env[input.passwordEnvVar],
      input.fallbackPassword ?? DEFAULT_EMBEDDED_POSTGRES_PASSWORD,
    ),
    databaseName: parseNonEmptyString(
      process.env[input.databaseNameEnvVar],
      input.fallbackDatabaseName ?? DEFAULT_EMBEDDED_POSTGRES_DB_NAME,
    ),
  };
}

export function resolveDatabaseTarget(): ResolvedDatabaseTarget {
  const mode = process.env['ARCHI_NAVI_DB_MODE']?.trim();
  const databaseUrl = process.env['DATABASE_URL']?.trim();

  if (databaseUrl) {
    return {
      mode: 'postgres',
      connectionString: databaseUrl,
      source: 'DATABASE_URL',
    };
  }

  if (mode === 'postgres') {
    throw new Error('ARCHI_NAVI_DB_MODE=postgres 인 경우 DATABASE_URL이 필요합니다.');
  }

  const runtime = resolveEmbeddedPostgresRuntimeConfigFromEnv({
    dataDirEnvVar: 'ARCHI_NAVI_DB_DATA_DIR',
    portEnvVar: 'ARCHI_NAVI_DB_PORT',
    userEnvVar: 'ARCHI_NAVI_DB_USER',
    passwordEnvVar: 'ARCHI_NAVI_DB_PASSWORD',
    databaseNameEnvVar: 'ARCHI_NAVI_DB_NAME',
    fallbackDataDir: resolveDefaultEmbeddedPostgresDataDir(),
  });

  return {
    mode: 'embedded-postgres',
    ...runtime,
    source: `embedded-postgres@${runtime.port}`,
  };
}
