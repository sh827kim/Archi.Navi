/**
 * Smart 추론 파이프라인 — 3-Phase + bootstrap 오케스트레이션
 *
 * Phase 1: OpenAPI spec → provider endpoint 확정 (무료)
 * Phase 1.5: Code expose → provider endpoint bootstrap
 * Phase 2: Config files → LLM → Compound 의존성 그래프 (저비용)
 * Phase 3: consumer로 확인된 서비스만 → LLM → endpoint-level call 추출 (집중)
 *
 * Phase 2에서 consumer로 판정된 서비스에 대해서만 Phase 3을 실행하여
 * LLM 비용을 최소화한다.
 */
import { readFileSync, statSync } from 'fs';
import { join, extname, relative, basename, dirname } from 'path';
import { eq, and, or } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
    objects,
    relationCandidates,
    objectRelations,
    evidences,
    relationCandidateEvidences,
    relationEvidences,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { importOpenApiSpecs, type OpenApiImportResult } from '../openapi/openApiImporter';
import { findFiles } from '../utils/fileDiscovery';
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
import { saveRelationCandidate } from '../relation/candidateStore';
import { extractCodeSignalsWithEngine } from '../code';
import { bootstrapApiEndpointsFromCodeSignals } from '../relation/codeBased';

// ── 타입 ──────────────────────────────────────────────

/** LLM 호출 추상화: 프롬프트 → 구조화된 JSON 응답 */
export type LlmGenerateFn<T> = (prompt: string) => Promise<T>;

export interface SmartDeepInspectionInput {
    consumerServiceName: string;
    providerServiceName: string;
    prompt: string;
    initialCalls: ExtractedCall[];
    fallbackReasons: SmartFallbackReason[];
    pairConfidence: number;
}

export interface SmartDeepInspectionTrace {
    attemptedCount: number;
    failureCount: number;
    triggerBreakdown: {
        lowConfidence: number;
        insufficientContext: number;
    };
    details: SmartDeepInspectionTraceDetail[];
}

export interface SmartDeepInspectionSearchHit {
    path: string;
    snippet: string;
}

export interface SmartDeepInspectionFileContent {
    path: string;
    content: string;
}

export interface SmartDeepInspectionEndpoint {
    method: string;
    path: string;
}

export interface SmartDeepInspectionTools {
    searchFiles: (args: {
        serviceName: string;
        query: string;
        limit: number;
    }) => Promise<SmartDeepInspectionSearchHit[]>;
    readFile: (args: {
        serviceName: string;
        path: string;
    }) => Promise<SmartDeepInspectionFileContent | null>;
    listServiceEndpoints: (args: {
        serviceName: string;
    }) => Promise<SmartDeepInspectionEndpoint[]>;
}

export interface SmartDeepInspectionToolBudget {
    maxSearchCalls: number;
    maxReadCalls: number;
    maxEndpointListCalls: number;
    maxTotalToolCalls: number;
}

export interface SmartDeepInspectionRecoveredCallSummary {
    httpMethod: string;
    path: string;
}

export type SmartDeepInspectionStatus = 'succeeded' | 'failed' | 'no_result';

export interface SmartDeepInspectionTraceDetail {
    consumerServiceName: string;
    providerServiceName: string;
    trigger: {
        lowConfidence: boolean;
        insufficientContext: boolean;
    };
    status: SmartDeepInspectionStatus;
    fallbackReasons: SmartFallbackReason[];
    toolUsage: SmartDeepInspectionToolUsage;
    recoveredCalls: SmartDeepInspectionRecoveredCallSummary[];
}

/** Smart 파이프라인 옵션 */
export interface SmartPipelineOptions {
    workspaceId: string;
    repoRoots: string[];
    /** Phase 2용 LLM 함수 (config → compound deps) */
    generateConfigAnalysis: LlmGenerateFn<ConfigAnalysisResult>;
    /** Phase 3용 LLM 함수 (source → endpoint calls) */
    generateCallExtraction: LlmGenerateFn<CallExtractionResult>;
    /** Phase 3.5용 optional deep inspection 훅 */
    runDeepInspection?: (input: SmartDeepInspectionInput) => Promise<CallExtractionResult | null>;
    /** Phase 3.5용 deterministic tool-assisted deep inspection */
    deepInspectionTools?: SmartDeepInspectionTools;
    /** Phase 3.5용 deterministic tool-assisted deep inspection budget */
    deepInspectionBudget?: Partial<SmartDeepInspectionToolBudget>;
    /** Phase 3 소스코드 프리필터 키워드 (기본: HTTP client imports) */
    sourceFilterKeywords?: string[];
}

/** Smart 파이프라인 결과 */
export interface SmartPipelineResult {
    phase1: {
        openApi: OpenApiImportResult;
        bootstrapEndpointCount: number;
    };
    phase2: {
        /** LLM에 분석 요청한 서비스 수 */
        analyzedServiceCount: number;
        /** 발견된 Compound 의존성 수 */
        compoundDependencyCount: number;
        /** consumer로 판정된 서비스 ID 목록 */
        consumerServiceIds: string[];
        /** 실제 Smart가 고려한 consumer -> provider pair 수 (중복 제거) */
        servicePairCount: number;
    };
    phase3: {
        /** LLM에 소스코드 분석 요청한 서비스 수 */
        analyzedServiceCount: number;
        /** 발견된 endpoint-level call 수 */
        endpointCallCount: number;
        /** 생성된 relation candidate 수 */
        candidateCount: number;
        /** api_endpoint 대상으로 생성된 candidate 수 */
        atomicCandidateCount: number;
        /** endpoint 미매칭 등으로 service fallback된 candidate 수 */
        serviceFallbackCount: number;
        /** service fallback reason별 발생 건수 */
        fallbackReasonBreakdown: Record<
            'NO_ENDPOINT_OBJECTS' | 'PATH_NOT_MATCHED' | 'METHOD_NOT_MATCHED' | 'INSUFFICIENT_CONTEXT',
            number
        >;
        /** optional deep inspection 실행 시도 수 */
        deepInspectionCount: number;
        /** optional deep inspection 실행/실패/트리거 요약 */
        deepInspectionTrace: SmartDeepInspectionTrace;
    };
    /** 총 소요 시간 (ms) */
    totalDurationMs: number;
}

// ── 파일 탐색 유틸 ──────────────────────────────────

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

const PROVIDER_EXPOSE_KEYWORDS = [
    '@GetMapping', '@PostMapping', '@PutMapping', '@DeleteMapping', '@PatchMapping', '@RequestMapping',
    '@RestController', '@Controller', 'router.get(', 'router.post(', 'router.put(', 'router.delete(',
    'app.get(', 'app.post(', 'app.put(', 'app.delete(',
];

