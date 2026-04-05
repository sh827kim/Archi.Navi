import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPostgres = vi.fn();
const mockDrizzle = vi.fn();
const mockMigrate = vi.fn();
const mockEnsureEmbeddedPostgresConnection = vi.fn();

vi.mock('postgres', () => ({
  default: vi.fn((...args: unknown[]) => mockPostgres(...args)),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn((...args: unknown[]) => mockDrizzle(...args)),
}));

vi.mock('drizzle-orm/postgres-js/migrator', () => ({
  migrate: vi.fn((...args: unknown[]) => mockMigrate(...args)),
}));

vi.mock('../embedded-postgres-runtime.js', () => ({
  ensureEmbeddedPostgresConnection: vi.fn((...args: unknown[]) => mockEnsureEmbeddedPostgresConnection(...args)),
}));

type MockSql = {
  end: ReturnType<typeof vi.fn>;
  unsafe: ReturnType<typeof vi.fn>;
} & ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>);

function createMockSql(): MockSql {
  const sql = (vi.fn(async () => []) as unknown) as MockSql;
  sql.end = vi.fn().mockResolvedValue(undefined);
  sql.unsafe = vi.fn().mockResolvedValue([]);
  return sql;
}

function createMockDbClient() {
  return {
    execute: vi.fn().mockResolvedValue([]),
  };
}

