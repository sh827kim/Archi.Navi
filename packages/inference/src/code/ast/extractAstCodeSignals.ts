/**
 * AST 기반 Code Signal 추출기 (Phase 2)
 * Phase 1(Regex)과 동일한 출력 형식을 사용하며, 정밀도와 confidence가 향상됨.
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2 AST 기반 정밀 추출
 * Phase 1과의 차이:
 *  - 변수/상수로 지정된 URL 추적 (data-flow analysis)
 *  - 멀티라인 어노테이션 정확 추출 (AST 구조 기반)
 *  - confidence +0.1~0.2 상향
 *  - 파싱 실패 시 graceful fallback (빈 결과 반환)
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { codeArtifacts, codeCallEdges, evidences, objects } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import type { CodeSignalOptions, CodeSignalResult, FileScanResult } from '../codeSignalExtractor';
import { scanJavaKotlinAst } from './astJavaKotlin';
import { scanTypeScriptAst } from './astTypeScript';
import { scanPythonAst } from './astPython';

// ─── 파일 탐색 ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    'target', '__pycache__', '.gradle', 'out', 'coverage',
]);

function findFiles(dir: string, predicate: (path: string) => boolean): string[] {
    const results: string[] = [];

    function walk(current: string) {
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }

        for (const entry of entries) {
            if (SKIP_DIRS.has(entry)) continue;
            const fullPath = join(current, entry);
            let stat;
            try {
                stat = statSync(fullPath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                walk(fullPath);
            } else if (stat.isFile() && predicate(fullPath)) {
                results.push(fullPath);
            }
        }
    }

    walk(dir);
    return results;
}

function findJavaKotlinFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => {
        const ext = extname(p).toLowerCase();
        return ext === '.java' || ext === '.kt';
    });
}

function findTypeScriptFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => {
        const ext = extname(p).toLowerCase();
        return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx';
    });
}

function findPythonFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => extname(p).toLowerCase() === '.py');
}

// ─── 서비스 매칭 ──────────────────────────────────────────────────────────────

function findOwnerServiceByPath(
    filePath: string,
    allServices: { id: string; name: string }[],
): string | null {
    const parts = filePath.replace(/\\/g, '/').split('/');

    for (let i = parts.length - 2; i >= 0; i--) {
        const segment = parts[i];
        if (!segment) continue;

        const exactMatch = allServices.find(
            (s) => s.name.toLowerCase() === segment.toLowerCase(),
        );
        if (exactMatch) return exactMatch.id;

        const normalizedSegment = segment.toLowerCase().replace(/[-_]/g, '');
        const normalizedMatch = allServices.find(
            (s) => s.name.toLowerCase().replace(/[-_]/g, '') === normalizedSegment,
        );
        if (normalizedMatch) return normalizedMatch.id;
    }

    return null;
}

// ─── DB 저장 로직 ─────────────────────────────────────────────────────────────

interface ProcessFileContext {
    db: DbClient;
    workspaceId: string;
    repoRoot: string;
    allServices: { id: string; name: string }[];
}

interface ProcessFileResult {
    skipped: boolean;
    isNew: boolean;
    signalCount: number;
}

async function processFile(
    filePath: string,
    scanResult: FileScanResult,
    ctx: ProcessFileContext,
): Promise<ProcessFileResult> {
    const { db, workspaceId, repoRoot, allServices } = ctx;

    const existing = await db
        .select({ id: codeArtifacts.id, sha256: codeArtifacts.sha256 })
        .from(codeArtifacts)
        .where(
            and(
                eq(codeArtifacts.workspaceId, workspaceId),
                eq(codeArtifacts.filePath, filePath),
            ),
        )
        .limit(1);

    const existingArtifact = existing[0];

    // SHA256 동일 → 스킵
    if (existingArtifact?.sha256 === scanResult.sha256) {
        return { skipped: true, isNew: false, signalCount: 0 };
    }

    let artifactId: string;
    let isNew = false;

    if (existingArtifact) {
        await db
            .delete(codeCallEdges)
            .where(eq(codeCallEdges.callerArtifactId, existingArtifact.id));
        await db
            .update(codeArtifacts)
            .set({ sha256: scanResult.sha256, updatedAt: new Date() })
            .where(eq(codeArtifacts.id, existingArtifact.id));
        artifactId = existingArtifact.id;
    } else {
        isNew = true;
        artifactId = generateId();
        const ownerObjectId = findOwnerServiceByPath(filePath, allServices);
        await db.insert(codeArtifacts).values({
            id: artifactId,
            workspaceId,
            language: scanResult.language,
            repoRoot,
            filePath,
            packageName: scanResult.packageName ?? null,
            ownerObjectId,
            sha256: scanResult.sha256,
        });
    }

    for (const signal of scanResult.signals) {
        const evidenceId = generateId();
        await db.insert(evidences).values({
            id: evidenceId,
            workspaceId,
            evidenceType: 'FILE',
            filePath,
            lineStart: signal.lineStart,
            lineEnd: signal.lineEnd,
            excerpt: signal.excerpt,
            metadata: {
                kind: signal.kind,
                confidence: signal.confidence,
                language: scanResult.language,
                phase: 2,
                ...signal.metadata,
            },
        });

        await db.insert(codeCallEdges).values({
            id: generateId(),
            workspaceId,
            callerArtifactId: artifactId,
            calleeSymbol: signal.symbol,
            weight: 1,
            evidenceId,
        });
    }

    return { skipped: false, isNew, signalCount: scanResult.signals.length };
}

// ─── 메인 추출 함수 ───────────────────────────────────────────────────────────

/**
 * AST 기반 Code Signal 추출 실행 (Phase 2)
 * Phase 1(extractCodeSignals)과 동일한 인터페이스, 동일한 저장 테이블 사용
 *
 * @param db - DB 클라이언트
 * @param options - 추출 옵션 (workspaceId, repoRoot)
 */
export async function extractAstCodeSignals(
    db: DbClient,
    options: CodeSignalOptions,
): Promise<CodeSignalResult> {
    const { workspaceId, repoRoot } = options;

    const allServices = await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'service'),
            ),
        );

    const ctx: ProcessFileContext = { db, workspaceId, repoRoot, allServices };
    const result: CodeSignalResult = {
        fileCount: 0,
        artifactCount: 0,
        signalCount: 0,
        skippedCount: 0,
        scanErrorCount: 0,
    };

    async function processAll(
        files: string[],
        scanner: (filePath: string, content: string) => FileScanResult | Promise<FileScanResult>,
    ) {
        for (const filePath of files) {
            let content: string;
            try {
                content = readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }

            result.fileCount++;

            let scanResult: FileScanResult;
            try {
                scanResult = await scanner(filePath, content);
            } catch {
                // AST 파싱 실패 시 스킵
                result.scanErrorCount = (result.scanErrorCount ?? 0) + 1;
                continue;
            }

            const fileResult = await processFile(filePath, scanResult, ctx);
            if (fileResult.skipped) {
                result.skippedCount++;
            } else {
                if (fileResult.isNew) result.artifactCount++;
                result.signalCount += fileResult.signalCount;
            }
        }
    }

    // 1. Java/Kotlin 파일 처리 (AST)
    await processAll(findJavaKotlinFiles(repoRoot), scanJavaKotlinAst);

    // 2. TypeScript/JavaScript 파일 처리 (AST)
    await processAll(findTypeScriptFiles(repoRoot), scanTypeScriptAst);

    // 3. Python 파일 처리 (AST)
    await processAll(findPythonFiles(repoRoot), scanPythonAst);

    return result;
}
