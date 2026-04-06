import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPostgres = vi.fn();
const mockEnsureEmbeddedPostgresConnection = vi.fn();
const mockCleanupBrokenEmbeddedPostgresDataDir = vi.fn();

vi.mock('postgres', () => ({
  default: vi.fn((...args: unknown[]) => mockPostgres(...args)),
}));

vi.mock('../embedded-postgres-runtime.js', () => ({
  ensureEmbeddedPostgresConnection: vi.fn((...args: unknown[]) => mockEnsureEmbeddedPostgresConnection(...args)),
  cleanupBrokenEmbeddedPostgresDataDir: vi.fn((...args: unknown[]) =>
    mockCleanupBrokenEmbeddedPostgresDataDir(...args)
  ),
}));

function createMockSql() {
  return {
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe('db/test-embedded-postgres', () => {
  const oldTestDatabaseUrl = process.env['ARCHI_NAVI_TEST_DATABASE_URL'];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockCleanupBrokenEmbeddedPostgresDataDir.mockReturnValue({
      removedPidFile: false,
      resetCluster: false,
      reasons: [],
    });
    mockPostgres.mockImplementation(() => {
      const sql = createMockSql();
      return Object.assign(vi.fn(async () => [{ '?column?': 1 }]), sql);
    });
  });

  afterEach(() => {
    if (oldTestDatabaseUrl === undefined) delete process.env['ARCHI_NAVI_TEST_DATABASE_URL'];
    else process.env['ARCHI_NAVI_TEST_DATABASE_URL'] = oldTestDatabaseUrl;
  });

  it('getTestDatabaseSupport는 외부 DB 연결 실패를 설명적인 code와 remediation으로 반환해야 한다', async () => {
    process.env['ARCHI_NAVI_TEST_DATABASE_URL'] = 'postgres://broken@127.0.0.1:5432/postgres';
    mockPostgres.mockImplementation(() => {
      const sql = createMockSql();
      return Object.assign(
        vi.fn(async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        }),
        sql,
      );
    });

    const { getTestDatabaseSupport } = await import('../test-embedded-postgres.js');
    const support = await getTestDatabaseSupport();

    expect(support.supported).toBe(false);
    expect(support.reasonCode).toBe('EXTERNAL_DATABASE_UNREACHABLE');
    expect(support.remediation).toContain('ARCHI_NAVI_TEST_DATABASE_URL');
  });

  it('getTestDatabaseSupport는 shared memory 미지원 bootstrap을 구분해야 한다', async () => {
    delete process.env['ARCHI_NAVI_TEST_DATABASE_URL'];
    mockEnsureEmbeddedPostgresConnection.mockRejectedValue(
      new Error('embedded postgres 기동 실패: shmat(...) Operation not permitted'),
    );

    const { getTestDatabaseSupport } = await import('../test-embedded-postgres.js');
    const support = await getTestDatabaseSupport();

    expect(support.supported).toBe(false);
    expect(support.mode).toBe('embedded-postgres');
    expect(support.reasonCode).toBe('EMBEDDED_POSTGRES_SHARED_MEMORY_UNSUPPORTED');
    expect(support.remediation).toContain('shared memory');
  });
});
