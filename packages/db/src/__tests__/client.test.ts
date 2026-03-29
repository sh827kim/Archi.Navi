import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockPGliteCtor = vi.fn();
const mockDrizzle = vi.fn();
const mockMigrate = vi.fn();

vi.mock('@electric-sql/pglite', () => ({
  PGlite: function PGliteMock(this: unknown, ...args: unknown[]) {
    return mockPGliteCtor(...args);
  },
}));

vi.mock('drizzle-orm/pglite', () => ({
  drizzle: vi.fn((...args: unknown[]) => mockDrizzle(...args)),
}));

vi.mock('drizzle-orm/pglite/migrator', () => ({
  migrate: vi.fn((...args: unknown[]) => mockMigrate(...args)),
}));

function makeDbClient(executeImpl?: () => Promise<unknown>) {
  return {
    execute: vi.fn(executeImpl ?? (() => Promise.resolve([{ ok: 1 }]))),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('db/client', () => {
  const oldEnv = process.env['PGLITE_DATA_DIR'];
  const oldMigrationsFolder = process.env['MIGRATIONS_FOLDER'];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockMigrate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (oldEnv === undefined) {
      delete process.env['PGLITE_DATA_DIR'];
    } else {
      process.env['PGLITE_DATA_DIR'] = oldEnv;
    }

    if (oldMigrationsFolder === undefined) {
      delete process.env['MIGRATIONS_FOLDER'];
    } else {
      process.env['MIGRATIONS_FOLDER'] = oldMigrationsFolder;
    }
  });

  it('createPgliteClient는 기본 memory:// 경로를 사용해야 한다', async () => {
    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    mockDrizzle.mockImplementation(() => makeDbClient());

    const { createPgliteClient } = await import('../client.js');
    const client = createPgliteClient();

    expect(client).toBeDefined();
    expect(mockPGliteCtor).toHaveBeenCalledWith('memory://');
    expect(mockDrizzle).toHaveBeenCalledTimes(1);
  });

  it('getDb는 싱글턴 클라이언트를 반환해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-singleton-'));
    process.env['PGLITE_DATA_DIR'] = dataDir;

    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    const dbClient = makeDbClient();
    mockDrizzle.mockImplementation(() => dbClient);

    const { getDb } = await import('../client.js');
    const first = await getDb();
    const second = await getDb();

    expect(first).toBe(second);
    expect(mockPGliteCtor).toHaveBeenCalledTimes(1);
    expect(dbClient.execute).toHaveBeenCalledTimes(1);
    expect(mockMigrate).not.toHaveBeenCalled();
  });

  it('MIGRATIONS_FOLDER가 설정되면 초기화 직후 마이그레이션을 수행해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-migrate-'));
    process.env['PGLITE_DATA_DIR'] = dataDir;
    process.env['MIGRATIONS_FOLDER'] = '/tmp/archi-navi-migrations';

    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    const dbClient = makeDbClient();
    mockDrizzle.mockImplementation(() => dbClient);

    const { getDb } = await import('../client.js');
    const client = await getDb();

    expect(client).toBe(dbClient);
    expect(mockMigrate).toHaveBeenCalledWith(dbClient, {
      migrationsFolder: '/tmp/archi-navi-migrations',
    });
  });

  it('동시 호출 시에도 PGlite 초기화는 한 번만 수행해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-concurrent-'));
    process.env['PGLITE_DATA_DIR'] = dataDir;

    const closeSpy = vi.fn().mockResolvedValue(undefined);
    mockPGliteCtor.mockImplementation(() => ({ close: closeSpy }));

    let resolveExecute: (() => void) | undefined;
    const dbClient = makeDbClient(
      () =>
        new Promise((resolve) => {
          resolveExecute = () => resolve([{ ok: 1 }]);
        }),
    );
    mockDrizzle.mockImplementation(() => dbClient);

    const { getDb } = await import('../client.js');
    const firstPromise = getDb();
    const secondPromise = getDb();

    expect(mockPGliteCtor).toHaveBeenCalledTimes(1);
    expect(dbClient.execute).toHaveBeenCalledTimes(1);

    if (resolveExecute) {
      resolveExecute();
    }

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toBe(second);
  });

  it('Aborted 오류 발생 시 데이터 디렉터리 재생성 후 재시도해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-recover-'));
    writeFileSync(join(dataDir, 'stale.bin'), 'corrupted');
    process.env['PGLITE_DATA_DIR'] = dataDir;

    const closeFirst = vi.fn().mockResolvedValue(undefined);
    const closeSecond = vi.fn().mockResolvedValue(undefined);

    mockPGliteCtor
      .mockImplementationOnce(() => ({ close: closeFirst }))
      .mockImplementationOnce(() => ({ close: closeSecond }));

    const firstClient = makeDbClient(() =>
      Promise.reject(new Error('RuntimeError: Aborted()')),
    );
    const secondClient = makeDbClient();
    mockDrizzle
      .mockImplementationOnce(() => firstClient)
      .mockImplementationOnce(() => secondClient);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { getDb } = await import('../client.js');
    const recovered = await getDb();

    expect(recovered).toBe(secondClient);
    expect(closeFirst).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(existsSync(dataDir)).toBe(true);
    warnSpy.mockRestore();
  });

  it('stale postmaster.pid 가 있으면 초기화 전에 pid 파일만 정리하고 데이터는 보존해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-stale-pid-'));
    writeFileSync(join(dataDir, 'postmaster.pid'), '-42\n/tmp/pglite/base\n');
    writeFileSync(join(dataDir, 'keep-me.txt'), 'workspace-data');
    process.env['PGLITE_DATA_DIR'] = dataDir;

    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    const dbClient = makeDbClient();
    mockDrizzle.mockImplementation(() => dbClient);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { getDb } = await import('../client.js');
    const client = await getDb();

    expect(client).toBe(dbClient);
    expect(mockPGliteCtor).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[archi-navi/db] stale postmaster.pid 감지, pid 파일만 정리',
    );
    expect(existsSync(join(dataDir, 'postmaster.pid'))).toBe(false);
    expect(existsSync(join(dataDir, 'keep-me.txt'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('Aborted가 아닌 오류는 그대로 throw해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-error-'));
    mkdirSync(dataDir, { recursive: true });
    process.env['PGLITE_DATA_DIR'] = dataDir;

    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    mockDrizzle.mockImplementation(() =>
      makeDbClient(() => Promise.reject(new Error('permission denied'))),
    );

    const { getDb } = await import('../client.js');
    await expect(getDb()).rejects.toThrow('permission denied');
  });

  it('memory:// 경로에서는 복구 디렉터리 삭제를 시도하지 않아야 한다', async () => {
    process.env['PGLITE_DATA_DIR'] = 'memory://custom';

    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    mockDrizzle.mockImplementation(() =>
      makeDbClient(() => Promise.reject(new Error('RuntimeError: Aborted()'))),
    );

    const { getDb } = await import('../client.js');
    await expect(getDb()).rejects.toThrow('Aborted');
  });

  it('종료 훅 콜백(SIGNIT/SIGTERM/beforeExit)은 모두 closePg를 트리거해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-hook-'));
    process.env['PGLITE_DATA_DIR'] = dataDir;

    const closeSpy = vi.fn().mockResolvedValue(undefined);
    mockPGliteCtor.mockImplementation(() => ({ close: closeSpy }));
    mockDrizzle.mockImplementation(() => makeDbClient());

    const handlers = new Map<string, () => void>();
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((
      event: Parameters<typeof process.once>[0],
      callback: Parameters<typeof process.once>[1],
    ) => {
      handlers.set(String(event), callback as () => void);
      return process;
    }) as typeof process.once);

    const { getDb } = await import('../client.js');
    await getDb();

    const sigintHandler = handlers.get('SIGINT');
    const sigtermHandler = handlers.get('SIGTERM');
    const beforeExitHandler = handlers.get('beforeExit');

    expect(sigintHandler).toBeTypeOf('function');
    expect(sigtermHandler).toBeTypeOf('function');
    expect(beforeExitHandler).toBeTypeOf('function');

    sigintHandler?.();
    await flushMicrotasks();
    sigtermHandler?.();
    await flushMicrotasks();
    beforeExitHandler?.();
    await flushMicrotasks();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    onceSpy.mockRestore();
  });

  it('Error 인스턴스가 아닌 문자열 Aborted 오류도 복구해야 한다', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'anavi-db-string-abort-'));
    writeFileSync(join(dataDir, 'broken.bin'), 'broken');
    process.env['PGLITE_DATA_DIR'] = dataDir;

    mockPGliteCtor
      .mockImplementationOnce(() => ({ close: vi.fn().mockResolvedValue(undefined) }))
      .mockImplementationOnce(() => ({ close: vi.fn().mockResolvedValue(undefined) }));

    mockDrizzle
      .mockImplementationOnce(() => makeDbClient(() => Promise.reject('RuntimeError: Aborted()')))
      .mockImplementationOnce(() => makeDbClient());

    const { getDb } = await import('../client.js');
    const client = await getDb();
    expect(client).toBeDefined();
  });

  it('데이터 디렉터리가 없는 상태의 Aborted 오류는 복구하지 않고 원본 오류를 throw해야 한다', async () => {
    const dataDir = join(tmpdir(), `anavi-db-missing-${Date.now()}-${Math.random()}`);
    process.env['PGLITE_DATA_DIR'] = dataDir;

    mockPGliteCtor.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
    mockDrizzle.mockImplementation(() =>
      makeDbClient(() => Promise.reject(new Error('RuntimeError: Aborted()'))),
    );

    const { getDb } = await import('../client.js');
    await expect(getDb()).rejects.toThrow('Aborted');
  });

  afterEach(() => {
    try {
      const dir = process.env['PGLITE_DATA_DIR'];
      if (dir && !dir.startsWith('memory://') && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // cleanup best-effort
    }
  });
});
