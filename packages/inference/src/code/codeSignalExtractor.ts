/**
 * Code Signal 추출기 (Phase 1: Regex 기반)
 * Java/Kotlin, TypeScript/JS, Python 소스코드에서 구조 신호를 추출하여
 * code_artifacts + code_call_edges + evidences 테이블에 저장한다.
 *
 * 설계 참조: docs/03-inference-engine.md §6.1 Phase 1 Regex 기반 패턴 매칭
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { codeArtifacts, codeCallEdges, evidences, objects } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { scanJavaKotlin, scanMyBatisXml } from './scanners/javaKotlin';
import { scanTypeScript } from './scanners/typeScript';
import { scanPython } from './scanners/python';

// ─── 공유 타입 ────────────────────────────────────────────────────────────────

/** 추출된 신호 종류 */
export type SignalKind =
    | 'expose'       // API 노출 (@GetMapping, Express route 등)
    | 'call'         // HTTP 호출 (RestTemplate, fetch 등)
    | 'produce'      // Kafka 발행
    | 'consume'      // Kafka 수신
    | 'db_read'      // DB 읽기 (SELECT)
    | 'db_write'     // DB 쓰기 (INSERT/UPDATE/DELETE)
    | 'db_mapping';  // JPA @Table 매핑

/** 파일에서 추출된 단일 신호 */
export interface ExtractedSignal {
    kind: SignalKind;
    /** 호출 대상 심볼 (URL path, topic name, table name, service name 등) */
    symbol: string;
    lineStart: number;
    lineEnd: number;
    /** 해당 라인의 코드 발췌 */
    excerpt: string;
    confidence: number;
    metadata: Record<string, unknown>;
}

/** 파일 스캔 결과 */
export interface FileScanResult {
    language: 'java' | 'kotlin' | 'typescript' | 'javascript' | 'python';
    sha256: string;
    packageName?: string;
    signals: ExtractedSignal[];
}

// ─── 추출기 옵션 / 결과 ───────────────────────────────────────────────────────

/** extractCodeSignals 입력 옵션 */
export interface CodeSignalOptions {
    workspaceId: string;
    /** 탐색 대상 리포 루트 경로 */
    repoRoot: string;
    /** true면 SHA256 동일 파일도 강제로 재처리 */
    forceRescan?: boolean;
    /** 지정 시 해당 파일 경로들만 추출 대상으로 제한 */
    targetFilePaths?: string[];
}

/** extractCodeSignals 반환 결과 */
export interface CodeSignalResult {
    /** 처리한 총 파일 수 (스킵 포함) */
    fileCount: number;
    /** 새로 생성된 code_artifacts 수 */
    artifactCount: number;
    /** 추출된 신호 수 (code_call_edges 기준) */
    signalCount: number;
    /** SHA256 미변경으로 스킵된 파일 수 */
    skippedCount: number;
    /** 스캐너/파서 오류로 파일 단위 스킵된 수 (주로 AST 모드에서 사용) */
    scanErrorCount?: number;
    /** 스캐너/파서 오류가 발생한 파일 경로 목록 (주로 AST 모드에서 사용) */
    scanErrorFilePaths?: string[];
}

// ─── 파일 탐색 ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    'target', '__pycache__', '.gradle', 'out', 'coverage',
]);

/** 디렉토리를 재귀 탐색하여 조건에 맞는 파일 목록 반환 */
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

/** Java/Kotlin 소스 파일 탐색 */
function findJavaKotlinFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => {
        const ext = extname(p).toLowerCase();
        return ext === '.java' || ext === '.kt';
    });
}

/** MyBatis XML mapper 파일 탐색 (내용 기반 필터링) */
function findMyBatisXmlFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => {
        if (extname(p).toLowerCase() !== '.xml') return false;
        try {
            // 파일 앞부분만 읽어 MyBatis mapper 여부 확인
            const head = readFileSync(p, 'utf-8').slice(0, 2000);
            return head.includes('<mapper ') || head.includes('<mapper\n');
        } catch {
            return false;
        }
    });
}

/** TypeScript/JavaScript 소스 파일 탐색 */
function findTypeScriptFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => {
        const ext = extname(p).toLowerCase();
        return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx';
    });
}

/** Python 소스 파일 탐색 */
function findPythonFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (p) => extname(p).toLowerCase() === '.py');
}

// ─── 서비스 매칭 (ownerObjectId 휴리스틱) ────────────────────────────────────

/**
 * 파일 경로의 디렉토리 세그먼트에서 서비스 이름 매칭 시도
 * 정확 매칭 → 정규화 매칭(하이픈/언더스코어 제거) 순서로 시도
 */
