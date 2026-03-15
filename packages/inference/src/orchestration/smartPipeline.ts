/**
 * Smart 추론 파이프라인 — 3-Phase 오케스트레이션
 *
 * Phase 1: OpenAPI spec → provider endpoint 확정 (무료)
 * Phase 2: Config files → LLM → Compound 의존성 그래프 (저비용)
 * Phase 3: consumer로 확인된 서비스만 → LLM → endpoint-level call 추출 (집중)
 *
 * Phase 2에서 consumer로 판정된 서비스에 대해서만 Phase 3을 실행하여
 * LLM 비용을 최소화한다.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative, basename } from 'path';
import { eq, and, or } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects, relationCandidates, evidences, relationCandidateEvidences } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { importOpenApiSpecs, type OpenApiImportResult } from '../openapi/openApiImporter';
import {
    buildConfigAnalysisPrompt,
    type ConfigAnalysisContext,
    type ConfigAnalysisResult,
    type ConfigDependency,
} from '../llm/configAnalyzerPrompts';
import {
    buildCallExtractionPrompt,
    type CallExtractionContext,
    type CallExtractionResult,
    type ExtractedCall,
} from '../llm/callExtractorPrompts';

// ── 타입 ──────────────────────────────────────────────

/** LLM 호출 추상화: 프롬프트 → 구조화된 JSON 응답 */
export type LlmGenerateFn<T> = (prompt: string) => Promise<T>;

/** Smart 파이프라인 옵션 */
export interface SmartPipelineOptions {
    workspaceId: string;
    repoRoots: string[];
    /** Phase 2용 LLM 함수 (config → compound deps) */
    generateConfigAnalysis: LlmGenerateFn<ConfigAnalysisResult>;
    /** Phase 3용 LLM 함수 (source → endpoint calls) */
    generateCallExtraction: LlmGenerateFn<CallExtractionResult>;
    /** Phase 3 소스코드 프리필터 키워드 (기본: HTTP client imports) */
    sourceFilterKeywords?: string[];
}

/** Smart 파이프라인 결과 */
export interface SmartPipelineResult {
    phase1: {
        openApi: OpenApiImportResult;
    };
    phase2: {
        /** LLM에 분석 요청한 서비스 수 */
        analyzedServiceCount: number;
        /** 발견된 Compound 의존성 수 */
        compoundDependencyCount: number;
        /** consumer로 판정된 서비스 ID 목록 */
        consumerServiceIds: string[];
    };
    phase3: {
        /** LLM에 소스코드 분석 요청한 서비스 수 */
        analyzedServiceCount: number;
        /** 발견된 endpoint-level call 수 */
        endpointCallCount: number;
        /** 생성된 relation candidate 수 */
        candidateCount: number;
    };
    /** 총 소요 시간 (ms) */
    totalDurationMs: number;
}

// ── 파일 탐색 유틸 ──────────────────────────────────

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'target',
    '__pycache__', '.gradle', 'out', 'coverage', '.cache',
]);

/** config 파일 확장자 */
const CONFIG_EXTENSIONS = new Set(['.yml', '.yaml', '.properties', '.env', '.json']);

/** config 파일 패턴 */
function isConfigFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    if (!CONFIG_EXTENSIONS.has(ext)) return false;
    const base = basename(filePath).toLowerCase();
    // application*.yml, bootstrap*.yml, .env 등
    return base.startsWith('application') ||
        base.startsWith('bootstrap') ||
        base.startsWith('.env') ||
        base.includes('docker-compose') ||
        (base.endsWith('.properties') && (base.includes('application') || base.includes('bootstrap')));
}

/** 소스코드 확장자 */
const SOURCE_EXTENSIONS = new Set([
    '.java', '.kt', '.kts', '.ts', '.js', '.py', '.go',
]);

/** HTTP client 관련 키워드 (프리필터용) */
const DEFAULT_FILTER_KEYWORDS = [
    'RestTemplate', 'WebClient', 'FeignClient', 'HttpClient',
    'OkHttp', 'Retrofit', 'RestClient',
    'fetch(', 'axios', 'http.get', 'http.post',
    '@Value', '${', 'getForObject', 'postForEntity',
    'exchange(', '.uri(', '.get(', '.post(',
    'HttpInterface', 'GetExchange', 'PostExchange',
];