const DEEP_INSPECTION_PAIR_CONFIDENCE_THRESHOLD = 0.85;

/** 파일 내용 읽기 (실패 시 null) */
function readFileSafe(filePath: string): string | null {
    try { return readFileSync(filePath, 'utf-8'); } catch { return null; }
}

interface FileContent {
    absPath: string;
    path: string;
    content: string;
}

// ── 서비스 매칭 ──────────────────────────────────────

interface ServiceRecord {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
}

type SmartFallbackReason =
    | 'NO_ENDPOINT_OBJECTS'
    | 'PATH_NOT_MATCHED'
    | 'METHOD_NOT_MATCHED'
    | 'INSUFFICIENT_CONTEXT';

export type SmartFallbackReasonBreakdown = Record<SmartFallbackReason, number>;

interface LlmCallSaveResult {
    created: boolean;
    targetType: 'api_endpoint' | 'service';
    fallbackReason?: SmartFallbackReason;
}

function createFallbackReasonBreakdown(): SmartFallbackReasonBreakdown {
    return {
        NO_ENDPOINT_OBJECTS: 0,
        PATH_NOT_MATCHED: 0,
        METHOD_NOT_MATCHED: 0,
        INSUFFICIENT_CONTEXT: 0,
    };
}

function countServicePairs(
    allDependencies: Array<{ sourceServiceId: string; dep: ConfigDependency }>,
    allServices: ServiceRecord[],
): number {
    const pairKeys = new Set<string>();
    for (const { sourceServiceId, dep } of allDependencies) {
        if (dep.relationType !== 'call' && dep.relationType !== 'depend_on') continue;
        const providerId = findServiceId(dep.targetService, allServices);
        if (!providerId || providerId === sourceServiceId) continue;
        pairKeys.add(`${sourceServiceId}::${providerId}`);
    }
    return pairKeys.size;
}

function getPairConfidence(
    allDependencies: Array<{ sourceServiceId: string; dep: ConfigDependency }>,
    allServices: ServiceRecord[],
    consumerId: string,
    providerId: string,
): number {
    let confidence = 1;
    let matched = false;

    for (const { sourceServiceId, dep } of allDependencies) {
        if (sourceServiceId !== consumerId) continue;
        if (dep.relationType !== 'call' && dep.relationType !== 'depend_on') continue;
        const resolvedProviderId = findServiceId(dep.targetService, allServices);
        if (resolvedProviderId !== providerId) continue;
        matched = true;
        confidence = Math.min(confidence, dep.confidence);
    }

    return matched ? confidence : 1;
}

function shouldRunDeepInspection(
    pairConfidence: number,
    fallbackReasons: SmartFallbackReason[],
): boolean {
    return pairConfidence < DEEP_INSPECTION_PAIR_CONFIDENCE_THRESHOLD
        || fallbackReasons.includes('INSUFFICIENT_CONTEXT');
}

function createDeepInspectionTrace(): SmartDeepInspectionTrace {
    return {
        attemptedCount: 0,
        failureCount: 0,
        triggerBreakdown: {
            lowConfidence: 0,
            insufficientContext: 0,
        },
        details: [],
    };
}

const DEFAULT_DEEP_INSPECTION_TOOL_BUDGET: SmartDeepInspectionToolBudget = {
    maxSearchCalls: 3,
    maxReadCalls: 3,
    maxEndpointListCalls: 1,
    maxTotalToolCalls: 6,
};

export interface SmartDeepInspectionToolUsage {
    searchCalls: number;
    readCalls: number;
    endpointListCalls: number;
    totalCalls: number;
}

type SmartDeepInspectionToolKind = 'search' | 'read' | 'endpointList';

function createDeepInspectionBudget(
    budget: Partial<SmartDeepInspectionToolBudget> | undefined,
): SmartDeepInspectionToolBudget {
    return {
        maxSearchCalls: budget?.maxSearchCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxSearchCalls,
        maxReadCalls: budget?.maxReadCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxReadCalls,
        maxEndpointListCalls:
            budget?.maxEndpointListCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxEndpointListCalls,
        maxTotalToolCalls: budget?.maxTotalToolCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxTotalToolCalls,
    };
}

function createDeepInspectionToolUsage(): SmartDeepInspectionToolUsage {
    return {
        searchCalls: 0,
        readCalls: 0,
        endpointListCalls: 0,
        totalCalls: 0,
    };
}

function cloneDeepInspectionToolUsage(usage: SmartDeepInspectionToolUsage): SmartDeepInspectionToolUsage {
    return {
        searchCalls: usage.searchCalls,
        readCalls: usage.readCalls,
        endpointListCalls: usage.endpointListCalls,
        totalCalls: usage.totalCalls,
    };
}

function buildRecoveredCallSummaries(calls: ExtractedCall[]): SmartDeepInspectionRecoveredCallSummary[] {
    const unique = new Map<string, SmartDeepInspectionRecoveredCallSummary>();
    for (const call of calls) {
        const method = call.httpMethod.trim().toUpperCase();
        const path = call.path.trim();
        if (method.length === 0 || path.length === 0) continue;
        const key = `${method}::${normalizePath(path)}`;
        if (unique.has(key)) continue;
        unique.set(key, { httpMethod: method, path });
    }
    return [...unique.values()];
}

function consumeToolBudget(
    usage: SmartDeepInspectionToolUsage,
    budget: SmartDeepInspectionToolBudget,
    kind: SmartDeepInspectionToolKind,
): boolean {
    if (usage.totalCalls >= budget.maxTotalToolCalls) {
        return false;
    }
    if (kind === 'search' && usage.searchCalls >= budget.maxSearchCalls) {
        return false;
    }
    if (kind === 'read' && usage.readCalls >= budget.maxReadCalls) {
        return false;
    }
    if (kind === 'endpointList' && usage.endpointListCalls >= budget.maxEndpointListCalls) {
        return false;
    }

    usage.totalCalls += 1;
    if (kind === 'search') usage.searchCalls += 1;
    if (kind === 'read') usage.readCalls += 1;
    if (kind === 'endpointList') usage.endpointListCalls += 1;
    return true;
}

