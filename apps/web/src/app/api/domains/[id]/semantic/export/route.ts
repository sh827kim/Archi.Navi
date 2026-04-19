/**
 * GET /api/domains/[id]/semantic/export — 도메인 의미 프로파일 다운로드 (JSON)
 * query: workspaceId, format (기본 json)
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
        const format = (req.nextUrl.searchParams.get('format') ?? 'json').toLowerCase();

        if (!workspaceId) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
                { status: 400 },
            );
        }
        if (format !== 'json') {
            return NextResponse.json(
                { success: false, error: { code: 'UNSUPPORTED_FORMAT', message: `지원하지 않는 format: ${format}` } },
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

        const filename = `domain-semantic-${profile.domainName || domainId}.json`
            .replace(/[^a-zA-Z0-9가-힣._-]/g, '_');

        return new NextResponse(JSON.stringify(profile, null, 2), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filename}"`,
            },
        });
    } catch (error) {
        console.error('[GET /api/domains/[id]/semantic/export]', error);
        return NextResponse.json(
            { success: false, error: { code: 'INTERNAL_ERROR', message: '프로파일 다운로드 중 오류가 발생했습니다.' } },
            { status: 500 },
        );
    }
}
