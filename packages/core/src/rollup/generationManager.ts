/**
 * Generation 관리
 * ACTIVE generation 조회, 새 generation 생성, ARCHIVED 전환
 */
import { eq, and, desc } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { rollupGenerations } from '@archi-navi/db';

/**
 * 현재 ACTIVE generation_version 반환
 * ACTIVE가 없으면 null 반환
 */
export async function getActiveGeneration(
  db: DbClient,
  workspaceId: string,
): Promise<number | null> {
  const result = await db
    .select({ generationVersion: rollupGenerations.generationVersion })
    .from(rollupGenerations)
    .where(
      and(
        eq(rollupGenerations.workspaceId, workspaceId),
        eq(rollupGenerations.status, 'ACTIVE'),
      ),
    )
    .orderBy(desc(rollupGenerations.generationVersion))
    .limit(1);

  return result[0]?.generationVersion ?? null;
}

/**
 * 새 generation 생성 (status=BUILDING)
 */
export async function createNewGeneration(
  db: DbClient,
  workspaceId: string,
): Promise<number> {
  const current = await getActiveGeneration(db, workspaceId);
  const newVersion = (current ?? 0) + 1;

  await db.insert(rollupGenerations).values({
    workspaceId,
    generationVersion: newVersion,
    status: 'BUILDING',
    meta: {},
  });

  return newVersion;
}

/**
 * generation meta 업데이트 (증분 리빌드 정보 기록)
 */
export async function updateGenerationMeta(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  metaPatch: Record<string, unknown>,
): Promise<void> {
  const result = await db
    .select({ meta: rollupGenerations.meta })
    .from(rollupGenerations)
    .where(
      and(
        eq(rollupGenerations.workspaceId, workspaceId),
        eq(rollupGenerations.generationVersion, generationVersion),
      ),
    );

  const current = result[0];
  if (!current) return;

  const mergedMeta = { ...(current.meta as Record<string, unknown>), ...metaPatch };
  await db
    .update(rollupGenerations)
    .set({ meta: mergedMeta })
    .where(
      and(
        eq(rollupGenerations.workspaceId, workspaceId),
        eq(rollupGenerations.generationVersion, generationVersion),
      ),
    );
}

/**
 * generation을 ACTIVE로 전환하고 이전 ACTIVE는 ARCHIVED로 변경
 */
export async function activateGeneration(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
): Promise<void> {
  // 기존 ACTIVE를 ARCHIVED로 변경
  await db
    .update(rollupGenerations)
    .set({ status: 'ARCHIVED' })
    .where(
      and(
        eq(rollupGenerations.workspaceId, workspaceId),
        eq(rollupGenerations.status, 'ACTIVE'),
      ),
    );

  // 새 generation ACTIVE로 전환
  await db
    .update(rollupGenerations)
    .set({ status: 'ACTIVE', builtAt: new Date() })
    .where(
      and(
        eq(rollupGenerations.workspaceId, workspaceId),
        eq(rollupGenerations.generationVersion, generationVersion),
      ),
    );
}
