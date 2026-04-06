import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupBrokenEmbeddedPostgresDataDir } from '../embedded-postgres-runtime.js';

describe('db/embedded-postgres-runtime cleanup', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createTempDataDir(): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'archi-navi-db-'));
    tempDirs.push(dir);
    return dir;
  }

  it('0바이트 postmaster.pid는 안전하게 제거해야 한다', () => {
    const dataDir = createTempDataDir();
    writeFileSync(resolve(dataDir, 'postmaster.pid'), '');

    const result = cleanupBrokenEmbeddedPostgresDataDir(dataDir);

    expect(result.removedPidFile).toBe(true);
    expect(result.reasons).toContain('Removed empty postmaster.pid');
  });

  it('PG_VERSION만 있고 필수 cluster 디렉터리가 없으면 cluster를 초기화해야 한다', () => {
    const dataDir = createTempDataDir();
    writeFileSync(resolve(dataDir, 'PG_VERSION'), '16');
    mkdirSync(resolve(dataDir, 'base'));

    const result = cleanupBrokenEmbeddedPostgresDataDir(dataDir);

    expect(result.resetCluster).toBe(true);
    expect(result.reasons.join(' ')).toContain('missing global, pg_wal');
  });

  it('정상 cluster 디렉터리는 건드리지 않아야 한다', () => {
    const dataDir = createTempDataDir();
    writeFileSync(resolve(dataDir, 'PG_VERSION'), '16');
    mkdirSync(resolve(dataDir, 'base'));
    mkdirSync(resolve(dataDir, 'global'));
    mkdirSync(resolve(dataDir, 'pg_wal'));

    const result = cleanupBrokenEmbeddedPostgresDataDir(dataDir);

    expect(result.removedPidFile).toBe(false);
    expect(result.resetCluster).toBe(false);
    expect(readFileSync(resolve(dataDir, 'PG_VERSION'), 'utf8')).toBe('16');
  });
});