function buildDeepInspectionQueries(
    input: SmartDeepInspectionInput,
    endpoints: SmartDeepInspectionEndpoint[],
): string[] {
    const queries = new Set<string>();
    queries.add(input.providerServiceName);
    queries.add(normalizeServiceName(input.providerServiceName));

    for (const endpoint of endpoints.slice(0, 3)) {
        if (endpoint.path.trim().length > 0) {
            queries.add(endpoint.path.trim());
            queries.add(`${endpoint.method.toUpperCase()} ${endpoint.path.trim()}`);
        }
    }
    for (const call of input.initialCalls.slice(0, 3)) {
        if (call.path.trim().length > 0) {
            queries.add(call.path.trim());
            queries.add(`${call.httpMethod.toUpperCase()} ${call.path.trim()}`);
        }
    }

    return [...queries].filter((query) => query.length > 0);
}

function findEndpointMatch(
    call: ExtractedCall,
    endpoints: SmartDeepInspectionEndpoint[],
): SmartDeepInspectionEndpoint | null {
    const normalizedMethod = call.httpMethod.trim().toUpperCase();
    if (normalizedMethod.length === 0 || normalizePath(call.path).length === 0) {
        return null;
    }

    const exactMatches = endpoints.filter((endpoint) => (
        endpoint.method.toUpperCase() === normalizedMethod
        && normalizePath(endpoint.path) === normalizePath(call.path)
    ));
    if (exactMatches.length === 1) {
        return exactMatches[0] ?? null;
    }

    const compatibleMatches = endpoints.filter((endpoint) => (
        endpoint.method.toUpperCase() === normalizedMethod
        && isEndpointPathCompatible(call.path, endpoint.path)
    ));
    return compatibleMatches.length === 1 ? (compatibleMatches[0] ?? null) : null;
}

function extractHttpMethodHints(text: string): Set<string> {
    const methods = new Set<string>();
    const methodRegex = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/gi;
    let match = methodRegex.exec(text);
    while (match) {
        const method = (match[1] ?? '').toUpperCase();
        if (method.length > 0) {
            methods.add(method);
        }
        match = methodRegex.exec(text);
    }
    return methods;
}

function extractPathCandidatesFromText(text: string): string[] {
    const candidates = new Set<string>();

    const urlRegex = /https?:\/\/[^\s"'`<>)\]}]+/gi;
    let urlMatch = urlRegex.exec(text);
    while (urlMatch) {
        const value = (urlMatch[0] ?? '').trim();
        if (value.length > 0) {
            candidates.add(value);
        }
        urlMatch = urlRegex.exec(text);
    }

    const pathRegex =
        /\/[A-Za-z0-9._~!$&'()*+,;=:@%${}-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%${}-]+)*(?:\?[^\s"'`#<>)\]}]*)?(?:#[^\s"'`<>)\]}]*)?/g;
    let pathMatch = pathRegex.exec(text);
    while (pathMatch) {
        const value = (pathMatch[0] ?? '').trim();
        if (value.length > 0) {
            candidates.add(value);
        }
        pathMatch = pathRegex.exec(text);
    }

    return [...candidates];
}

function findCompatibleEvidencePath(
    evidenceText: string,
    endpointMethod: string,
    endpointPath: string,
): string | null {
    const methodHints = extractHttpMethodHints(evidenceText);
    if (methodHints.size > 0 && !methodHints.has(endpointMethod)) {
        return null;
    }

    const candidates = extractPathCandidatesFromText(evidenceText);
    for (const candidate of candidates) {
        if (isEndpointPathCompatible(candidate, endpointPath)) {
            return candidate;
        }
    }
    return null;
}

function buildToolAssistedCalls(
    input: SmartDeepInspectionInput,
    endpoints: SmartDeepInspectionEndpoint[],
    searchHits: SmartDeepInspectionSearchHit[],
    readFiles: SmartDeepInspectionFileContent[],
): ExtractedCall[] {
    for (const call of input.initialCalls) {
        const match = findEndpointMatch(call, endpoints);
        if (!match) continue;
        return [{
            ...call,
            targetService: input.providerServiceName,
            httpMethod: match.method.toUpperCase(),
            path: match.path,
            evidence: `${call.evidence}\n// deep inspection verified by listServiceEndpoints`,
            confidence: Math.max(call.confidence, 0.9),
        }];
    }

    for (const endpoint of endpoints) {
        const pathText = endpoint.path.trim();
        if (pathText.length === 0) continue;
        const endpointMethod = endpoint.method.toUpperCase();
        let sourceFile = 'deep-inspection';
        let evidenceSource = '';
        let matchedPath: string | null = null;

        for (const file of readFiles) {
            const compatiblePath = findCompatibleEvidencePath(
                file.content,
                endpointMethod,
                pathText,
            );
            if (!compatiblePath) continue;
            sourceFile = file.path;
            evidenceSource = file.content;
            matchedPath = compatiblePath;
            break;
        }

        if (!matchedPath) {
            for (const hit of searchHits) {
                const compatiblePath = findCompatibleEvidencePath(
                    hit.snippet,
                    endpointMethod,
                    pathText,
                );
                if (!compatiblePath) continue;
                sourceFile = hit.path;
                evidenceSource = hit.snippet;
                matchedPath = compatiblePath;
                break;
            }
        }

        if (!matchedPath) continue;

        const evidence = evidenceSource.length > 200
            ? evidenceSource.slice(0, 200)
            : evidenceSource;
        return [{
            targetService: input.providerServiceName,
            httpMethod: endpointMethod,
            path: pathText,
            sourceFile,
            evidence: evidence.length > 0
                ? evidence
                : `tool-assisted deep inspection matched ${endpointMethod} ${pathText}`,
            confidence: 0.88,
        }];
    }

    return [];
}