/** 재귀 파일 탐색 */
function findFilesRecursive(dir: string, predicate: (path: string) => boolean): string[] {
    const results: string[] = [];
    function walk(current: string) {
        let entries: string[];
        try { entries = readdirSync(current); } catch { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry)) continue;
            const fullPath = join(current, entry);
            let stat;
            try { stat = statSync(fullPath); } catch { continue; }
            if (stat.isDirectory()) walk(fullPath);
            else if (stat.isFile() && predicate(fullPath)) results.push(fullPath);
        }
    }
    walk(dir);
    return results;
}

/** 파일 내용 읽기 (실패 시 null) */
function readFileSafe(filePath: string): string | null {
    try { return readFileSync(filePath, 'utf-8'); } catch { return null; }
}

// ── 서비스 매칭 ──────────────────────────────────────

interface ServiceRecord {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
}

/** 서비스명 정규화 */
function normalizeServiceName(name: string): string {
    return name.toLowerCase().replace(/[-_]/g, '');
}

/** 이름으로 서비스 ID 찾기 (정규화 매칭) */
function findServiceId(name: string, services: ServiceRecord[]): string | null {
    const norm = normalizeServiceName(name);
    // 정확 매칭
    const exact = services.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact.id;
    // 정규화 매칭
    const normalized = services.find((s) => normalizeServiceName(s.name) === norm);
    return normalized?.id ?? null;
}

/** 서비스가 관리하는 repo root 경로 (metadata.scanPath) */
function getServiceRepoRoot(service: ServiceRecord): string | null {
    const meta = service.metadata;
    const scanPath = typeof meta['scanPath'] === 'string' ? meta['scanPath'] : null;
    return scanPath;
}

// ── Phase 2: Config → LLM → Compound 의존성 ────────

async function phase2ConfigAnalysis(
    db: DbClient,
    options: SmartPipelineOptions,
    allServices: ServiceRecord[],
): Promise<{
    analyzedServiceCount: number;
    compoundDependencyCount: number;
    consumerServiceIds: string[];
    allDependencies: Array<{ sourceServiceId: string; dep: ConfigDependency }>;
}> {
    const knownServiceNames = allServices.map((s) => s.name);
    const consumerSet = new Set<string>();
    const allDeps: Array<{ sourceServiceId: string; dep: ConfigDependency }> = [];
    let analyzedCount = 0;

    for (const service of allServices) {
        // 서비스의 repo root 결정
        const serviceRepoRoot = getServiceRepoRoot(service);
        let configDir: string | null = null;

        if (serviceRepoRoot) {
            configDir = serviceRepoRoot;
        } else {
            // repoRoots에서 서비스명 디렉토리 탐색
            for (const root of options.repoRoots) {
                const candidate = join(root, service.name);
                try {
                    if (statSync(candidate).isDirectory()) {
                        configDir = candidate;
                        break;
                    }
                } catch { /* 없으면 다음 */ }
            }
            // 모노레포 구조에서 서비스명 폴더가 없으면 root 자체가 서비스일 수 있음
            if (!configDir && options.repoRoots.length === 1) {
                // 단일 repoRoot인 경우 해당 root의 config 파일 확인
                const rootConfigs = findFilesRecursive(options.repoRoots[0]!, isConfigFile);
                if (rootConfigs.length > 0 && allServices.length <= 3) {
                    // 서비스가 3개 이하면 root 자체를 해당 서비스로 간주
                    configDir = options.repoRoots[0]!;
                }
            }
        }

        if (!configDir) continue;

        // config 파일 수집
        const configFiles = findFilesRecursive(configDir, isConfigFile);
        if (configFiles.length === 0) continue;

        const configContents = configFiles
            .map((fp) => {
                const content = readFileSafe(fp);
                return content ? { path: relative(configDir!, fp), content } : null;
            })
            .filter((f): f is { path: string; content: string } => f !== null);

        if (configContents.length === 0) continue;

        // LLM에 config 분석 요청
        const context: ConfigAnalysisContext = {
            serviceName: service.name,
            configFiles: configContents,
            knownServices: knownServiceNames,
        };
        const prompt = buildConfigAnalysisPrompt(context);

        try {
            const result = await options.generateConfigAnalysis(prompt);
            analyzedCount += 1;

            for (const dep of result.dependencies) {
                allDeps.push({ sourceServiceId: service.id, dep });
                // call 또는 depend_on → consumer로 판정
                if (dep.relationType === 'call' || dep.relationType === 'depend_on') {
                    consumerSet.add(service.id);
                }
            }
        } catch (error) {
            console.error(`[SmartPipeline] Phase 2 LLM 분석 실패: ${service.name}`, error);
        }
    }

    return {
        analyzedServiceCount: analyzedCount,
        compoundDependencyCount: allDeps.length,
        consumerServiceIds: [...consumerSet],
        allDependencies: allDeps,
    };
}

