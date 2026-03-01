/**
 * Next.js Instrumentation Hook (Node.js runtime 전용)
 * 서버 시작 시 한 번 실행 — DB 마이그레이션 + 기본 워크스페이스 생성
 */
import { resolve } from 'path';
import { existsSync } from 'fs';
import { DEFAULT_WORKSPACE_ID } from '@archi-navi/shared';

function resolveMigrationsFolder(): string {
  if (process.env['MIGRATIONS_FOLDER']) {
    return process.env['MIGRATIONS_FOLDER'];
  }

  const candidates = [
    resolve(process.cwd(), '../../packages/db/src/migrations'),
    resolve(process.cwd(), 'node_modules/@archi-navi/db/src/migrations'),
    resolve(process.cwd(), '../node_modules/@archi-navi/db/src/migrations'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

/** 마이그레이션 폴더 — env > monorepo 경로 > 설치된 @archi-navi/db 경로 */
const MIGRATIONS_FOLDER = resolveMigrationsFolder();

export async function register() {
  const { getDb } = await import('@archi-navi/db');
  const { migrate } = await import('drizzle-orm/pglite/migrator');

  const db = await getDb();

  // 마이그레이션 적용
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('[archi-navi] DB 마이그레이션 완료');
  } catch (e) {
    console.warn('[archi-navi] 마이그레이션 경고 (이미 적용됨):', (e as Error).message);
  }

  // 기본 워크스페이스 생성 (없으면)
  try {
    const { workspaces } = await import('@archi-navi/db');
    const { eq } = await import('drizzle-orm');

    const existing = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));

    if (existing.length === 0) {
      await db.insert(workspaces).values({
        id: DEFAULT_WORKSPACE_ID,
        name: 'Default Workspace',
      });
      console.log('[archi-navi] 기본 워크스페이스 생성 완료');
    }
  } catch (e) {
    console.warn('[archi-navi] 워크스페이스 초기화 경고:', (e as Error).message);
  }
}
