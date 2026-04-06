import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { getPostgresDataDirectory, ensurePostgresDatabase } from './postgres-utils.js';
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from './embedded-postgres-error.js';

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  postgresFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresConnection = {
  connectionString: string;
  source: string;
  stop(): Promise<void>;
};

export type EmbeddedPostgresConnectionOptions = {
  user?: string;
  password?: string;
};

export type EmbeddedPostgresDataDirCleanupResult = {
  removedPidFile: boolean;
  resetCluster: boolean;
  reasons: string[];
};

function buildPostgresConnectionString(input: {
  user: string;
  password: string;
  port: number;
  databaseName: string;
}): string {
  const url = new URL(`postgres://127.0.0.1:${input.port}/${input.databaseName}`);
  url.username = input.user;
  url.password = input.password;
  return url.toString();
}

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, 'utf8').split('\n')[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPostmasterPidFile(postmasterPidFile: string): {
  pid: number | null;
  empty: boolean;
} {
  if (!existsSync(postmasterPidFile)) {
    return { pid: null, empty: false };
  }

  try {
    const text = readFileSync(postmasterPidFile, 'utf8');
    if (text.trim().length === 0) {
      return { pid: null, empty: true };
    }
    const pid = Number(text.split('\n')[0]?.trim());
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      empty: false,
    };
  } catch {
    return { pid: null, empty: false };
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const port = Number(readFileSync(postmasterPidFile, 'utf8').split('\n')[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function canSafelyRemoveStalePidFile(postmasterPidFile: string): boolean {
  if (!existsSync(postmasterPidFile)) return false;
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  if (runningPid) return false;
  return true;
}

export function cleanupBrokenEmbeddedPostgresDataDir(dataDir: string): EmbeddedPostgresDataDirCleanupResult {
  const resolvedDataDir = resolve(dataDir);
  const postmasterPidFile = resolve(resolvedDataDir, 'postmaster.pid');
  const pgVersionFile = resolve(resolvedDataDir, 'PG_VERSION');
  const requiredClusterDirs = ['base', 'global', 'pg_wal'];
  const result: EmbeddedPostgresDataDirCleanupResult = {
    removedPidFile: false,
    resetCluster: false,
    reasons: [],
  };

  if (!existsSync(resolvedDataDir)) {
    return result;
  }

  if (existsSync(postmasterPidFile)) {
    const pidFile = readPostmasterPidFile(postmasterPidFile);
    const pidFileSize = (() => {
      try {
        return statSync(postmasterPidFile).size;
      } catch {
        return -1;
      }
    })();

    if (pidFileSize === 0 || pidFile.empty) {
      rmSync(postmasterPidFile, { force: true });
      result.removedPidFile = true;
      result.reasons.push('Removed empty postmaster.pid');
    } else if (pidFile.pid === null && canSafelyRemoveStalePidFile(postmasterPidFile)) {
      rmSync(postmasterPidFile, { force: true });
      result.removedPidFile = true;
      result.reasons.push('Removed invalid postmaster.pid');
    } else if (canSafelyRemoveStalePidFile(postmasterPidFile)) {
      rmSync(postmasterPidFile, { force: true });
      result.removedPidFile = true;
      result.reasons.push('Removed stale postmaster.pid');
    }
  }

  const hasPgVersion = existsSync(pgVersionFile);
  const entries = (() => {
    try {
      return readdirSync(resolvedDataDir);
    } catch {
      return [];
    }
  })();
  const missingClusterDirs = requiredClusterDirs.filter(
    (directory) => !existsSync(resolve(resolvedDataDir, directory)),
  );
  const hasClusterArtifacts =
    hasPgVersion
    || entries.some((entry) => entry === 'postmaster.pid' || entry === 'base' || entry === 'global' || entry === 'pg_wal' || entry.startsWith('pg_'));
  const clusterLooksIncomplete =
    hasClusterArtifacts && (!hasPgVersion || missingClusterDirs.length > 0);
  const runningPid = readRunningPostmasterPid(postmasterPidFile);

  if (clusterLooksIncomplete && !runningPid) {
    rmSync(resolvedDataDir, { recursive: true, force: true });
    result.resetCluster = true;
    if (!hasPgVersion) {
      result.reasons.push('Removed incomplete cluster without PG_VERSION');
    }
    if (missingClusterDirs.length > 0) {
      result.reasons.push(`Removed incomplete cluster missing ${missingClusterDirs.join(', ')}`);
    }
  }

  return result;
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolvePort(error.code === 'EADDRINUSE');
    });
    server.listen(port, '127.0.0.1', () => {
      server.close();
      resolvePort(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`embedded postgres free port를 찾을 수 없습니다: ${startPort}~${startPort + 19}`);
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import('embedded-postgres');
  return mod.default as EmbeddedPostgresCtor;
}

export async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
  databaseName = 'archi_navi',
  options: EmbeddedPostgresConnectionOptions = {},
): Promise<EmbeddedPostgresConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  const resolvedDataDir = resolve(dataDir);
  cleanupBrokenEmbeddedPostgresDataDir(resolvedDataDir);
  const user = options.user?.trim() || 'archi_navi';
  const password = options.password?.trim() || 'archi_navi';
  const postmasterPidFile = resolve(resolvedDataDir, 'postmaster.pid');
  const pgVersionFile = resolve(resolvedDataDir, 'PG_VERSION');
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const preferredAdminConnectionString = buildPostgresConnectionString({
    user,
    password,
    port: preferredPort,
    databaseName: 'postgres',
  });

  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      if (actualDataDir && resolve(actualDataDir) === resolvedDataDir) {
        await ensurePostgresDatabase(preferredAdminConnectionString, databaseName);
        process.emitWarning(
          `기존 PostgreSQL 인스턴스를 채택합니다: port=${preferredPort}, dataDir=${resolvedDataDir}`,
        );
        return {
          connectionString: buildPostgresConnectionString({
            user,
            password,
            port: preferredPort,
            databaseName,
          }),
          source: `embedded-postgres@${preferredPort}`,
          stop: async () => {},
        };
      }
    } catch {
      // fall through
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    const adminConnectionString = buildPostgresConnectionString({
      user,
      password,
      port,
      databaseName: 'postgres',
    });
    await ensurePostgresDatabase(adminConnectionString, databaseName);
    return {
      connectionString: buildPostgresConnectionString({
        user,
        password,
        port,
        databaseName,
      }),
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const selectedPort = await findAvailablePort(preferredPort);
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir: resolvedDataDir,
    user,
    password,
    port: selectedPort,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-messages=C'],
    postgresFlags: [
      '-c', 'shared_memory_type=mmap',
      '-c', 'dynamic_shared_memory_type=mmap',
      '-c', 'shared_buffers=16MB',
      '-c', 'max_connections=100',
    ],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!existsSync(pgVersionFile)) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage: `embedded postgres cluster 초기화 실패: ${resolvedDataDir}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }

  if (canSafelyRemoveStalePidFile(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }

  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `embedded postgres 기동 실패: port=${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  const adminConnectionString = buildPostgresConnectionString({
    user,
    password,
    port: selectedPort,
    databaseName: 'postgres',
  });
  await ensurePostgresDatabase(adminConnectionString, databaseName);

  return {
    connectionString: buildPostgresConnectionString({
      user,
      password,
      port: selectedPort,
      databaseName,
    }),
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      await instance.stop();
    },
  };
}
