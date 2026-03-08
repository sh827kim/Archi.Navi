/**
 * GET /api/scan/paths — 워크스페이스에 등록된 서비스의 scanPath 목록 반환
 * 이전 스캔 경로 복원 + 재스캔용 드롭다운에 사용
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { and, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
    try {
        const workspaceId = req.nextUrl.searchParams.get('workspaceId');
        if (!workspaceId) {
            return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
        }

        const db = await getDb();
        const services = await db
            .select({ metadata: objects.metadata })
            .from(objects)
            .where(
                and(
                    eq(objects.workspaceId, workspaceId),
                    eq(objects.objectType, 'service'),
                ),
            );

        // metadata.scanPath 추출 + 중복 제거
        const pathSet = new Set<string>();
        for (const svc of services) {
            const meta = svc.metadata as Record<string, unknown> | null;
            const scanPath = meta?.['scanPath'];
            if (typeof scanPath === 'string' && scanPath.length > 0) {
                pathSet.add(scanPath);
            }
        }

        // 경로에서 부모 디렉토리(워크스페이스 폴더) 추출
        const parentDirs = new Set<string>();
        for (const p of pathSet) {
            const segments = p.replace(/\\/g, '/').split('/');
            if (segments.length >= 2) {
                segments.pop();
                parentDirs.add(segments.join('/'));
            }
        }

        return NextResponse.json({
            /** 개별 서비스 스캔 경로 */
            paths: Array.from(pathSet).sort(),
            /** 부모 디렉토리 (워크스페이스 폴더 추정) */
            parentDirs: Array.from(parentDirs).sort(),
        });
    } catch (error) {
        console.error('[GET /api/scan/paths]', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