function findOwnerServiceByPath(
    filePath: string,
    allServices: { id: string; name: string }[],
): string | null {
    const parts = filePath.replace(/\\/g, '/').split('/');

    for (let i = parts.length - 2; i >= 0; i--) {
        const segment = parts[i];
        if (!segment) continue;

        // 정확 매칭 (대소문자 무시)
        const exactMatch = allServices.find(
            (s) => s.name.toLowerCase() === segment.toLowerCase(),
        );
        if (exactMatch) return exactMatch.id;

        // 정규화 매칭 (하이픈/언더스코어 제거)
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
    forceRescan: boolean;
}

interface ProcessFileResult {
    skipped: boolean;
    isNew: boolean;
    signalCount: number;
}

async function deleteArtifactEdgesAndEvidences(
    db: DbClient,
    workspaceId: string,
    artifactId: string,
) {
    const existingEdgeRows = await db
        .select({ evidenceId: codeCallEdges.evidenceId })
        .from(codeCallEdges)
        .where(
            and(
                eq(codeCallEdges.workspaceId, workspaceId),
                eq(codeCallEdges.callerArtifactId, artifactId),
            ),
        );

    await db
        .delete(codeCallEdges)
        .where(
            and(
                eq(codeCallEdges.workspaceId, workspaceId),
                eq(codeCallEdges.callerArtifactId, artifactId),
            ),
        );

    const evidenceIds = Array.from(
        new Set(
            existingEdgeRows
                .map((row) => row.evidenceId)
                .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
    );

    if (evidenceIds.length === 0) return;

    await db
        .delete(evidences)
        .where(
            and(
                eq(evidences.workspaceId, workspaceId),
                inArray(evidences.id, evidenceIds),
            ),
        );
}

/**
 * 파일 스캔 결과를 DB에 저장
 * - SHA256 동일 → 스킵
 * - SHA256 변경 → 기존 code_call_edges 삭제 후 재생성
 * - 신규 → code_artifact 생성 + code_call_edges + evidences 삽입
 */
async function processFile(
    filePath: string,
    scanResult: FileScanResult,
    ctx: ProcessFileContext,
): Promise<ProcessFileResult> {
    const { db, workspaceId, repoRoot, allServices, forceRescan } = ctx;

    // 기존 code_artifact 조회
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
    if (!forceRescan && existingArtifact?.sha256 === scanResult.sha256) {
        return { skipped: true, isNew: false, signalCount: 0 };
    }

    let artifactId: string;
    let isNew = false;

    if (existingArtifact) {
        // SHA256 변경 → 기존 edges 삭제 후 sha256 업데이트
        await deleteArtifactEdgesAndEvidences(db, workspaceId, existingArtifact.id);
        await db
            .update(codeArtifacts)
            .set({ sha256: scanResult.sha256, updatedAt: new Date() })
            .where(eq(codeArtifacts.id, existingArtifact.id));
        artifactId = existingArtifact.id;
    } else {
        // 신규 파일 → code_artifact 생성
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

    // 각 신호마다 evidence + code_call_edge 삽입
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
 * Code Signal 추출 실행
 * 1. repoRoot에서 언어별 소스 파일 탐색
 * 2. SHA256 해시 비교 → 변경된 파일만 처리 (증분 스캔)
 * 3. 파일별 정규식 매칭 → 신호 추출
 * 4. code_artifacts / code_call_edges / evidences 저장
 *
 * @param db - DB 클라이언트
 * @param options - 추출 옵션 (workspaceId, repoRoot)
 */
export async function extractCodeSignals(
    db: DbClient,
    options: CodeSignalOptions,
): Promise<CodeSignalResult> {
    const { workspaceId, repoRoot } = options;
    const forceRescan = options.forceRescan === true;
    const targetFileSet = options.targetFilePaths
        ? new Set(options.targetFilePaths.map((path) => path.replace(/\\/g, '/')))
        : null;

    // 워크스페이스 서비스 목록 미리 조회 (ownerObjectId 매칭용)
    const allServices = await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'service'),
            ),
        );

    const ctx: ProcessFileContext = { db, workspaceId, repoRoot, allServices, forceRescan };
    const result: CodeSignalResult = {
        fileCount: 0,
        artifactCount: 0,
        signalCount: 0,
        skippedCount: 0,
    };

    function filterTargetFiles(files: string[]): string[] {
        if (!targetFileSet) return files;
        return files.filter((filePath) => targetFileSet.has(filePath.replace(/\\/g, '/')));
    }

    /**
     * 파일 목록을 순회하며 스캔 결과를 처리하는 헬퍼
     */
    async function processAll(
        files: string[],
        scanner: (filePath: string, content: string) => FileScanResult | FileScanResult[],
    ) {
        for (const filePath of files) {
            let content: string;
            try {
                content = readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }

            result.fileCount++;
            const scanOutput = scanner(filePath, content);
            const scanResults = Array.isArray(scanOutput) ? scanOutput : [scanOutput];

            for (const scanResult of scanResults) {
                const fileResult = await processFile(filePath, scanResult, ctx);
                if (fileResult.skipped) {
                    result.skippedCount++;
                } else {
                    if (fileResult.isNew) result.artifactCount++;
                    result.signalCount += fileResult.signalCount;
                }
            }
        }
    }

    // 1. Java/Kotlin 파일 처리
    await processAll(filterTargetFiles(findJavaKotlinFiles(repoRoot)), scanJavaKotlin);

    // 2. MyBatis XML 파일 처리
    await processAll(filterTargetFiles(findMyBatisXmlFiles(repoRoot)), scanMyBatisXml);

    // 3. TypeScript/JavaScript 파일 처리
    await processAll(filterTargetFiles(findTypeScriptFiles(repoRoot)), scanTypeScript);

    // 4. Python 파일 처리
    await processAll(filterTargetFiles(findPythonFiles(repoRoot)), scanPython);

    return result;
}