describe('db/client', () => {
  const oldDatabaseUrl = process.env['DATABASE_URL'];
  const oldDbMode = process.env['ARCHI_NAVI_DB_MODE'];
  const oldDbDataDir = process.env['ARCHI_NAVI_DB_DATA_DIR'];
  const oldDbPort = process.env['ARCHI_NAVI_DB_PORT'];
  const oldDbUser = process.env['ARCHI_NAVI_DB_USER'];
  const oldDbPassword = process.env['ARCHI_NAVI_DB_PASSWORD'];
  const oldDbName = process.env['ARCHI_NAVI_DB_NAME'];
  const oldTestDatabaseUrl = process.env['ARCHI_NAVI_TEST_DATABASE_URL'];
  const oldTestDbDataDir = process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'];
  const oldTestDbPort = process.env['ARCHI_NAVI_TEST_DB_PORT'];
  const oldTestDbUser = process.env['ARCHI_NAVI_TEST_DB_USER'];
  const oldTestDbPassword = process.env['ARCHI_NAVI_TEST_DB_PASSWORD'];
  const oldTestDbName = process.env['ARCHI_NAVI_TEST_DB_NAME'];
  const oldMigrationsFolder = process.env['MIGRATIONS_FOLDER'];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockMigrate.mockResolvedValue(undefined);
    mockEnsureEmbeddedPostgresConnection.mockResolvedValue({
      connectionString: 'postgres://archi_navi:archi_navi@127.0.0.1:54329/archi_navi',
      source: 'embedded-postgres@54329',
      stop: vi.fn().mockResolvedValue(undefined),
    });
    mockPostgres.mockImplementation(() => createMockSql());
    mockDrizzle.mockImplementation(() => createMockDbClient());
  });

  afterEach(async () => {
    const clientModule = await import('../client.js');
    await clientModule.closeDb();

    if (oldDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = oldDatabaseUrl;

    if (oldDbMode === undefined) delete process.env['ARCHI_NAVI_DB_MODE'];
    else process.env['ARCHI_NAVI_DB_MODE'] = oldDbMode;

    if (oldDbDataDir === undefined) delete process.env['ARCHI_NAVI_DB_DATA_DIR'];
    else process.env['ARCHI_NAVI_DB_DATA_DIR'] = oldDbDataDir;

    if (oldDbPort === undefined) delete process.env['ARCHI_NAVI_DB_PORT'];
    else process.env['ARCHI_NAVI_DB_PORT'] = oldDbPort;

    if (oldDbUser === undefined) delete process.env['ARCHI_NAVI_DB_USER'];
    else process.env['ARCHI_NAVI_DB_USER'] = oldDbUser;

    if (oldDbPassword === undefined) delete process.env['ARCHI_NAVI_DB_PASSWORD'];
    else process.env['ARCHI_NAVI_DB_PASSWORD'] = oldDbPassword;

    if (oldDbName === undefined) delete process.env['ARCHI_NAVI_DB_NAME'];
    else process.env['ARCHI_NAVI_DB_NAME'] = oldDbName;

    if (oldTestDatabaseUrl === undefined) delete process.env['ARCHI_NAVI_TEST_DATABASE_URL'];
    else process.env['ARCHI_NAVI_TEST_DATABASE_URL'] = oldTestDatabaseUrl;

    if (oldTestDbDataDir === undefined) delete process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'];
    else process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'] = oldTestDbDataDir;

    if (oldTestDbPort === undefined) delete process.env['ARCHI_NAVI_TEST_DB_PORT'];
    else process.env['ARCHI_NAVI_TEST_DB_PORT'] = oldTestDbPort;

    if (oldTestDbUser === undefined) delete process.env['ARCHI_NAVI_TEST_DB_USER'];
    else process.env['ARCHI_NAVI_TEST_DB_USER'] = oldTestDbUser;

    if (oldTestDbPassword === undefined) delete process.env['ARCHI_NAVI_TEST_DB_PASSWORD'];
    else process.env['ARCHI_NAVI_TEST_DB_PASSWORD'] = oldTestDbPassword;

    if (oldTestDbName === undefined) delete process.env['ARCHI_NAVI_TEST_DB_NAME'];
    else process.env['ARCHI_NAVI_TEST_DB_NAME'] = oldTestDbName;

    if (oldMigrationsFolder === undefined) delete process.env['MIGRATIONS_FOLDER'];
    else process.env['MIGRATIONS_FOLDER'] = oldMigrationsFolder;
  });

  it('createDb는 postgres-js 드라이버와 drizzle postgres adapter를 사용해야 한다', async () => {
    const { createDb } = await import('../client.js');

    const db = createDb('postgres://archi_navi:archi_navi@127.0.0.1:54329/archi_navi');

    expect(db).toBeDefined();
    expect(mockPostgres).toHaveBeenCalledWith(
      'postgres://archi_navi:archi_navi@127.0.0.1:54329/archi_navi',
      expect.objectContaining({ max: 10 }),
    );
    expect(mockDrizzle).toHaveBeenCalledTimes(1);
  });

  it('getDb는 embedded-postgres 모드에서 싱글턴 클라이언트를 반환해야 한다', async () => {
    process.env['ARCHI_NAVI_DB_DATA_DIR'] = '/tmp/anavi-db-dev';
    process.env['ARCHI_NAVI_DB_PORT'] = '54329';

    const { getDb } = await import('../client.js');

    const first = await getDb();
    const second = await getDb();

    expect(first).toBe(second);
    expect(mockEnsureEmbeddedPostgresConnection).toHaveBeenCalledTimes(1);
    expect(mockEnsureEmbeddedPostgresConnection).toHaveBeenCalledWith(
      '/tmp/anavi-db-dev',
      54329,
      'archi_navi',
      { user: 'archi_navi', password: 'archi_navi' },
    );
    expect(mockMigrate).toHaveBeenCalledTimes(1);
  });

  it('embedded-postgres user/password/dbName 환경변수를 런타임에 반영해야 한다', async () => {
    process.env['ARCHI_NAVI_DB_DATA_DIR'] = '/tmp/anavi-db-custom';
    process.env['ARCHI_NAVI_DB_PORT'] = '54339';
    process.env['ARCHI_NAVI_DB_USER'] = 'runtime_user';
    process.env['ARCHI_NAVI_DB_PASSWORD'] = 'runtime_password';
    process.env['ARCHI_NAVI_DB_NAME'] = 'runtime_db';

    const { getDb } = await import('../client.js');
    await getDb();

    expect(mockEnsureEmbeddedPostgresConnection).toHaveBeenCalledWith(
      '/tmp/anavi-db-custom',
      54339,
      'runtime_db',
      { user: 'runtime_user', password: 'runtime_password' },
    );
  });

  it('DATABASE_URL이 있으면 외부 postgres 모드를 사용해야 한다', async () => {
    process.env['DATABASE_URL'] = 'postgres://external:secret@127.0.0.1:6543/archi_navi';
    process.env['ARCHI_NAVI_DB_MODE'] = 'postgres';

    const { getDb } = await import('../client.js');
    await getDb();

    expect(mockEnsureEmbeddedPostgresConnection).not.toHaveBeenCalled();
    expect(mockPostgres).toHaveBeenCalledWith(
      'postgres://external:secret@127.0.0.1:6543/archi_navi',
      expect.objectContaining({ max: 1 }),
    );
    expect(mockPostgres).toHaveBeenCalledWith(
      'postgres://external:secret@127.0.0.1:6543/archi_navi',
      expect.objectContaining({ max: 10 }),
    );
  });

  it('closeDb는 postgres client 종료와 embedded runtime stop을 수행해야 한다', async () => {
    process.env['ARCHI_NAVI_DB_DATA_DIR'] = '/tmp/anavi-db-close';
    const stop = vi.fn().mockResolvedValue(undefined);
    const runtimeSql = createMockSql();

    mockEnsureEmbeddedPostgresConnection.mockResolvedValue({
      connectionString: 'postgres://archi_navi:archi_navi@127.0.0.1:54329/archi_navi',
      source: 'embedded-postgres@54329',
      stop,
    });
    mockPostgres
      .mockImplementationOnce(() => createMockSql())
      .mockImplementationOnce(() => runtimeSql);

    const { getDb, closeDb } = await import('../client.js');
    await getDb();
    await closeDb();

    expect(runtimeSql.end).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('createTestDb는 shared embedded postgres 위에 새 데이터베이스를 만들고 마이그레이션해야 한다', async () => {
    delete process.env['ARCHI_NAVI_TEST_DATABASE_URL'];
    const { createTestDb } = await import('../client.js');

    const db = await createTestDb();

    expect(db).toBeDefined();
    expect(mockEnsureEmbeddedPostgresConnection).toHaveBeenCalledTimes(1);
    expect(mockMigrate).toHaveBeenCalledTimes(1);
    expect(mockPostgres).toHaveBeenCalled();
  });

  it('test embedded-postgres user/password/dbName 환경변수를 shared runtime에 반영해야 한다', async () => {
    delete process.env['ARCHI_NAVI_TEST_DATABASE_URL'];
    process.env['ARCHI_NAVI_TEST_DB_DATA_DIR'] = '/tmp/anavi-test-db';
    process.env['ARCHI_NAVI_TEST_DB_PORT'] = '55432';
    process.env['ARCHI_NAVI_TEST_DB_USER'] = 'test_user';
    process.env['ARCHI_NAVI_TEST_DB_PASSWORD'] = 'test_password';
    process.env['ARCHI_NAVI_TEST_DB_NAME'] = 'test_admin_db';

    mockEnsureEmbeddedPostgresConnection.mockResolvedValue({
      connectionString: 'postgres://test_user:test_password@127.0.0.1:55432/test_admin_db',
      source: 'embedded-postgres@55432',
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const { createTestDb } = await import('../client.js');
    await createTestDb();

    expect(mockEnsureEmbeddedPostgresConnection).toHaveBeenCalledWith(
      '/tmp/anavi-test-db',
      55432,
      'test_admin_db',
      { user: 'test_user', password: 'test_password' },
    );
  });

  it('ARCHI_NAVI_TEST_DATABASE_URL이 있으면 외부 postgres를 테스트 런타임으로 사용해야 한다', async () => {
    process.env['ARCHI_NAVI_TEST_DATABASE_URL'] =
      'postgres://spark@127.0.0.1:5432/postgres';

    const { createTestDb } = await import('../client.js');
    const db = await createTestDb();

    expect(db).toBeDefined();
    expect(mockEnsureEmbeddedPostgresConnection).not.toHaveBeenCalled();
    expect(mockPostgres).toHaveBeenCalledWith(
      'postgres://spark@127.0.0.1:5432/postgres',
      expect.objectContaining({ max: 1 }),
    );

    const migrationCall = mockPostgres.mock.calls.find(
      (call) =>
        typeof call[0] === 'string'
        && call[0].startsWith('postgres://spark@127.0.0.1:5432/anavi_test_'),
    );
    expect(migrationCall).toBeDefined();
  });

  it('ARCHI_NAVI_DB_MODE=postgres 인데 DATABASE_URL이 없으면 오류여야 한다', async () => {
    process.env['ARCHI_NAVI_DB_MODE'] = 'postgres';

    const { getDb } = await import('../client.js');
    await expect(getDb()).rejects.toThrow('DATABASE_URL');
  });
});
