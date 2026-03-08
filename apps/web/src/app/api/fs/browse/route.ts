/**
 * GET /api/fs/browse — 서버 측 디렉토리 자동완성
 * prefix 경로를 받아 하위 디렉토리 목록을 반환
 */
import { type NextRequest, NextResponse } from 'next/server';
import { readdirSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';

/** 항상 무시할 디렉토리 */
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    'target', '__pycache__', '.gradle', 'out', 'coverage',
    '.cache', '.DS_Store',
]);

/** 최대 반환 항목 수 */
const MAX_RESULTS = 30;

export async function GET(req: NextRequest) {
    try {
        const prefix = req.nextUrl.searchParams.get('prefix')?.trim();
        if (!prefix) {
            return NextResponse.json({ error: 'prefix is required' }, { status: 400 });
        }

        // 절대 경로만 허용 (보안)
        if (!prefix.startsWith('/')) {
            return NextResponse.json({ error: '절대 경로만 지원합니다' }, { status: 400 });
        }

        // 경로 정규화 (상위 탐색 차단)
        const normalized = resolve(prefix);

        // prefix가 기존 디렉토리인지, 아니면 부분 입력인지 판별
        let parentDir: string;
        let filter: string;

        try {
            const stat = statSync(normalized);
            if (stat.isDirectory()) {
                // 정확한 디렉토리 → 하위 목록
                parentDir = normalized;
                filter = '';
            } else {
                // 파일이면 부모 디렉토리 탐색
                parentDir = dirname(normalized);
                filter = basename(normalized).toLowerCase();
            }
        } catch {
            // 존재하지 않는 경로 → 부모 디렉토리에서 prefix 필터
            parentDir = dirname(normalized);
            filter = basename(normalized).toLowerCase();
        }

        let entries: string[];
        try {
            entries = readdirSync(parentDir);
        } catch {
            return NextResponse.json({ dirs: [], parent: parentDir });
        }

        const dirs: Array<{ name: string; path: string }> = [];

        for (const entry of entries) {
            if (SKIP_DIRS.has(entry)) continue;
            if (entry.startsWith('.')) continue;
            if (filter && !entry.toLowerCase().startsWith(filter)) continue;

            try {
                const fullPath = resolve(parentDir, entry);
                const stat = statSync(fullPath);
                if (stat.isDirectory()) {
                    dirs.push({ name: entry, path: fullPath });
                }
            } catch {
                continue;
            }

            if (dirs.length >= MAX_RESULTS) break;
        }

        dirs.sort((a, b) => a.name.localeCompare(b.name));

        return NextResponse.json({ dirs, parent: parentDir });
    } catch (error) {
        console.error('[GET /api/fs/browse]', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