async function runDeterministicDeepInspection(
    input: SmartDeepInspectionInput,
    providerEndpoints: Array<{ method: string; path: string }>,
    tools: SmartDeepInspectionTools,
    budgetOverrides: Partial<SmartDeepInspectionToolBudget> | undefined,
): Promise<{ calls: ExtractedCall[]; toolUsage: SmartDeepInspectionToolUsage }> {
    const budget = createDeepInspectionBudget(budgetOverrides);
    const usage = createDeepInspectionToolUsage();
    const decorateErrorWithToolUsage = (error: unknown): Error => {
        const exception = error instanceof Error ? error : new Error(String(error));
        const enriched = exception as Error & { toolUsage?: SmartDeepInspectionToolUsage };
        enriched.toolUsage = cloneDeepInspectionToolUsage(usage);
        return enriched;
    };

    try {
        let endpoints: SmartDeepInspectionEndpoint[] = providerEndpoints.map((endpoint) => ({
            method: endpoint.method.toUpperCase(),
            path: endpoint.path,
        }));
        if (consumeToolBudget(usage, budget, 'endpointList')) {
            const listedEndpoints = await tools.listServiceEndpoints({
                serviceName: input.providerServiceName,
            });
            if (listedEndpoints.length > 0) {
                endpoints = listedEndpoints.map((endpoint) => ({
                    method: endpoint.method.trim().toUpperCase(),
                    path: endpoint.path,
                }));
            }
        }

        const uniqueEndpoints = new Map<string, SmartDeepInspectionEndpoint>();
        for (const endpoint of endpoints) {
            const normalizedMethod = endpoint.method.trim().toUpperCase();
            const normalizedPath = endpoint.path.trim();
            if (normalizedMethod.length === 0 || normalizedPath.length === 0) continue;
            uniqueEndpoints.set(
                `${normalizedMethod}::${normalizePath(normalizedPath)}`,
                { method: normalizedMethod, path: normalizedPath },
            );
        }
        const normalizedEndpoints = [...uniqueEndpoints.values()];
        if (normalizedEndpoints.length === 0) {
            return { calls: [], toolUsage: cloneDeepInspectionToolUsage(usage) };
        }

        const queries = buildDeepInspectionQueries(input, normalizedEndpoints);
        const searchHitsByPath = new Map<string, SmartDeepInspectionSearchHit>();
        for (const query of queries) {
            if (!consumeToolBudget(usage, budget, 'search')) {
                break;
            }
            const hits = await tools.searchFiles({
                serviceName: input.consumerServiceName,
                query,
                limit: 5,
            });
            for (const hit of hits) {
                if (hit.path.trim().length === 0) continue;
                if (!searchHitsByPath.has(hit.path)) {
                    searchHitsByPath.set(hit.path, hit);
                }
            }
        }
        const searchHits = [...searchHitsByPath.values()];

        const readFiles: SmartDeepInspectionFileContent[] = [];
        for (const hit of searchHits) {
            if (!consumeToolBudget(usage, budget, 'read')) {
                break;
            }
            const file = await tools.readFile({
                serviceName: input.consumerServiceName,
                path: hit.path,
            });
            if (file && file.path.trim().length > 0) {
                readFiles.push(file);
            }
        }

        const calls = buildToolAssistedCalls(input, normalizedEndpoints, searchHits, readFiles);
        return { calls, toolUsage: cloneDeepInspectionToolUsage(usage) };
    } catch (error) {
        throw decorateErrorWithToolUsage(error);
    }
}

