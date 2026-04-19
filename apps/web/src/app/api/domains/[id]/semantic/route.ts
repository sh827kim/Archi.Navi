/**
 * GET /api/domains/[id]/semantic — 저장된 도메인 의미 프로파일 조회
 * query: workspaceId
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { getDomainSemanticProfile } from '@archi-navi/inference';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id: domainId } = await params;
        const workspaceId = req.nextUrl.searchParams.get('workspaceId');
        if (!workspaceId) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
                { status: 400 },
            );
        }

        const db = await getDb();
        const profile = await getDomainSemanticProfile(db, { workspaceId, domainId });

        if (!profile) {
            return NextResponse.json(
                { success: false, error: { code: 'NOT_FOUND', message: '저장된 의미 프로파일이 없습니다.' } },
                { status: 404 },
            );
        }

        return NextResponse.json({ success: true, data: profile });
    } catch (error) {
        console.error('[GET /api/domains/[id]/semantic]', error);
        return NextResponse.json(
            { success: false, error: { code: 'INTERNAL_ERROR', message: '프로파일 조회 중 오류가 발생했습니다.' } },
            { status: 500 },
        );
    }
}
