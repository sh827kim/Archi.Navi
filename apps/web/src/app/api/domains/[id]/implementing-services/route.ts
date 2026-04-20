/**
 * GET /api/domains/[id]/implementing-services
 *   ?workspaceId=<uuid>
 *
 * 해당 도메인을 구현(implements)하는 서비스 목록 + 비중(confidence).
 * objectRelations 의 source='DISCOVERY' + relationType='implements' 행 기반.
 * 결과는 confidence 내림차순.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, objectRelations, objects } from '@archi-navi/db';

export async function GET(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    try {
        const { id: domainId } = await ctx.params;
        const workspaceId = new URL(req.url).searchParams.get('workspaceId');
        if (!workspaceId) {
            return NextResponse.json(
                {
                    success: false,
                    error: { code: 'BAD_REQUEST', message: 'workspaceId 쿼리 파라미터가 필요합니다.' },
                },
                { status: 400 },
            );
        }

        const db = await getDb();
        const rows = await db
            .select({
                serviceId: objectRelations.subjectObjectId,
                serviceName: objects.name,
                serviceDisplayName: objects.displayName,
                confidence: objectRelations.confidence,
                metadata: objectRelations.metadata,
            })
            .from(objectRelations)
            .innerJoin(objects, eq(objects.id, objectRelations.subjectObjectId))
            .where(
                and(
                    eq(objectRelations.workspaceId, workspaceId),
                    eq(objectRelations.objectId, domainId),
                    eq(objectRelations.relationType, 'implements'),
                    eq(objectRelations.source, 'DISCOVERY'),
                ),
            )
            .orderBy(desc(objectRelations.confidence));

        const implementingServices = rows.map((r) => {
            const meta = (r.metadata ?? {}) as { childTotal?: number; childInDomain?: number };
            return {
                serviceObjectId: r.serviceId,
                serviceName: r.serviceDisplayName ?? r.serviceName,
                childInDomain: meta.childInDomain ?? 0,
                childTotal: meta.childTotal ?? 0,
                confidence: r.confidence ?? 0,
            };
        });

        return NextResponse.json({ success: true, data: { implementingServices } });
    } catch (error) {
        console.error('[GET /api/domains/[id]/implementing-services]', error);
        return NextResponse.json(
            {
                success: false,
                error: { code: 'INTERNAL_ERROR', message: '조회 중 오류가 발생했습니다.' },
            },
            { status: 500 },
        );
    }
}