async function annotateExistingSmartFallbackCandidate(
    db: DbClient,
    params: {
        workspaceId: string;
        subjectObjectId: string;
        objectId: string;
        targetServiceId: string;
        fallbackReason: SmartFallbackReason;
    },
): Promise<boolean> {
    const [pendingCandidate] = await db
        .select({
            id: relationCandidates.id,
            metadata: relationCandidates.metadata,
        })
        .from(relationCandidates)
        .where(
            and(
                eq(relationCandidates.workspaceId, params.workspaceId),
                eq(relationCandidates.relationType, 'call'),
                eq(relationCandidates.subjectObjectId, params.subjectObjectId),
                eq(relationCandidates.objectId, params.objectId),
                eq(relationCandidates.status, 'PENDING'),
            ),
        )
        .limit(1);

    if (!pendingCandidate) return false;

    const currentMetadata = (pendingCandidate.metadata ?? {}) as Record<string, unknown>;
    await db
        .update(relationCandidates)
        .set({
            metadata: {
                ...currentMetadata,
                targetType: 'service',
                targetServiceId: params.targetServiceId,
                analysisMode: 'pair_pack',
                fallbackReason: params.fallbackReason,
            },
        })
        .where(eq(relationCandidates.id, pendingCandidate.id));

    return true;
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

function resolveServiceDirectory(
    service: ServiceRecord,
    repoRoots: string[],
): string | null {
    const serviceRepoRoot = getServiceRepoRoot(service);
    if (serviceRepoRoot) return serviceRepoRoot;

    for (const root of repoRoots) {
        const candidate = join(root, service.name);
        try {
            if (statSync(candidate).isDirectory()) {
                return candidate;
            }
        } catch {
            // continue
        }
    }

    if (repoRoots.length === 1) {
        return repoRoots[0] ?? null;
    }

    return null;
}

function collectSourceFiles(dirPath: string): FileContent[] {
    const files = findFiles(dirPath, (fp) => SOURCE_EXTENSIONS.has(extname(fp).toLowerCase()));
    const entries: FileContent[] = [];
    for (const absPath of files) {
        const content = readFileSafe(absPath);
        if (!content) continue;
        entries.push({ absPath, path: relative(dirPath, absPath), content });
    }
    return entries;
}

function collectConfigFiles(dirPath: string): FileContent[] {
    const files = findFiles(dirPath, isConfigFile);
    const entries: FileContent[] = [];
    for (const absPath of files) {
        const content = readFileSafe(absPath);
        if (!content) continue;
        entries.push({ absPath, path: relative(dirPath, absPath), content });
    }
    return entries;
}

function buildPairIndicators(providerName: string, endpointPaths: string[]): string[] {
    const lowerProvider = providerName.toLowerCase();
    const normalizedProvider = normalizeServiceName(providerName);
    const values = [
        lowerProvider,
        normalizedProvider,
        `http://${lowerProvider}`,
        `https://${lowerProvider}`,
        `://${lowerProvider}`,
        ...endpointPaths.map((p) => p.toLowerCase()),
    ];
    return [...new Set(values.filter((v) => v.length > 0))];
}

function parseRelativeImports(content: string): string[] {
    const imports = new Set<string>();
    const fromRegex = /from\s+['"](\.[^'"]+)['"]/g;
    const requireRegex = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    const importRegex = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null = null;

    while ((match = fromRegex.exec(content)) !== null) imports.add(match[1] ?? '');
    while ((match = requireRegex.exec(content)) !== null) imports.add(match[1] ?? '');
    while ((match = importRegex.exec(content)) !== null) imports.add(match[1] ?? '');

    return [...imports].filter((v) => v.length > 0);
}

function resolveImportToSourceFile(
    ownerAbsPath: string,
    importPath: string,
    sourceByAbsPath: Map<string, FileContent>,
): FileContent | null {
    const base = join(dirname(ownerAbsPath), importPath);
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.java`,
        `${base}.kt`,
        `${base}.kts`,
        `${base}.py`,
        `${base}.go`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
        join(base, 'index.js'),
        join(base, 'index.jsx'),
    ];

    for (const candidate of candidates) {
        const resolved = sourceByAbsPath.get(candidate);
        if (resolved) return resolved;
    }
    return null;
}

function collectConfigSnippetsForPair(
    configFiles: FileContent[],
    indicators: string[],
): Array<{ path: string; snippet: string }> {
    const snippets: Array<{ path: string; snippet: string }> = [];
    for (const file of configFiles) {
        const lines = file.content.split('\n');
        const matched = lines.filter((line) => {
            const lower = line.toLowerCase();
            return indicators.some((ind) => ind.length > 0 && lower.includes(ind));
        });
        if (matched.length === 0) continue;
        snippets.push({
            path: `config/${file.path}`,
            snippet: matched.slice(0, 20).join('\n'),
        });
    }
    return snippets;
}

function collectConsumerEvidenceFiles(
    consumerSourceFiles: FileContent[],
    providerName: string,
    endpointPaths: string[],
    filterKeywords: string[],
): Array<{ path: string; content: string }> {
    const indicators = buildPairIndicators(providerName, endpointPaths);
    const sourceByAbsPath = new Map(consumerSourceFiles.map((f) => [f.absPath, f]));
    const includeSet = new Map<string, FileContent>();
    const keywordsLower = filterKeywords.map((k) => k.toLowerCase());

    const providerAnchors = consumerSourceFiles.filter((file) => {
        const lower = file.content.toLowerCase();
        if (file.path.toLowerCase().includes(providerName.toLowerCase())) return true;
        return indicators.some((ind) => ind.length > 0 && lower.includes(ind));
    });

    const anchors = providerAnchors.length > 0
        ? providerAnchors
        : consumerSourceFiles.filter((file) => {
            const lower = file.content.toLowerCase();
            return keywordsLower.some((kw) => lower.includes(kw));
        });

    for (const anchor of anchors) {
        includeSet.set(anchor.absPath, anchor);
    }

    // anchor 기준 1-hop import 확장 (pair indicator가 있는 파일만 포함)
    for (const anchor of anchors) {
        const imports = parseRelativeImports(anchor.content);
        for (const importPath of imports) {
            const imported = resolveImportToSourceFile(anchor.absPath, importPath, sourceByAbsPath);
            if (!imported) continue;
            const lower = imported.content.toLowerCase();
            const pathLower = imported.path.toLowerCase();
            const hasIndicator = indicators.some((ind) => ind.length > 0 && lower.includes(ind));
            const pathMatched = pathLower.includes(providerName.toLowerCase());
            if (hasIndicator || pathMatched) {
                includeSet.set(imported.absPath, imported);
            }
        }
    }

    return [...includeSet.values()].map((f) => ({
        path: `consumer/${f.path}`,
        content: f.content,
    }));
}

function collectProviderEvidenceFiles(
    providerSourceFiles: FileContent[],
    endpointPaths: string[],
): Array<{ path: string; content: string }> {
    const endpointsLower = endpointPaths.map((p) => p.toLowerCase());
    const includeSet = new Map<string, FileContent>();

    for (const file of providerSourceFiles) {
        const lower = file.content.toLowerCase();
        const endpointMatched = endpointsLower.some((path) => path.length > 0 && lower.includes(path));
        const exposeMatched = PROVIDER_EXPOSE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
        if (endpointMatched || exposeMatched) {
            includeSet.set(file.absPath, file);
        }
    }

    return [...includeSet.values()].map((f) => ({
        path: `provider/${f.path}`,
        content: f.content,
    }));
}

async function attachEvidenceToRelationOrCandidate(
    db: DbClient,
    workspaceId: string,
    target: { candidateId?: string; relationId?: string },
    evidenceId: string,
) {
    if (target.candidateId) {
        await db.insert(relationCandidateEvidences)
            .values({ workspaceId, candidateId: target.candidateId, evidenceId })
            .onConflictDoNothing();
        return;
    }

    if (target.relationId) {
        await db.insert(relationEvidences)
            .values({ workspaceId, relationId: target.relationId, evidenceId })
            .onConflictDoNothing();
    }
}

async function findReusableRelationTarget(
    db: DbClient,
    workspaceId: string,
    relationType: string,
    subjectObjectId: string,
    objectId: string,
): Promise<{ relationId?: string } | null> {
    const [existingRelation] = await db
        .select({ id: objectRelations.id })
        .from(objectRelations)
        .where(
            and(
                eq(objectRelations.workspaceId, workspaceId),
                eq(objectRelations.relationType, relationType),
                eq(objectRelations.subjectObjectId, subjectObjectId),
                eq(objectRelations.objectId, objectId),
                eq(objectRelations.isDerived, false),
            ),
        )
        .limit(1);

    if (existingRelation) {
        return { relationId: existingRelation.id };
    }

    return null;
}

// ── Phase 1.5: Code expose → endpoint bootstrap ────

async function phase15BootstrapEndpoints(
    db: DbClient,
    options: SmartPipelineOptions,
    allServices: ServiceRecord[],
): Promise<{ bootstrapEndpointCount: number }> {
    let bootstrapEndpointCount = 0;
    const scanPaths = Array.from(new Set(
        allServices
            .map((service) => getServiceRepoRoot(service))
            .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ));
    const roots = scanPaths.length > 0 ? scanPaths : options.repoRoots;

    for (const repoRoot of roots) {
        try {
            await extractCodeSignalsWithEngine(db, {
                workspaceId: options.workspaceId,
                repoRoot,
                forceRescan: true,
            });
            const result = await bootstrapApiEndpointsFromCodeSignals(db, {
                workspaceId: options.workspaceId,
                repoRoot,
                endpointSource: 'SMART_BOOTSTRAP',
            });
            bootstrapEndpointCount += result.createdEndpointCount;
        } catch (error) {
            console.error('[smartPipeline] phase1.5 bootstrap failed', {
                workspaceId: options.workspaceId,
                repoRoot,
                error,
            });
        }
    }

    return { bootstrapEndpointCount };
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
    servicePairCount: number;
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
                const rootConfigs = findFiles(options.repoRoots[0]!, isConfigFile);
                if (rootConfigs.length > 0 && allServices.length <= 3) {
                    // 서비스가 3개 이하면 root 자체를 해당 서비스로 간주
                    configDir = options.repoRoots[0]!;
                }
            }
        }

        if (!configDir) continue;

        // config 파일 수집
        const configFiles = findFiles(configDir, isConfigFile);
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
        servicePairCount: countServicePairs(allDeps, allServices),
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

        const reusableTarget = await findReusableRelationTarget(
            db,
            workspaceId,
            dep.relationType,
            sourceServiceId,
            targetServiceId,
        );

        if (reusableTarget) {
            await attachEvidenceToRelationOrCandidate(db, workspaceId, reusableTarget, evidenceId);
            continue;
        }

        const saved = await saveRelationCandidate(
            db,
            {
                workspaceId,
                relationType: dep.relationType,
                subjectObjectId: sourceServiceId,
                objectId: targetServiceId,
                confidence: dep.confidence,
                metadata: {
                    source: 'LLM_CONFIG',
                    signalKind: 'dependency_decl',
                    evidence: dep.evidence,
                    targetType: 'service',
                },
            },
            evidenceId,
        );
        created += Number(saved.created);
    }

    return created;
}

// ── Phase 3: Consumer 소스코드 → LLM → Call 추출 ────

async function phase3CallExtraction(
    db: DbClient,
    options: SmartPipelineOptions,
    allServices: ServiceRecord[],
    consumerServiceIds: string[],
    allDependencies: Array<{ sourceServiceId: string; dep: ConfigDependency }>,
): Promise<{
    analyzedServiceCount: number;
    endpointCallCount: number;
    candidateCount: number;
    atomicCandidateCount: number;
    serviceFallbackCount: number;
    fallbackReasonBreakdown: SmartFallbackReasonBreakdown;
    deepInspectionCount: number;
    deepInspectionTrace: SmartDeepInspectionTrace;
}> {
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

    const providersByConsumer = new Map<string, Set<string>>();
    for (const { sourceServiceId, dep } of allDependencies) {
        if (dep.relationType !== 'call' && dep.relationType !== 'depend_on') continue;
        const providerId = findServiceId(dep.targetService, allServices);
        if (!providerId || providerId === sourceServiceId) continue;
        const group = providersByConsumer.get(sourceServiceId) ?? new Set<string>();
        group.add(providerId);
        providersByConsumer.set(sourceServiceId, group);
    }

    let analyzedCount = 0;
    let totalCalls = 0;
    let candidateCount = 0;
    let atomicCandidateCount = 0;
    let serviceFallbackCount = 0;
    let deepInspectionCount = 0;
    const fallbackReasonBreakdown = createFallbackReasonBreakdown();
    const deepInspectionTrace = createDeepInspectionTrace();

    for (const consumerId of consumerServiceIds) {
        const consumer = allServices.find((s) => s.id === consumerId);
        if (!consumer) continue;

        const sourceDir = resolveServiceDirectory(consumer, options.repoRoots);
        if (!sourceDir) continue;

        const consumerSourceFiles = collectSourceFiles(sourceDir);
        const consumerConfigFiles = collectConfigFiles(sourceDir);

        if (consumerSourceFiles.length === 0) continue;

        const explicitProviders = providersByConsumer.get(consumerId) ?? new Set<string>();
        const providerIds = explicitProviders.size > 0
            ? [...explicitProviders]
            : [...endpointsByService.keys()].filter((providerId) => providerId !== consumerId);

        for (const providerId of providerIds) {
            const provider = allServices.find((service) => service.id === providerId);
            if (!provider) continue;
            const providerEndpoints = endpointsByService.get(providerId) ?? [];
            const pairConfidence = getPairConfidence(allDependencies, allServices, consumerId, providerId);

            const providerDir = resolveServiceDirectory(provider, options.repoRoots);
            const providerSourceFiles = providerDir ? collectSourceFiles(providerDir) : [];
            const endpointPaths = providerEndpoints.map((ep) => ep.path);

            const consumerEvidenceFiles = collectConsumerEvidenceFiles(
                consumerSourceFiles,
                provider.name,
                endpointPaths,
                filterKeywords,
            );
            const providerEvidenceFiles = collectProviderEvidenceFiles(
                providerSourceFiles,
                endpointPaths,
            );
            const configIndicators = buildPairIndicators(provider.name, endpointPaths);
            const configSnippets = collectConfigSnippetsForPair(consumerConfigFiles, configIndicators);

            const mergedSourceFiles = [
                ...consumerEvidenceFiles,
                ...providerEvidenceFiles,
                ...configSnippets.map((snippet) => ({
                    path: snippet.path,
                    content: snippet.snippet,
                })),
            ];
            if (mergedSourceFiles.length === 0) continue;

            // Prompt 구현 변경 전후 모두 동작하도록 공통/확장 필드를 함께 전달한다.
            const context = {
                serviceName: consumer.name,
                sourceFiles: mergedSourceFiles,
                targetEndpoints: [{
                    serviceName: provider.name,
                    endpoints: providerEndpoints.map((ep) => ({ method: ep.method, path: ep.path })),
                }],
                consumerServiceName: consumer.name,
                providerServiceName: provider.name,
                consumerEvidenceFiles,
                providerEvidenceFiles,
                configSnippets,
                targetProviderEndpoints: providerEndpoints.map((ep) => ({
                    method: ep.method,
                    path: ep.path,
                })),
            } as unknown as CallExtractionContext;
            const prompt = buildCallExtractionPrompt(context);

            try {
                const result = await options.generateCallExtraction(prompt);
                analyzedCount += 1;
                totalCalls += result.calls.length;

                const pairTargetEndpoints = [{
                    serviceName: provider.name,
                    serviceId: provider.id,
                    endpoints: providerEndpoints,
                }];
                const fallbackReasons: SmartFallbackReason[] = [];
                for (const call of result.calls) {
                    const saved = await saveLlmCallCandidate(
                        db, workspaceId, consumerId, call,
                        allServices, pairTargetEndpoints,
                    );
                    if (saved.created) {
                        candidateCount += 1;
                    }
                    if (saved.targetType === 'api_endpoint') {
                        if (saved.created) {
                            atomicCandidateCount += 1;
                        }
                    } else if (saved.fallbackReason) {
                        serviceFallbackCount += 1;
                        fallbackReasonBreakdown[saved.fallbackReason] += 1;
                        fallbackReasons.push(saved.fallbackReason);
                    }
                }

                const hasDeepInspectionRunner = Boolean(options.runDeepInspection || options.deepInspectionTools);
                if (hasDeepInspectionRunner && shouldRunDeepInspection(pairConfidence, fallbackReasons)) {
                    const triggeredByLowConfidence =
                        pairConfidence < DEEP_INSPECTION_PAIR_CONFIDENCE_THRESHOLD;
                    const triggeredByInsufficientContext =
                        fallbackReasons.includes('INSUFFICIENT_CONTEXT');

                    if (triggeredByLowConfidence) {
                        deepInspectionTrace.triggerBreakdown.lowConfidence += 1;
                    }
                    if (triggeredByInsufficientContext) {
                        deepInspectionTrace.triggerBreakdown.insufficientContext += 1;
                    }
                    deepInspectionCount += 1;
                    deepInspectionTrace.attemptedCount += 1;

                    const detail: SmartDeepInspectionTraceDetail = {
                        consumerServiceName: consumer.name,
                        providerServiceName: provider.name,
                        trigger: {
                            lowConfidence: triggeredByLowConfidence,
                            insufficientContext: triggeredByInsufficientContext,
                        },
                        status: 'no_result',
                        fallbackReasons: [...new Set(fallbackReasons)],
                        toolUsage: createDeepInspectionToolUsage(),
                        recoveredCalls: [],
                    };
                    try {
                        const deepInspectionInput: SmartDeepInspectionInput = {
                            consumerServiceName: consumer.name,
                            providerServiceName: provider.name,
                            prompt,
                            initialCalls: result.calls,
                            fallbackReasons,
                            pairConfidence,
                        };
                        let recoveredCalls: ExtractedCall[] = [];
                        if (options.runDeepInspection) {
                            const deepInspectionResult = await options.runDeepInspection(deepInspectionInput);
                            recoveredCalls = deepInspectionResult?.calls ?? [];
                        } else if (options.deepInspectionTools) {
                            const deepInspectionResult = await runDeterministicDeepInspection(
                                    deepInspectionInput,
                                    providerEndpoints.map((endpoint) => ({
                                        method: endpoint.method,
                                        path: endpoint.path,
                                    })),
                                    options.deepInspectionTools,
                                    options.deepInspectionBudget,
                                );
                            detail.toolUsage = deepInspectionResult.toolUsage;
                            recoveredCalls = deepInspectionResult.calls;
                        }

                        detail.recoveredCalls = buildRecoveredCallSummaries(recoveredCalls);

                        if (recoveredCalls.length > 0) {
                            detail.status = 'succeeded';
                            totalCalls += recoveredCalls.length;
                            for (const call of recoveredCalls) {
                                const saved = await saveLlmCallCandidate(
                                    db, workspaceId, consumerId, call,
                                    allServices, pairTargetEndpoints,
                                );
                                if (saved.created) {
                                    candidateCount += 1;
                                }
                                if (saved.targetType === 'api_endpoint') {
                                    if (saved.created) {
                                        atomicCandidateCount += 1;
                                    }
                                } else if (saved.fallbackReason) {
                                    serviceFallbackCount += 1;
                                    fallbackReasonBreakdown[saved.fallbackReason] += 1;
                                }
                            }
                        } else {
                            detail.status = 'no_result';
                        }
                    } catch (error) {
                        const errorWithToolUsage = error as { toolUsage?: SmartDeepInspectionToolUsage };
                        if (errorWithToolUsage.toolUsage) {
                            detail.toolUsage = cloneDeepInspectionToolUsage(errorWithToolUsage.toolUsage);
                        }
                        detail.status = 'failed';
                        deepInspectionTrace.failureCount += 1;
                        console.error(
                            `[SmartPipeline] Phase 3.5 deep inspection 실패: ${consumer.name} -> ${provider.name}`,
                            error,
                        );
                    }
                    deepInspectionTrace.details.push(detail);
                }
            } catch (error) {
                console.error(
                    `[SmartPipeline] Phase 3 LLM 분석 실패: ${consumer.name} -> ${provider.name}`,
                    error,
                );
            }
        }
    }

    return {
        analyzedServiceCount: analyzedCount,
        endpointCallCount: totalCalls,
        candidateCount,
        atomicCandidateCount,
        serviceFallbackCount,
        fallbackReasonBreakdown,
        deepInspectionCount,
        deepInspectionTrace,
    };
}

/** LLM이 추출한 call을 relation candidate로 저장 */
async function saveLlmCallCandidate(
    db: DbClient,
    workspaceId: string,
    sourceServiceId: string,
    call: ExtractedCall,
    allServices: ServiceRecord[],
    targetEndpoints: Array<{ serviceName: string; serviceId: string; endpoints: Array<{ method: string; path: string; id: string }> }>,
): Promise<LlmCallSaveResult> {
    const normalizedMethod = call.httpMethod.trim().toUpperCase();
    const normalizedCallPath = call.path.trim();
    if (normalizedMethod.length === 0 || normalizedCallPath.length === 0) {
        return {
            created: false,
            targetType: 'service',
            fallbackReason: 'INSUFFICIENT_CONTEXT',
        };
    }

    // 타겟 서비스 찾기
    const targetServiceId = findServiceId(call.targetService, allServices);
    if (!targetServiceId || targetServiceId === sourceServiceId) {
        return {
            created: false,
            targetType: 'service',
            fallbackReason: 'INSUFFICIENT_CONTEXT',
        };
    }

    // 엔드포인트 매칭
    const targetService = targetEndpoints.find((t) => t.serviceId === targetServiceId);
    let targetObjectId = targetServiceId; // fallback: service level
    let targetType: 'api_endpoint' | 'service' = 'service';
    let fallbackReason: SmartFallbackReason | undefined;

    if (!targetService || targetService.endpoints.length === 0) {
        fallbackReason = 'NO_ENDPOINT_OBJECTS';
    } else {
        const normalizedPath = normalizePath(normalizedCallPath);
        const exactMatch = targetService.endpoints.find(
            (ep) => ep.method.toUpperCase() === normalizedMethod &&
                normalizePath(ep.path) === normalizedPath,
        );
        if (exactMatch) {
            targetObjectId = exactMatch.id;
            targetType = 'api_endpoint';
        } else {
            const compatibleMethodEndpoints = targetService.endpoints.filter(
                (ep) =>
                    ep.method.toUpperCase() === normalizedMethod
                    && isEndpointPathCompatible(normalizedCallPath, ep.path),
            );
            if (compatibleMethodEndpoints.length === 1) {
                targetObjectId = compatibleMethodEndpoints[0]?.id ?? targetServiceId;
                targetType = 'api_endpoint';
            } else {
                const samePathEndpoints = targetService.endpoints.filter(
                    (ep) => isEndpointPathCompatible(normalizedCallPath, ep.path),
                );
                if (samePathEndpoints.length > 0 && compatibleMethodEndpoints.length === 0) {
                    fallbackReason = 'METHOD_NOT_MATCHED';
                } else {
                    fallbackReason = 'PATH_NOT_MATCHED';
                }
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

    const reusableTarget = await findReusableRelationTarget(
        db,
        workspaceId,
        'call',
        sourceServiceId,
        targetObjectId,
    );

    if (reusableTarget) {
        await attachEvidenceToRelationOrCandidate(db, workspaceId, reusableTarget, evidenceId);
        return { created: false, targetType, ...(fallbackReason ? { fallbackReason } : {}) };
    }

    const saved = await saveRelationCandidate(
        db,
        {
            workspaceId,
            relationType: 'call',
            subjectObjectId: sourceServiceId,
            objectId: targetObjectId,
            confidence: call.confidence,
            metadata: {
                source: 'LLM_CODE',
                signalKind: 'call',
                httpMethod: call.httpMethod,
                path: call.path,
                targetType,
                targetServiceId,
                evidence: call.evidence,
                analysisMode: 'pair_pack',
                ...(targetType === 'service'
                    ? { fallbackReason: fallbackReason ?? 'INSUFFICIENT_CONTEXT' }
                    : {}),
            },
        },
        evidenceId,
    );

    if (!saved.created && targetType === 'service' && fallbackReason) {
        await annotateExistingSmartFallbackCandidate(db, {
            workspaceId,
            subjectObjectId: sourceServiceId,
            objectId: targetObjectId,
            targetServiceId,
            fallbackReason,
        });
    }

    return { created: saved.created, targetType, ...(fallbackReason ? { fallbackReason } : {}) };
}

function extractComparablePath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
        return '';
    }

    let pathOnly = trimmed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
            pathOnly = new URL(trimmed).pathname;
        } catch {
            pathOnly = trimmed;
        }
    }

    const hashIndex = pathOnly.indexOf('#');
    if (hashIndex >= 0) {
        pathOnly = pathOnly.slice(0, hashIndex);
    }
    const queryIndex = pathOnly.indexOf('?');
    if (queryIndex >= 0) {
        pathOnly = pathOnly.slice(0, queryIndex);
    }

    if (pathOnly.length === 0) {
        return '';
    }
    if (!pathOnly.startsWith('/')) {
        pathOnly = `/${pathOnly}`;
    }
    pathOnly = pathOnly.replace(/\/+/g, '/');
    if (pathOnly.length > 1) {
        pathOnly = pathOnly.replace(/\/+$/g, '');
    }
    return pathOnly.toLowerCase();
}

function normalizePathSegment(segment: string): string {
    let decoded = segment;
    try {
        decoded = decodeURIComponent(segment);
    } catch {
        decoded = segment;
    }
    const trimmed = decoded.trim();
    if (trimmed.length === 0) return '';
    if (/^\{[^/]+\}$/.test(trimmed)) return '{*}';
    if (/^\$\{[^/]+\}$/.test(trimmed)) return '{*}';
    if (/^:[^/]+$/.test(trimmed)) return '{*}';
    return trimmed;
}

function splitNormalizedPathSegments(path: string): string[] {
    const comparablePath = extractComparablePath(path);
    if (comparablePath.length === 0) {
        return [];
    }
    return comparablePath
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => normalizePathSegment(segment))
        .filter((segment) => segment.length > 0);
}

function isLikelyDynamicPathSegment(segment: string): boolean {
    if (segment === '{*}') return true;
    if (/^\d+$/.test(segment)) return true;
    if (/^[0-9a-f]{24}$/i.test(segment)) return true;
    if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
        return true;
    }
    return /\d/.test(segment) && /[a-z]/i.test(segment);
}

function isEndpointPathCompatible(callPath: string, endpointPath: string): boolean {
    const callSegments = splitNormalizedPathSegments(callPath);
    const endpointSegments = splitNormalizedPathSegments(endpointPath);
    if (callSegments.length !== endpointSegments.length) {
        return false;
    }
    if (callSegments.length === 0) {
        return extractComparablePath(callPath) === extractComparablePath(endpointPath);
    }

    for (let i = 0; i < endpointSegments.length; i += 1) {
        const callSegment = callSegments[i];
        const endpointSegment = endpointSegments[i];
        if (!callSegment || !endpointSegment) {
            return false;
        }

        if (endpointSegment === '{*}') {
            if (callSegment === '{*}' || isLikelyDynamicPathSegment(callSegment)) {
                continue;
            }
            return false;
        }
        if (callSegment === '{*}') {
            return false;
        }
        if (callSegment !== endpointSegment) {
            return false;
        }
    }
    return true;
}

/** 경로 정규화: URL/query/hash를 제거하고 path parameter를 {param}으로 통일 */
function normalizePath(path: string): string {
    const segments = splitNormalizedPathSegments(path);
    if (segments.length === 0) {
        const comparablePath = extractComparablePath(path);
        return comparablePath === '/' ? '/' : '';
    }
    return `/${segments.join('/')}`;
}

// ── 메인 파이프라인 ──────────────────────────────────

/**
 * Smart 추론 파이프라인 실행
 *
 * Phase 1: OpenAPI spec → provider endpoint 확정
 * Phase 1.5: Code expose → provider endpoint bootstrap
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

    // ── Phase 1.5: Code expose → endpoint bootstrap ─
    const phase15Result = await phase15BootstrapEndpoints(db, options, allServices);

    // ── Phase 2: Config → LLM → Compound deps ──────
    const phase2Result = await phase2ConfigAnalysis(db, options, allServices);

    // Phase 2 결과를 DB에 저장
    await saveLlmCompoundDependencies(
        db, workspaceId, allServices, phase2Result.allDependencies,
    );

    // ── Phase 3: Consumer source → LLM → calls ─────
    const phase3Result = await phase3CallExtraction(
        db, options, allServices, phase2Result.consumerServiceIds, phase2Result.allDependencies,
    );

    return {
        phase1: {
            openApi: openApiResult,
            bootstrapEndpointCount: phase15Result.bootstrapEndpointCount,
        },
        phase2: {
            analyzedServiceCount: phase2Result.analyzedServiceCount,
            compoundDependencyCount: phase2Result.compoundDependencyCount,
            consumerServiceIds: phase2Result.consumerServiceIds,
            servicePairCount: phase2Result.servicePairCount,
        },
        phase3: {
            analyzedServiceCount: phase3Result.analyzedServiceCount,
            endpointCallCount: phase3Result.endpointCallCount,
            candidateCount: phase3Result.candidateCount,
            atomicCandidateCount: phase3Result.atomicCandidateCount,
            serviceFallbackCount: phase3Result.serviceFallbackCount,
            fallbackReasonBreakdown: phase3Result.fallbackReasonBreakdown,
            deepInspectionCount: phase3Result.deepInspectionCount,
            deepInspectionTrace: phase3Result.deepInspectionTrace,
        },
        totalDurationMs: Date.now() - startTime,
    };
}
