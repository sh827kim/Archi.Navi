/**
 * Next.js Instrumentation Hook (Node.js runtime 전용)
 * 서버 시작 시 한 번 실행 — DB 마이그레이션
 */
import { resolve } from 'path';
import { existsSync } from 'fs';

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

  return candidates[0]!;
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
}
