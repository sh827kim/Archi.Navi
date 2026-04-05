import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { asc } from 'drizzle-orm';
import { workspaces, type DbClient } from '@archi-navi/db';

interface WorkspaceSnapshotRow {
  id: string;
  name: string;
}

function getWorkspaceSnapshotPath(): string | null {
  const dataDir = process.env['ARCHI_NAVI_DB_DATA_DIR'] ?? '.archi-navi/dev-db';
  const resolvedDataDir = resolve(process.cwd(), dataDir);
  return resolve(dirname(resolvedDataDir), 'workspaces.snapshot.json');
}

export async function persistWorkspaceSnapshot(db: DbClient): Promise<void> {
  const snapshotPath = getWorkspaceSnapshotPath();
  if (!snapshotPath) return;

  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt));

  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(rows, null, 2), 'utf-8');
}

export async function restoreWorkspaceSnapshotIfNeeded(db: DbClient): Promise<number> {
  const snapshotPath = getWorkspaceSnapshotPath();
  if (!snapshotPath || !existsSync(snapshotPath)) return 0;

  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .limit(1);
  if (existing.length > 0) return 0;

  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as WorkspaceSnapshotRow[];
    const rows = Array.isArray(parsed)
      ? parsed.filter(
          (row): row is WorkspaceSnapshotRow =>
            !!row
            && typeof row.id === 'string'
            && row.id.length > 0
            && typeof row.name === 'string'
            && row.name.length > 0,
        )
      : [];

    if (rows.length === 0) return 0;

    await db.insert(workspaces).values(rows);
    return rows.length;
  } catch {
    return 0;
  }
}