// ── Phase 2 → DB: Compound 의존성 저장 ───────────────

async function saveLlmCompoundDependencies(
    db: DbClient,
    workspaceId: string,
    allServices: ServiceRecord[],
    allDeps: Array<{ sourceServiceId: string; dep: ConfigDependency }>,
): Promise<number> {
    let created = 0;

    for (const { sourceServiceId, dep } of allDeps) {
        const targetServiceId = findServiceId(dep.targetService, allServices);
        if (!targetServiceId || targetServiceId === sourceServiceId) continue;

        // evidence 생성
        const evidenceId = generateId();
        await db.insert(evidences).values({
            id: evidenceId,
            workspaceId,
            evidenceType: 'LLM_CONFIG',
            filePath: null,
            lineStart: null,
            lineEnd: null,
            excerpt: dep.evidence,
            metadata: { source: 'LLM_CONFIG_ANALYSIS', confidence: dep.confidence },
        });

        // 중복 체크
        const existing = await db
            .select({ id: relationCandidates.id, status: relationCandidates.status })
            .from(relationCandidates)
            .where(
                and(
                    eq(relationCandidates.workspaceId, workspaceId),
                    eq(relationCandidates.relationType, dep.relationType),
                    eq(relationCandidates.subjectObjectId, sourceServiceId),
                    eq(relationCandidates.objectId, targetServiceId),
                    or(
                        eq(relationCandidates.status, 'PENDING'),
                        eq(relationCandidates.status, 'APPROVED'),
                    ),
                ),
            )
            .limit(1);

        if (existing.length > 0) {
            // evidence만 추가 링크
            await db.insert(relationCandidateEvidences)
                .values({ workspaceId, candidateId: existing[0]!.id, evidenceId })
                .onConflictDoNothing();
            continue;
        }

        // 신규 후보 생성
        const candidateId = generateId();
        await db.insert(relationCandidates).values({
            id: candidateId,
            workspaceId,
            relationType: dep.relationType,
            subjectObjectId: sourceServiceId,
            objectId: targetServiceId,
            confidence: dep.confidence,
            metadata: {
                source: 'LLM_CONFIG',
                evidence: dep.evidence,
                targetType: 'service',
            },
            status: 'PENDING',
        });
        await db.insert(relationCandidateEvidences)
            .values({ workspaceId, candidateId, evidenceId })
            .onConflictDoNothing();
        created += 1;
    }

    return created;
}

// ── Phase 3: Consumer 소스코드 → LLM → Call 추출 ────

