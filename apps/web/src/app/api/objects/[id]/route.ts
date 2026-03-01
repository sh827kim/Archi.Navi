/**
 * GET    /api/objects/[id] — Object 단건 조회 (relations + children 포함)
 * PATCH  /api/objects/[id] — visibility / displayName / description 수정
 * DELETE /api/objects/[id] — Object 삭제
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, objects, objectRelations } from '@archi-navi/db';
import { eq, and, or } from 'drizzle-orm';

/* ── GET: Object + 인바운드/아웃바운드 관계 + 자식 ── */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;
        const { searchParams } = req.nextUrl;
        const workspaceId = searchParams.get('workspaceId');
        if (!workspaceId) {
            return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
        }

        const db = await getDb();

        // Object 조회
        const [obj] = await db
            .select()
            .from(objects)
            .where(and(eq(objects.id, id), eq(objects.workspaceId, workspaceId)))
            .limit(1);

        if (!obj) {
            return NextResponse.json({ error: 'Not Found' }, { status: 404 });
        }

        // 이 Object와 관련된 모든 관계 (APPROVED)
        const relations = await db
            .select({
                id: objectRelations.id,
                relationType: objectRelations.relationType,
                subjectObjectId: objectRelations.subjectObjectId,
                objectId: objectRelations.objectId,
            })
            .from(objectRelations)
            .where(
                and(
                    eq(objectRelations.workspaceId, workspaceId),
                    eq(objectRelations.status, 'APPROVED'),
                    or(
                        eq(objectRelations.subjectObjectId, id),
                        eq(objectRelations.objectId, id),
                    ),
                ),
            );

        // 자식 Object 목록 (COMPOUND일 때)
        const children = await db
            .select({
                id: objects.id,
                name: objects.name,
                displayName: objects.displayName,
                objectType: objects.objectType,
                granularity: objects.granularity,
            })
            .from(objects)
            .where(and(eq(objects.workspaceId, workspaceId), eq(objects.parentId, id)));

        // Inbound/Outbound 분리
        const outbound = relations.filter((r) => r.subjectObjectId === id);
        const inbound = relations.filter((r) => r.objectId === id);

        // 연결된 Object ID 수집 → 이름 조회
        const relatedIds = new Set([
            ...outbound.map((r) => r.objectId),
            ...inbound.map((r) => r.subjectObjectId),
        ]);

        const relatedObjects =
            relatedIds.size > 0
                ? await db
                      .select({ id: objects.id, name: objects.name, displayName: objects.displayName, objectType: objects.objectType })
                      .from(objects)
                      .where(eq(objects.workspaceId, workspaceId))
                : [];

        const relatedMap = new Map(relatedObjects.map((o) => [o.id, o]));

        return NextResponse.json({
            ...obj,
            outbound: outbound.map((r) => ({
                id: r.id,
                relationType: r.relationType,
                targetId: r.objectId,
                targetName: relatedMap.get(r.objectId)?.displayName ?? relatedMap.get(r.objectId)?.name ?? r.objectId,
                targetType: relatedMap.get(r.objectId)?.objectType ?? 'unknown',
            })),
            inbound: inbound.map((r) => ({
                id: r.id,
                relationType: r.relationType,
                sourceId: r.subjectObjectId,
                sourceName: relatedMap.get(r.subjectObjectId)?.displayName ?? relatedMap.get(r.subjectObjectId)?.name ?? r.subjectObjectId,
                sourceType: relatedMap.get(r.subjectObjectId)?.objectType ?? 'unknown',
            })),
            children,
        });
    } catch (error) {
        console.error('[GET /api/objects/[id]]', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/* ── PATCH: visibility / displayName / description 수정 ── */
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;
        const body = (await req.json()) as {
            workspaceId?: string;
            visibility?: string;
            displayName?: string | null;
            description?: string | null;
        };

        const workspaceId = body.workspaceId;
        if (!workspaceId) {
            return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
        }
        const db = await getDb();

        // 업데이트할 필드 동적 구성
        const updates: Record<string, string | null> = {};
        if (body.visibility !== undefined) updates.visibility = body.visibility;
        if ('displayName' in body) updates.displayName = body.displayName ?? null;
        if ('description' in body) updates.description = body.description ?? null;

        if (Object.keys(updates).length === 0) {
            return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        }

        await db
            .update(objects)
            .set(updates)
            .where(and(eq(objects.id, id), eq(objects.workspaceId, workspaceId)));

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('[PATCH /api/objects/[id]]', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/* ── DELETE: Object 삭제 ── */
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;
        const { searchParams } = req.nextUrl;
        const workspaceId = searchParams.get('workspaceId');
        if (!workspaceId) {
            return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
        }

        const db = await getDb();
        await db
            .delete(objects)
            .where(and(eq(objects.id, id), eq(objects.workspaceId, workspaceId)));

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('[DELETE /api/objects/[id]]', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
