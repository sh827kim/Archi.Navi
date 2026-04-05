/**
 * Next.js Instrumentation Hook (Node.js runtime 전용)
 * 서버 시작 시 한 번 실행 — DB bootstrap 이후 snapshot 복구
 */

export async function register() {
  const { getDb } = await import('@archi-navi/db');
  const { restoreWorkspaceSnapshotIfNeeded } = await import('@/lib/workspace-snapshot');

  const db = await getDb();

  const restoredWorkspaceCount = await restoreWorkspaceSnapshotIfNeeded(db);
  if (restoredWorkspaceCount > 0) {
    console.log(`[archi-navi] 워크스페이스 snapshot 복구 완료 (${restoredWorkspaceCount}개)`);
  }
}