async function phase3CallExtraction(
    db: DbClient,
    options: SmartPipelineOptions,
    allServices: ServiceRecord[],
    consumerServiceIds: string[],
): Promise<{ analyzedServiceCount: number; endpointCallCount: number; candidateCount: number }> {
    const { workspaceId } = options;
    const filterKeywords = options.sourceFilterKeywords ?? DEFAULT_FILTER_KEYWORDS;

    // 모든 api_endpoint 목록 (OpenAPI에서 생성된 것 포함)
    const allEndpoints = await db
        .select({
            id: objects.id,
            name: objects.name,
            parentId: objects.parentId,
            metadata: objects.metadata,
        })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'api_endpoint'),
            ),
        );

    // 서비스별 엔드포인트 그룹핑
    const endpointsByService = new Map<string, Array<{ method: string; path: string; id: string }>>();
    for (const ep of allEndpoints) {
        if (!ep.parentId) continue;
        const meta = (ep.metadata ?? {}) as Record<string, unknown>;
        const method = (typeof meta['method'] === 'string' ? meta['method'] : 'ANY').toUpperCase();
        const path = typeof meta['path'] === 'string' ? meta['path'] : ep.name;
        const group = endpointsByService.get(ep.parentId) ?? [];
        group.push({ method, path, id: ep.id });
        endpointsByService.set(ep.parentId, group);
    }

    // consumer가 아닌 서비스(= provider)의 엔드포인트를 타겟으로 준비
    const targetEndpoints: Array<{ serviceName: string; serviceId: string; endpoints: Array<{ method: string; path: string; id: string }> }> = [];
    for (const service of allServices) {
        const eps = endpointsByService.get(service.id);
        if (eps && eps.length > 0) {
            targetEndpoints.push({ serviceName: service.name, serviceId: service.id, endpoints: eps });
        }
    }

    let analyzedCount = 0;
    let totalCalls = 0;
    let candidateCount = 0;

    for (const consumerId of consumerServiceIds) {
        const consumer = allServices.find((s) => s.id === consumerId);
        if (!consumer) continue;

        // consumer 서비스의 소스 디렉토리 결정
        const serviceRepoRoot = getServiceRepoRoot(consumer);
        let sourceDir: string | null = null;

        if (serviceRepoRoot) {
            sourceDir = serviceRepoRoot;
        } else {
            for (const root of options.repoRoots) {
                const candidate = join(root, consumer.name);
                try {
                    if (statSync(candidate).isDirectory()) {
                        sourceDir = candidate;
                        break;
                    }
                } catch { /* 다음 */ }
            }
        }

        if (!sourceDir) continue;

        // 소스 파일 수집 + HTTP client 키워드 프리필터
        const allSourceFiles = findFilesRecursive(sourceDir, (fp) => {
            return SOURCE_EXTENSIONS.has(extname(fp).toLowerCase());
        });

        const filteredFiles: Array<{ path: string; content: string }> = [];
        for (const fp of allSourceFiles) {
            const content = readFileSafe(fp);
            if (!content) continue;
            // 프리필터: HTTP client 관련 키워드가 포함된 파일만
            const hasKeyword = filterKeywords.some((kw) => content.includes(kw));
            if (hasKeyword) {
                filteredFiles.push({ path: relative(sourceDir!, fp), content });
            }
        }

        if (filteredFiles.length === 0) continue;

        // LLM 컨텍스트 구성
        const context: CallExtractionContext = {
            serviceName: consumer.name,
            sourceFiles: filteredFiles,
            targetEndpoints: targetEndpoints.map((t) => ({
                serviceName: t.serviceName,
                endpoints: t.endpoints.map((ep) => ({ method: ep.method, path: ep.path })),
            })),
        };
        const prompt = buildCallExtractionPrompt(context);

        try {
            const result = await options.generateCallExtraction(prompt);
            analyzedCount += 1;
            totalCalls += result.calls.length;

            // 추출된 호출을 relation candidate로 저장
            for (const call of result.calls) {
                const saved = await saveLlmCallCandidate(
                    db, workspaceId, consumerId, call,
                    allServices, targetEndpoints,
                );
                if (saved) candidateCount += 1;
            }
        } catch (error) {
            console.error(`[SmartPipeline] Phase 3 LLM 분석 실패: ${consumer.name}`, error);
        }
    }

    return { analyzedServiceCount: analyzedCount, endpointCallCount: totalCalls, candidateCount };
}

/** LLM이 추출한 call을 relation candidate로 저장 */
async function saveLlmCallCandidate(
    db: DbClient,
    workspaceId: string,
    sourceServiceId: string,
    call: ExtractedCall,
    allServices: ServiceRecord[],
    targetEndpoints: Array<{ serviceName: string; serviceId: string; endpoints: Array<{ method: string; path: string; id: string }> }>,
): Promise<boolean> {
    // 타겟 서비스 찾기
    const targetServiceId = findServiceId(call.targetService, allServices);
    if (!targetServiceId || targetServiceId === sourceServiceId) return false;

    // 엔드포인트 매칭
    const targetService = targetEndpoints.find((t) => t.serviceId === targetServiceId);
    let targetObjectId = targetServiceId; // fallback: service level
    let targetType = 'service';

    if (targetService) {
        // 정확 매칭: method + path
        const exactMatch = targetService.endpoints.find(
            (ep) => ep.method.toUpperCase() === call.httpMethod.toUpperCase() &&
                normalizePath(ep.path) === normalizePath(call.path),
        );
        if (exactMatch) {
            targetObjectId = exactMatch.id;
            targetType = 'api_endpoint';
        } else {
            // path만으로 fuzzy 매칭 (path parameter 정규화)
            const pathMatch = targetService.endpoints.find(
                (ep) => normalizePath(ep.path) === normalizePath(call.path),
            );
            if (pathMatch) {
                targetObjectId = pathMatch.id;
                targetType = 'api_endpoint';
            }
        }
    }

    // evidence 생성
    const evidenceId = generateId();
    await db.insert(evidences).values({
        id: evidenceId,
        workspaceId,
        evidenceType: 'LLM_CODE',
        filePath: call.sourceFile,
        lineStart: null,
        lineEnd: null,
        excerpt: call.evidence,
        metadata: {
            source: 'LLM_CALL_EXTRACTION',
            httpMethod: call.httpMethod,
            path: call.path,
            confidence: call.confidence,
        },
    });

    // 중복 체크
    const existing = await db
        .select({ id: relationCandidates.id, status: relationCandidates.status })
        .from(relationCandidates)
        .where(
            and(
                eq(relationCandidates.workspaceId, workspaceId),
                eq(relationCandidates.relationType, 'call'),
                eq(relationCandidates.subjectObjectId, sourceServiceId),
                eq(relationCandidates.objectId, targetObjectId),
                or(
                    eq(relationCandidates.status, 'PENDING'),
                    eq(relationCandidates.status, 'APPROVED'),
                ),
            ),
        )
        .limit(1);

    if (existing.length > 0) {
        await db.insert(relationCandidateEvidences)
            .values({ workspaceId, candidateId: existing[0]!.id, evidenceId })
            .onConflictDoNothing();
        return false;
    }

    const candidateId = generateId();
    await db.insert(relationCandidates).values({
        id: candidateId,
        workspaceId,
        relationType: 'call',
        subjectObjectId: sourceServiceId,
        objectId: targetObjectId,
        confidence: call.confidence,
        metadata: {
            source: 'LLM_CODE',
            httpMethod: call.httpMethod,
            path: call.path,
            targetType,
            targetServiceId,
            evidence: call.evidence,
        },
        status: 'PENDING',
    });
    await db.insert(relationCandidateEvidences)
        .values({ workspaceId, candidateId, evidenceId })
        .onConflictDoNothing();

    return true;
}

