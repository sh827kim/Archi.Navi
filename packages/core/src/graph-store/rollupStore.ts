/**
 * Rollup 그래프 데이터 조회
 * DB에서 object_rollups를 읽어 그래프 탐색에 필요한 데이터를 제공
 */
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objectRollups, objectRollupProvenances, objectRelations } from '@archi-navi/db';
import type { RollupLevel } from '@archi-navi/shared';

/**
 * 특정 generation의 rollup edge 목록 조회
 */
export async function getRollupEdges(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  rollupLevel: RollupLevel,
) {
  const edges = await db
    .select()
    .from(objectRollups)
    .where(
      and(
        eq(objectRollups.workspaceId, workspaceId),
        eq(objectRollups.generationVersion, generationVersion),
        eq(objectRollups.rollupLevel, rollupLevel),
      ),
    );

  if (edges.length === 0) return [];

  const provenanceRows = await db
    .select({
      rollupId: objectRollupProvenances.rollupId,
      baseRelationId: objectRollupProvenances.baseRelationId,
    })
    .from(objectRollupProvenances)
    .where(
      and(
        eq(objectRollupProvenances.workspaceId, workspaceId),
        eq(objectRollupProvenances.generationVersion, generationVersion),
        inArray(
          objectRollupProvenances.rollupId,
          edges.map((edge) => edge.id),
        ),
      ),
    );

  const baseRelationIdsByRollupId = new Map<string, string[]>();
  for (const row of provenanceRows) {
    const existing = baseRelationIdsByRollupId.get(row.rollupId) ?? [];
    existing.push(row.baseRelationId);
    baseRelationIdsByRollupId.set(row.rollupId, existing);
  }

  return edges.map((edge) => ({
    ...edge,
    baseRelationIds: baseRelationIdsByRollupId.get(edge.id) ?? [],
  }));
}

/**
 * 확정된 base relation 목록 조회
 */
export async function getBaseRelations(
  db: DbClient,
  workspaceId: string,
  subjectObjectId?: string,
) {
  const conditions = [eq(objectRelations.workspaceId, workspaceId)];
  if (subjectObjectId) {
    conditions.push(eq(objectRelations.subjectObjectId, subjectObjectId));
  }
  return db.select().from(objectRelations).where(and(...conditions));
}
