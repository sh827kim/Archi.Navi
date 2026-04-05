import postgres from 'postgres';

type SqlClient = ReturnType<typeof postgres>;

function createUtilitySql(url: string): SqlClient {
  return postgres(url, { max: 1, onnotice: () => {} });
}

export async function getPostgresDataDirectory(url: string): Promise<string | null> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === 'string' && actual.length > 0 ? actual : null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<'created' | 'exists'> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = createUtilitySql(url);
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return 'exists';

    await sql.unsafe(
      `create database "${databaseName}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`,
    );
    return 'created';
  } finally {
    await sql.end();
  }
}