/** 경로 정규화: path parameter를 {param}으로 통일, 슬래시 정리 */
function normalizePath(path: string): string {
    return path
        .replace(/\/+/g, '/')           // 이중 슬래시 제거
        .replace(/\{[^}]+\}/g, '{*}')   // path parameter 정규화
        .replace(/\$\{[^}]+\}/g, '{*}') // ${variable} 형태도 정규화
        .replace(/\/$/g, '')             // trailing slash 제거
        .toLowerCase();
}

// ── 메인 파이프라인 ──────────────────────────────────

/**
 * Smart 추론 파이프라인 실행
 *
 * Phase 1: OpenAPI spec → provider endpoint 확정
 * Phase 2: Config files → LLM → Compound 의존성 + consumer 식별
 * Phase 3: consumer 서비스의 소스코드 → LLM → endpoint-level call
 */
export async function executeSmartPipeline(
    db: DbClient,
    options: SmartPipelineOptions,
): Promise<SmartPipelineResult> {
    const startTime = Date.now();
    const { workspaceId, repoRoots } = options;

    // 전체 서비스 목록 조회
    const allServices: ServiceRecord[] = await db
        .select({
            id: objects.id,
            name: objects.name,
            metadata: objects.metadata,
        })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'service'),
            ),
        ) as ServiceRecord[];

    // ── Phase 1: OpenAPI import ─────────────────────
    let openApiResult: OpenApiImportResult = {
        specFileCount: 0,
        endpointCount: 0,
        createdEndpointCount: 0,
        updatedEndpointCount: 0,
        unmatchedServiceCount: 0,
    };

    for (const repoRoot of repoRoots) {
        try {
            const result = await importOpenApiSpecs(db, { workspaceId, repoRoot });
            openApiResult.specFileCount += result.specFileCount;
            openApiResult.endpointCount += result.endpointCount;
            openApiResult.createdEndpointCount += result.createdEndpointCount;
            openApiResult.updatedEndpointCount += result.updatedEndpointCount;
            openApiResult.unmatchedServiceCount += result.unmatchedServiceCount;
        } catch (error) {
            console.error(`[SmartPipeline] Phase 1 OpenAPI import 실패: ${repoRoot}`, error);
        }
    }

    // ── Phase 2: Config → LLM → Compound deps ──────
    const phase2Result = await phase2ConfigAnalysis(db, options, allServices);

    // Phase 2 결과를 DB에 저장
    await saveLlmCompoundDependencies(
        db, workspaceId, allServices, phase2Result.allDependencies,
    );

    // ── Phase 3: Consumer source → LLM → calls ─────
    const phase3Result = await phase3CallExtraction(
        db, options, allServices, phase2Result.consumerServiceIds,
    );

    return {
        phase1: { openApi: openApiResult },
        phase2: {
            analyzedServiceCount: phase2Result.analyzedServiceCount,
            compoundDependencyCount: phase2Result.compoundDependencyCount,
            consumerServiceIds: phase2Result.consumerServiceIds,
        },
        phase3: {
            analyzedServiceCount: phase3Result.analyzedServiceCount,
            endpointCallCount: phase3Result.endpointCallCount,
            candidateCount: phase3Result.candidateCount,
        },
        totalDurationMs: Date.now() - startTime,
    };
}
