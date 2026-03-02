/**
 * GET /api/relations — Relation 목록 조회
 * POST /api/relations — Relation 등록 (APPROVED 직접 등록)
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { objectRelations } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { applyRollupChanges, createRelationChangeEvent } from '@/lib/rollup-change-events';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const status = searchParams.get('status') ?? 'APPROVED';

    const db = await getDb();
    const result = await db
      .select()
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.workspaceId, workspaceId),
          eq(objectRelations.status, status as 'APPROVED' | 'REJECTED' | 'PENDING'),
        ),
      );

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/relations]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      workspaceId?: string;
      subjectObjectId: string;
      relationType: string;
      objectId: string;
      confidence?: number;
    };

    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const id = generateId();
    const db = await getDb();
    const relationType = body.relationType as
      | 'call'
      | 'expose'
      | 'read'
      | 'write'
      | 'produce'
      | 'consume'
      | 'depend_on';

    await db.insert(objectRelations).values({
      id,
      workspaceId,
      subjectObjectId: body.subjectObjectId,
      relationType,
      objectId: body.objectId,
      confidence: body.confidence ?? 1.0,
      status: 'APPROVED',
      metadata: {},
    });

    await applyRollupChanges(db, workspaceId, [
      createRelationChangeEvent('APPROVED', {
        relationType,
        subjectObjectId: body.subjectObjectId,
        objectId: body.objectId,
      }),
    ]);

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/relations]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
