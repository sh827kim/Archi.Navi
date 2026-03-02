/**
 * DELETE /api/relations/[id] — 관계 삭제
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, objectRelations } from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import {
  applyRollupChanges,
  createRelationChangeEvent,
  isApprovedBaseRelation,
} from '@/lib/rollup-change-events';

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = await getDb();

    const [relation] = await db
      .select({
        workspaceId: objectRelations.workspaceId,
        relationType: objectRelations.relationType,
        subjectObjectId: objectRelations.subjectObjectId,
        objectId: objectRelations.objectId,
        status: objectRelations.status,
        isDerived: objectRelations.isDerived,
      })
      .from(objectRelations)
      .where(eq(objectRelations.id, id))
      .limit(1);

    if (!relation) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404 });
    }

    await db.delete(objectRelations).where(eq(objectRelations.id, id));

    if (isApprovedBaseRelation(relation.status, relation.isDerived)) {
      await applyRollupChanges(db, relation.workspaceId, [
        createRelationChangeEvent('DELETED', {
          relationType: relation.relationType,
          subjectObjectId: relation.subjectObjectId,
          objectId: relation.objectId,
        }),
      ]);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/relations/[id]]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
