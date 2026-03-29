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
import yaml from 'js-yaml';
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
    type ConfigSnippet,
    type EvidenceFile,
    type ExtractedCall,
} from '../llm/callExtractorPrompts';
import { saveRelationCandidate } from '../relation/candidateStore';
import { extractCodeSignalsWithEngine } from '../code';
import { bootstrapApiEndpointsFromCodeSignals } from '../relation/codeBased';

// ── 타입 ──────────────────────────────────────────────

/** LLM 호출 추상화: 프롬프트 → 구조화된 JSON 응답 */
export type LlmGenerateFn<T> = (prompt: string) => Promise<T>;
export type SmartAtomicAnalysisMode = 'pair_pack' | 'agent_assisted' | 'full_agent';

export interface SmartAtomicAgentStep {
    action: 'search_files' | 'read_file' | 'list_service_endpoints' | 'list_gateway_routes' | 'finish';
    serviceName?: string;
    query?: string;
    path?: string;
    limit?: number;
    calls?: ExtractedCall[];
    rationale?: string;
}

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
        pathNotMatched: number;
        noEndpointObjects: number;
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

export interface SmartGatewayRoute {
    kind: 'zuul';
    configPath: string;
    routeId: string;
    serviceName: string;
    routePath: string;
    routeBasePath: string;
    prefix: string;
    stripPrefix: boolean;
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
    listGatewayRoutes?: (args: {
        serviceName: string;
    }) => Promise<SmartGatewayRoute[]>;
}

export interface SmartDeepInspectionToolBudget {
    maxSearchCalls: number;
    maxReadCalls: number;
    maxEndpointListCalls: number;
    maxGatewayRouteCalls: number;
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
        pathNotMatched: boolean;
        noEndpointObjects: boolean;
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
    /** Agent-assisted / full-agent atomic 추론용 next-step 함수 */
    generateAgentStep?: LlmGenerateFn<SmartAtomicAgentStep>;
    /** Phase 3.5용 optional deep inspection 훅 */
    runDeepInspection?: (input: SmartDeepInspectionInput) => Promise<CallExtractionResult | null>;
    /** Phase 3.5용 deterministic tool-assisted deep inspection */
    deepInspectionTools?: SmartDeepInspectionTools;
    /** Phase 3.5용 deterministic tool-assisted deep inspection budget */
    deepInspectionBudget?: Partial<SmartDeepInspectionToolBudget>;
    /** atomic 추론 전략 */
    atomicAnalysisMode?: SmartAtomicAnalysisMode;
    /** pair-local agent 최대 스텝 수 */
    agentMaxSteps?: number;
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
        analysisMode: SmartAtomicAnalysisMode;
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
        /** agent path를 탄 pair 수 */
        agentEscalatedPairCount: number;
        /** agent가 복구한 atomic candidate 수 */
        agentRecoveredAtomicCount: number;
        /** agent path 실패 pair 수 */
        agentFailedPairCount: number;
        /** agent tool 사용량 총합 */
        agentToolUsageSummary: SmartDeepInspectionToolUsage;
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

interface ZuulRouteDefinition {
    prefix: string;
    routePath: string;
    serviceId: string;
}

interface SmartConfigDependencyHit {
    sourceServiceId: string;
    dep: ConfigDependency;
    evidenceFilePath: string | null;
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
    allDependencies: SmartConfigDependencyHit[],
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
    allDependencies: SmartConfigDependencyHit[],
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

function resolveConfigEvidenceFilePath(
    configFiles: FileContent[],
    evidence: string,
): string | null {
    const normalizedEvidence = evidence.trim();
    if (normalizedEvidence.length > 0) {
        const directMatch = configFiles.find((file) => file.content.includes(normalizedEvidence));
        if (directMatch) {
            return directMatch.absPath;
        }
    }

    return configFiles[0]?.absPath ?? null;
}

function shouldRunDeepInspection(
    pairConfidence: number,
    fallbackReasons: SmartFallbackReason[],
): boolean {
    return pairConfidence < DEEP_INSPECTION_PAIR_CONFIDENCE_THRESHOLD
        || fallbackReasons.includes('INSUFFICIENT_CONTEXT')
        || fallbackReasons.includes('PATH_NOT_MATCHED')
        || fallbackReasons.includes('NO_ENDPOINT_OBJECTS');
}

function buildDeepInspectionTrigger(
    pairConfidence: number,
    fallbackReasons: SmartFallbackReason[],
): SmartDeepInspectionTraceDetail['trigger'] {
    return {
        lowConfidence: pairConfidence < DEEP_INSPECTION_PAIR_CONFIDENCE_THRESHOLD,
        insufficientContext: fallbackReasons.includes('INSUFFICIENT_CONTEXT'),
        pathNotMatched: fallbackReasons.includes('PATH_NOT_MATCHED'),
        noEndpointObjects: fallbackReasons.includes('NO_ENDPOINT_OBJECTS'),
    };
}

function recordDeepInspectionTrigger(
    trace: SmartDeepInspectionTrace,
    trigger: SmartDeepInspectionTraceDetail['trigger'],
) {
    if (trigger.lowConfidence) {
        trace.triggerBreakdown.lowConfidence += 1;
    }
    if (trigger.insufficientContext) {
        trace.triggerBreakdown.insufficientContext += 1;
    }
    if (trigger.pathNotMatched) {
        trace.triggerBreakdown.pathNotMatched += 1;
    }
    if (trigger.noEndpointObjects) {
        trace.triggerBreakdown.noEndpointObjects += 1;
    }
}

function createDeepInspectionTrace(): SmartDeepInspectionTrace {
    return {
        attemptedCount: 0,
        failureCount: 0,
        triggerBreakdown: {
            lowConfidence: 0,
            insufficientContext: 0,
            pathNotMatched: 0,
            noEndpointObjects: 0,
        },
        details: [],
    };
}

const DEFAULT_DEEP_INSPECTION_TOOL_BUDGET: SmartDeepInspectionToolBudget = {
    maxSearchCalls: 3,
    maxReadCalls: 3,
    maxEndpointListCalls: 1,
    maxGatewayRouteCalls: 1,
    maxTotalToolCalls: 6,
};

export interface SmartDeepInspectionToolUsage {
    searchCalls: number;
    readCalls: number;
    endpointListCalls: number;
    gatewayRouteCalls: number;
    totalCalls: number;
}

type SmartDeepInspectionToolKind = 'search' | 'read' | 'endpointList' | 'gatewayRoute';

function createDeepInspectionBudget(
    budget: Partial<SmartDeepInspectionToolBudget> | undefined,
): SmartDeepInspectionToolBudget {
    return {
        maxSearchCalls: budget?.maxSearchCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxSearchCalls,
        maxReadCalls: budget?.maxReadCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxReadCalls,
        maxEndpointListCalls:
            budget?.maxEndpointListCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxEndpointListCalls,
        maxGatewayRouteCalls:
            budget?.maxGatewayRouteCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxGatewayRouteCalls,
        maxTotalToolCalls: budget?.maxTotalToolCalls ?? DEFAULT_DEEP_INSPECTION_TOOL_BUDGET.maxTotalToolCalls,
    };
}

function createDeepInspectionToolUsage(): SmartDeepInspectionToolUsage {
    return {
        searchCalls: 0,
        readCalls: 0,
        endpointListCalls: 0,
        gatewayRouteCalls: 0,
        totalCalls: 0,
    };
}

function mergeDeepInspectionToolUsage(
    base: SmartDeepInspectionToolUsage,
    delta: SmartDeepInspectionToolUsage,
): SmartDeepInspectionToolUsage {
    return {
        searchCalls: base.searchCalls + delta.searchCalls,
        readCalls: base.readCalls + delta.readCalls,
        endpointListCalls: base.endpointListCalls + delta.endpointListCalls,
        gatewayRouteCalls: base.gatewayRouteCalls + delta.gatewayRouteCalls,
        totalCalls: base.totalCalls + delta.totalCalls,
    };
}

function cloneDeepInspectionToolUsage(usage: SmartDeepInspectionToolUsage): SmartDeepInspectionToolUsage {
    return {
        searchCalls: usage.searchCalls,
        readCalls: usage.readCalls,
        endpointListCalls: usage.endpointListCalls,
        gatewayRouteCalls: usage.gatewayRouteCalls,
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

function sanitizeRecoveredCalls(calls: ExtractedCall[] | undefined, providerServiceName: string): ExtractedCall[] {
    if (!Array.isArray(calls)) return [];

    return calls.flatMap((call) => {
        const httpMethod = call.httpMethod.trim().toUpperCase();
        const path = call.path.trim();
        if (httpMethod.length === 0 || path.length === 0) {
            return [];
        }

        return [{
            targetService: call.targetService.trim().length > 0 ? call.targetService.trim() : providerServiceName,
            httpMethod,
            path,
            sourceFile: call.sourceFile.trim().length > 0 ? call.sourceFile.trim() : 'agent',
            evidence: call.evidence.trim(),
            confidence: Math.min(1, Math.max(0, call.confidence)),
        }];
    });
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
    if (kind === 'gatewayRoute' && usage.gatewayRouteCalls >= budget.maxGatewayRouteCalls) {
        return false;
    }

    usage.totalCalls += 1;
    if (kind === 'search') usage.searchCalls += 1;
    if (kind === 'read') usage.readCalls += 1;
    if (kind === 'endpointList') usage.endpointListCalls += 1;
    if (kind === 'gatewayRoute') usage.gatewayRouteCalls += 1;
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

function buildGatewayRouteRecoveredCalls(
    input: SmartDeepInspectionInput,
    providerEndpoints: SmartDeepInspectionEndpoint[],
    gatewayRoutes: SmartGatewayRoute[],
): ExtractedCall[] {
    const routeAwareEndpoints = buildRouteAwareTargetEndpoints(
        input.providerServiceName,
        providerEndpoints.map((endpoint) => ({
            ...endpoint,
            id: `${endpoint.method.toUpperCase()}::${normalizePath(endpoint.path)}`,
        })),
        gatewayRoutes,
    );
    return buildGatewayRecoveredCalls(input.providerServiceName, routeAwareEndpoints);
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
        let gatewayRoutes: SmartGatewayRoute[] = [];
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
        if (tools.listGatewayRoutes && consumeToolBudget(usage, budget, 'gatewayRoute')) {
            gatewayRoutes = await tools.listGatewayRoutes({
                serviceName: input.consumerServiceName,
            });
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

        if (gatewayRoutes.length > 0) {
            const gatewayRecoveredCalls = buildGatewayRouteRecoveredCalls(
                input,
                normalizedEndpoints,
                gatewayRoutes,
            );
            if (gatewayRecoveredCalls.length > 0) {
                return {
                    calls: gatewayRecoveredCalls,
                    toolUsage: cloneDeepInspectionToolUsage(usage),
                };
            }
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

interface SmartAgentPairContext {
    consumerServiceName: string;
    providerServiceName: string;
    consumerEvidenceFiles: EvidenceFile[];
    providerEvidenceFiles: EvidenceFile[];
    configSnippets: ConfigSnippet[];
    providerEndpoints: SmartDeepInspectionEndpoint[];
    gatewayRoutes: SmartGatewayRoute[];
    initialCalls: ExtractedCall[];
    fallbackReasons: SmartFallbackReason[];
    pairConfidence: number;
}

function normalizeAgentServiceName(
    requestedServiceName: string | undefined,
    pair: SmartAgentPairContext,
): 'consumer' | 'provider' {
    const normalized = normalizeServiceName((requestedServiceName ?? '').trim());
    if (normalized === normalizeServiceName(pair.providerServiceName)) {
        return 'provider';
    }
    return 'consumer';
}

function snippetAroundMatch(content: string, query: string): string {
    const normalizedContent = content.toLowerCase();
    const normalizedQuery = query.toLowerCase();
    const index = normalizedContent.indexOf(normalizedQuery);
    if (index < 0) {
        return content.slice(0, 220);
    }

    const start = Math.max(0, index - 80);
    const end = Math.min(content.length, index + normalizedQuery.length + 140);
    return content.slice(start, end);
}

function buildPairAgentTools(pair: SmartAgentPairContext): SmartDeepInspectionTools {
    const consumerFiles = new Map<string, SmartDeepInspectionFileContent>();
    const providerFiles = new Map<string, SmartDeepInspectionFileContent>();

    for (const file of [...pair.consumerEvidenceFiles, ...pair.configSnippets.map((snippet) => ({
        path: snippet.path,
        content: snippet.snippet,
    }))]) {
        consumerFiles.set(file.path, { path: file.path, content: file.content });
    }
    for (const file of pair.providerEvidenceFiles) {
        providerFiles.set(file.path, { path: file.path, content: file.content });
    }

    return {
        searchFiles: async ({ serviceName, query, limit }) => {
            const target = normalizeAgentServiceName(serviceName, pair) === 'provider'
                ? providerFiles
                : consumerFiles;
            const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
            if (terms.length === 0) return [];

            return [...target.values()]
                .map((file) => {
                    const lower = file.content.toLowerCase();
                    const score = terms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
                    if (score === 0) return null;
                    return {
                        score,
                        hit: {
                            path: file.path,
                            snippet: snippetAroundMatch(file.content, query),
                        },
                    };
                })
                .filter((value): value is { score: number; hit: SmartDeepInspectionSearchHit } => value !== null)
                .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path))
                .slice(0, Math.max(1, limit))
                .map((value) => value.hit);
        },
        readFile: async ({ serviceName, path }) => {
            const target = normalizeAgentServiceName(serviceName, pair) === 'provider'
                ? providerFiles
                : consumerFiles;
            return target.get(path) ?? null;
        },
        listServiceEndpoints: async ({ serviceName }) => {
            const target = normalizeAgentServiceName(serviceName, pair);
            if (target !== 'provider') return [];
            return pair.providerEndpoints.map((endpoint) => ({
                method: endpoint.method,
                path: endpoint.path,
            }));
        },
        listGatewayRoutes: async ({ serviceName }) => {
            const target = normalizeAgentServiceName(serviceName, pair);
            if (target !== 'consumer') return [];
            return pair.gatewayRoutes.map((route) => ({
                ...route,
            }));
        },
    };
}

function buildAgentStepPrompt(
    pair: SmartAgentPairContext,
    observations: string[],
    stepNumber: number,
    maxSteps: number,
): string {
    const initialCalls = pair.initialCalls.length > 0
        ? JSON.stringify(pair.initialCalls, null, 2)
        : '[]';
    const endpoints = pair.providerEndpoints.length > 0
        ? pair.providerEndpoints.map((endpoint) => `- ${endpoint.method} ${endpoint.path}`).join('\n')
        : '(없음)';
    const gatewayRoutes = pair.gatewayRoutes.length > 0
        ? pair.gatewayRoutes.map((route) => (
            `- ${route.kind} ${route.prefix}${route.routePath} -> ${route.serviceName} (stripPrefix=${route.stripPrefix})`
        )).join('\n')
        : '(없음)';
    const fallbackReasonText = pair.fallbackReasons.length > 0 ? pair.fallbackReasons.join(', ') : '(없음)';
    const observationText = observations.length > 0 ? observations.join('\n\n') : '(없음)';

    return `당신은 pair-local atomic call recovery agent 입니다.

현재 pair:
- consumer: ${pair.consumerServiceName}
- provider: ${pair.providerServiceName}
- pairConfidence: ${pair.pairConfidence}
- fallbackReasons: ${fallbackReasonText}
- step: ${stepNumber}/${maxSteps}

초기 LLM 호출 추출 결과:
${initialCalls}

Provider endpoint 목록:
${endpoints}

Consumer gateway route 목록:
${gatewayRoutes}

지금까지의 tool observation:
${observationText}

가능한 action:
1. search_files
2. read_file
3. list_service_endpoints
4. list_gateway_routes
5. finish

규칙:
- repo 전체를 추론하지 말고 현재 pair만 다뤄라.
- serviceName은 "${pair.consumerServiceName}" 또는 "${pair.providerServiceName}" 중 하나만 사용해라.
- finish 시 calls는 provider endpoint에 맞는 method/path만 반환해라.
- 근거가 부족하면 calls=[] 로 finish 해라.

JSON으로만 답해라.
{
  "action": "search_files" | "read_file" | "list_service_endpoints" | "list_gateway_routes" | "finish",
  "serviceName": "<optional>",
  "query": "<optional>",
  "path": "<optional>",
  "limit": <optional number>,
  "calls": <optional ExtractedCall[]>,
  "rationale": "<짧은 이유>"
}`;
}

async function runLlmAtomicAgent(
    pair: SmartAgentPairContext,
    generateAgentStep: LlmGenerateFn<SmartAtomicAgentStep>,
    budgetOverrides: Partial<SmartDeepInspectionToolBudget> | undefined,
    maxSteps: number | undefined,
): Promise<{ calls: ExtractedCall[]; toolUsage: SmartDeepInspectionToolUsage; status: SmartDeepInspectionStatus }> {
    const tools = buildPairAgentTools(pair);
    const budget = createDeepInspectionBudget(budgetOverrides);
    const usage = createDeepInspectionToolUsage();
    const observations: string[] = [];
    const stepLimit = Math.max(1, maxSteps ?? 5);

    for (let step = 1; step <= stepLimit; step += 1) {
        const decision = await generateAgentStep(buildAgentStepPrompt(pair, observations, step, stepLimit));
        switch (decision.action) {
            case 'search_files': {
                if (!consumeToolBudget(usage, budget, 'search')) {
                    observations.push('search_files 예산 초과');
                    continue;
                }
                const serviceName = normalizeAgentServiceName(decision.serviceName, pair) === 'provider'
                    ? pair.providerServiceName
                    : pair.consumerServiceName;
                const query = decision.query?.trim() ?? '';
                const hits = await tools.searchFiles({
                    serviceName,
                    query,
                    limit: Math.max(1, Math.min(5, decision.limit ?? 3)),
                });
                observations.push(
                    `search_files(service=${serviceName}, query=${query}) => ${JSON.stringify(hits, null, 2)}`,
                );
                continue;
            }
            case 'read_file': {
                if (!consumeToolBudget(usage, budget, 'read')) {
                    observations.push('read_file 예산 초과');
                    continue;
                }
                const serviceName = normalizeAgentServiceName(decision.serviceName, pair) === 'provider'
                    ? pair.providerServiceName
                    : pair.consumerServiceName;
                const path = decision.path?.trim() ?? '';
                const file = await tools.readFile({ serviceName, path });
                observations.push(
                    `read_file(service=${serviceName}, path=${path}) => ${JSON.stringify(file, null, 2)}`,
                );
                continue;
            }
            case 'list_service_endpoints': {
                if (!consumeToolBudget(usage, budget, 'endpointList')) {
                    observations.push('list_service_endpoints 예산 초과');
                    continue;
                }
                const serviceName = pair.providerServiceName;
                const endpoints = await tools.listServiceEndpoints({ serviceName });
                observations.push(
                    `list_service_endpoints(service=${serviceName}) => ${JSON.stringify(endpoints, null, 2)}`,
                );
                continue;
            }
            case 'list_gateway_routes': {
                if (!tools.listGatewayRoutes) {
                    observations.push('list_gateway_routes tool 미지원');
                    continue;
                }
                if (!consumeToolBudget(usage, budget, 'gatewayRoute')) {
                    observations.push('list_gateway_routes 예산 초과');
                    continue;
                }
                const serviceName = pair.consumerServiceName;
                const routes = await tools.listGatewayRoutes({ serviceName });
                observations.push(
                    `list_gateway_routes(service=${serviceName}) => ${JSON.stringify(routes, null, 2)}`,
                );
                continue;
            }
            case 'finish':
            default: {
                const calls = sanitizeRecoveredCalls(decision.calls, pair.providerServiceName);
                return {
                    calls,
                    toolUsage: cloneDeepInspectionToolUsage(usage),
                    status: calls.length > 0 ? 'succeeded' : 'no_result',
                };
            }
        }
    }

    return {
        calls: [],
        toolUsage: cloneDeepInspectionToolUsage(usage),
        status: 'no_result',
    };
}

async function annotateExistingSmartFallbackCandidate(
    db: DbClient,
    params: {
        workspaceId: string;
        subjectObjectId: string;
        objectId: string;
        targetServiceId: string;
        fallbackReason: SmartFallbackReason;
        analysisMode: 'pair_pack' | 'agent_deep_inspection' | 'full_agent';
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
                analysisMode: params.analysisMode,
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

function normalizeGatewayPath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0) return '/';
    let normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    normalized = normalized.replace(/\/+/g, '/');
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/g, '');
    }
    return normalized.length > 0 ? normalized : '/';
}

function normalizeGatewayPrefix(prefix: string | null | undefined): string {
    if (!prefix) return '';
    const normalized = normalizeGatewayPath(prefix);
    return normalized === '/' ? '' : normalized;
}

function extractRouteBasePath(routePath: string): string {
    const normalized = normalizeGatewayPath(routePath)
        .replace(/\/\*\*$/u, '')
        .replace(/\/\*$/u, '');
    return normalized.length > 0 ? normalized : '/';
}

function joinGatewayPaths(...segments: string[]): string {
    const joined = segments
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && segment !== '/')
        .map((segment) => segment.replace(/^\/+/u, '').replace(/\/+$/u, ''))
        .filter((segment) => segment.length > 0)
        .join('/');
    return joined.length > 0 ? `/${joined}` : '/';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBooleanOrUndefined(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return undefined;
}

function parseProperties(content: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
        const separatorIndex = (() => {
            const equals = line.indexOf('=');
            const colon = line.indexOf(':');
            if (equals < 0) return colon;
            if (colon < 0) return equals;
            return Math.min(equals, colon);
        })();
        if (separatorIndex < 0) continue;
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (key.length === 0) continue;
        values.set(key, value);
    }
    return values;
}

function parseZuulRoutesFromYamlObject(
    filePath: string,
    document: unknown,
): SmartGatewayRoute[] {
    if (!isRecord(document)) return [];
    const zuul = document['zuul'];
    if (!isRecord(zuul)) return [];
    const prefix = normalizeGatewayPrefix(typeof zuul['prefix'] === 'string' ? zuul['prefix'] : null);
    const globalStripPrefix = asBooleanOrUndefined(zuul['stripPrefix'] ?? zuul['strip-prefix']);
    const routes = zuul['routes'];
    if (!isRecord(routes)) return [];

    const parsedRoutes: SmartGatewayRoute[] = [];
    for (const [routeId, routeValue] of Object.entries(routes)) {
        if (!isRecord(routeValue)) continue;
        const serviceId = routeValue['serviceId'] ?? routeValue['service-id'];
        const routePath = routeValue['path'];
        if (typeof serviceId !== 'string' || typeof routePath !== 'string') continue;
        const normalizedServiceName = serviceId.trim();
        const normalizedRoutePath = normalizeGatewayPath(routePath);
        if (normalizedServiceName.length === 0 || normalizedRoutePath.length === 0) continue;
        const stripPrefix = asBooleanOrUndefined(
            routeValue['stripPrefix'] ?? routeValue['strip-prefix'],
        ) ?? globalStripPrefix ?? true;
        parsedRoutes.push({
            kind: 'zuul',
            configPath: filePath,
            routeId,
            serviceName: normalizedServiceName,
            routePath: normalizedRoutePath,
            routeBasePath: extractRouteBasePath(normalizedRoutePath),
            prefix,
            stripPrefix,
        });
    }

    return parsedRoutes;
}

function parseZuulRoutesFromProperties(
    filePath: string,
    properties: Map<string, string>,
): SmartGatewayRoute[] {
    const prefix = normalizeGatewayPrefix(properties.get('zuul.prefix'));
    const globalStripPrefix = asBooleanOrUndefined(properties.get('zuul.stripPrefix') ?? properties.get('zuul.strip-prefix'));
    const routeState = new Map<string, { serviceName?: string; routePath?: string; stripPrefix?: boolean }>();

    for (const [key, value] of properties.entries()) {
        const match = key.match(/^zuul\.routes\.([^.]+)\.(serviceId|service-id|path|stripPrefix|strip-prefix)$/u);
        if (!match) continue;
        const routeId = match[1] ?? '';
        const field = match[2] ?? '';
        if (routeId.length === 0 || field.length === 0) continue;
        const current = routeState.get(routeId) ?? {};
        if (field === 'serviceId' || field === 'service-id') {
            current.serviceName = value.trim();
        } else if (field === 'path') {
            current.routePath = normalizeGatewayPath(value);
        } else {
            const stripPrefix = asBooleanOrUndefined(value);
            if (stripPrefix !== undefined) {
                current.stripPrefix = stripPrefix;
            }
        }
        routeState.set(routeId, current);
    }

    const parsedRoutes: SmartGatewayRoute[] = [];
    for (const [routeId, route] of routeState.entries()) {
        if (!route.serviceName || !route.routePath) continue;
        parsedRoutes.push({
            kind: 'zuul',
            configPath: filePath,
            routeId,
            serviceName: route.serviceName,
            routePath: route.routePath,
            routeBasePath: extractRouteBasePath(route.routePath),
            prefix,
            stripPrefix: route.stripPrefix ?? globalStripPrefix ?? true,
        });
    }

    return parsedRoutes;
}

function collectGatewayRoutes(configFiles: FileContent[]): SmartGatewayRoute[] {
    const deduped = new Map<string, SmartGatewayRoute>();

    for (const file of configFiles) {
        const extension = extname(file.absPath).toLowerCase();
        let parsedRoutes: SmartGatewayRoute[] = [];
        if (extension === '.yml' || extension === '.yaml') {
            try {
                parsedRoutes = parseZuulRoutesFromYamlObject(file.absPath, yaml.load(file.content));
            } catch {
                parsedRoutes = [];
            }
        } else if (extension === '.properties') {
            parsedRoutes = parseZuulRoutesFromProperties(file.absPath, parseProperties(file.content));
        }

        for (const route of parsedRoutes) {
            const key = [
                route.kind,
                normalizeServiceName(route.serviceName),
                route.routeId,
                route.routePath,
                route.prefix,
                route.configPath,
            ].join('::');
            if (!deduped.has(key)) {
                deduped.set(key, route);
            }
        }
    }

    return [...deduped.values()];
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
        const matchedIndexes = lines
            .map((line, index) => {
                const lower = line.toLowerCase();
                return indicators.some((ind) => ind.length > 0 && lower.includes(ind))
                    ? index
                    : -1;
            })
            .filter((index) => index >= 0);
        if (matchedIndexes.length === 0) continue;

        const includedIndexes = new Set<number>();
        for (const matchIndex of matchedIndexes) {
            const start = Math.max(0, matchIndex - 6);
            const end = Math.min(lines.length - 1, matchIndex + 6);
            for (let index = start; index <= end; index += 1) {
                includedIndexes.add(index);
            }
        }

        const snippetLines = [...includedIndexes]
            .sort((a, b) => a - b)
            .map((index) => lines[index] ?? '')
            .filter((line) => line.trim().length > 0);
        if (snippetLines.length === 0) continue;

        snippets.push({
            path: `config/${file.path}`,
            snippet: snippetLines.join('\n'),
        });
    }
    return snippets;
}

function stripInlineComment(value: string): string {
    const commentIndex = value.indexOf('#');
    if (commentIndex < 0) {
        return value.trim();
    }
    return value.slice(0, commentIndex).trim();
}

function normalizeConfigValue(rawValue: string): string {
    const trimmed = stripInlineComment(rawValue);
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function collectConfigPropertiesFromSnippets(configSnippets: ConfigSnippet[]): Map<string, string> {
    const properties = new Map<string, string>();

    for (const snippet of configSnippets) {
        const lines = snippet.snippet.split('\n');
        const yamlStack: Array<{ indent: number; key: string }> = [];

        for (const rawLine of lines) {
            const normalizedLine = rawLine.replace(/\t/g, '    ').trimEnd();
            const trimmed = normalizedLine.trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                continue;
            }

            const propertyMatch = normalizedLine.match(/^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.+?)\s*$/);
            if (propertyMatch && propertyMatch[1]?.includes('.')) {
                properties.set(
                    propertyMatch[1],
                    normalizeConfigValue(propertyMatch[2] ?? ''),
                );
                continue;
            }

            const indent = normalizedLine.length - normalizedLine.trimStart().length;
            const yamlMatch = normalizedLine.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
            if (!yamlMatch) {
                continue;
            }

            while (yamlStack.length > 0 && indent <= (yamlStack[yamlStack.length - 1]?.indent ?? -1)) {
                yamlStack.pop();
            }

            const key = yamlMatch[1] ?? '';
            const value = yamlMatch[2] ?? '';
            const fullKey = [...yamlStack.map((entry) => entry.key), key].join('.');
            if (value.length === 0) {
                yamlStack.push({ indent, key });
                continue;
            }

            properties.set(fullKey, normalizeConfigValue(value));
        }
    }

    return properties;
}

function parseZuulRoutesFromConfigSnippets(configSnippets: ConfigSnippet[]): ZuulRouteDefinition[] {
    const properties = collectConfigPropertiesFromSnippets(configSnippets);
    const prefix = properties.get('zuul.prefix') ?? '';
    const routesByAlias = new Map<string, Partial<ZuulRouteDefinition>>();

    for (const [key, value] of properties.entries()) {
        const match = key.match(/^zuul\.routes\.([A-Za-z0-9_-]+)\.(path|serviceId)$/);
        if (!match) {
            continue;
        }

        const alias = match[1] ?? '';
        const field = match[2] ?? '';
        const route = routesByAlias.get(alias) ?? {};
        if (field === 'path') {
            route.routePath = value;
        } else if (field === 'serviceId') {
            route.serviceId = value;
        }
        routesByAlias.set(alias, route);
    }

    return [...routesByAlias.values()]
        .map((route) => ({
            prefix,
            routePath: route.routePath?.trim() ?? '',
            serviceId: route.serviceId?.trim() ?? '',
        }))
        .filter((route) => route.routePath.length > 0 && route.serviceId.length > 0);
}

function trimZuulWildcardSuffix(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
        return '';
    }

    const wildcardIndex = trimmed.indexOf('*');
    const basePath = wildcardIndex >= 0 ? trimmed.slice(0, wildcardIndex) : trimmed;
    const comparablePath = extractComparablePath(basePath);
    if (comparablePath === '/') {
        return '';
    }
    return comparablePath;
}

function joinRoutePath(...parts: string[]): string {
    const normalizedParts = parts
        .map((part) => extractComparablePath(part))
        .filter((part) => part.length > 0 && part !== '/')
        .map((part) => part.replace(/^\/+|\/+$/g, ''));
    if (normalizedParts.length === 0) {
        return '/';
    }
    return `/${normalizedParts.join('/')}`;
}

function buildExternalEndpointCandidates(
    prefix: string,
    routePath: string,
    endpointPath: string,
): string[] {
    const routeBasePath = trimZuulWildcardSuffix(routePath);
    const prefixPath = extractComparablePath(prefix);
    const endpointComparablePath = extractComparablePath(endpointPath);
    const normalizedRouteBase = routeBasePath === '/' ? '' : routeBasePath;
    const normalizedPrefix = prefixPath === '/' ? '' : prefixPath;

    const candidates = new Set<string>();
    const prefixedRouteBase = joinRoutePath(normalizedPrefix, normalizedRouteBase);

    if (endpointComparablePath.length === 0 || endpointComparablePath === '/') {
        candidates.add(prefixedRouteBase);
    } else {
        candidates.add(joinRoutePath(normalizedPrefix, normalizedRouteBase, endpointComparablePath));
        if (normalizedRouteBase.length > 0 && isEndpointPathCompatible(endpointComparablePath, normalizedRouteBase)) {
            candidates.add(joinRoutePath(normalizedPrefix, endpointComparablePath));
        }
        if (
            normalizedPrefix.length > 0
            && isEndpointPathCompatible(endpointComparablePath, joinRoutePath(normalizedPrefix, normalizedRouteBase))
        ) {
            candidates.add(endpointComparablePath);
        }
    }

    return [...candidates].filter((candidate) => candidate.length > 0);
}

function findZuulRouteAwareEndpointMatch(
    call: ExtractedCall,
    targetServiceName: string,
    endpoints: Array<{ method: string; path: string; id: string }>,
    configSnippets: ConfigSnippet[],
): { endpointId: string; externalPath: string } | null {
    if (endpoints.length === 0 || configSnippets.length === 0) {
        return null;
    }

    const normalizedTargetServiceName = normalizeServiceName(targetServiceName);
    const normalizedMethod = call.httpMethod.trim().toUpperCase();
    const routes = parseZuulRoutesFromConfigSnippets(configSnippets).filter((route) => (
        normalizeServiceName(route.serviceId) === normalizedTargetServiceName
    ));
    if (routes.length === 0) {
        return null;
    }

    const matches = new Map<string, { endpointId: string; externalPath: string }>();
    for (const route of routes) {
        for (const endpoint of endpoints) {
            if (endpoint.method.toUpperCase() !== normalizedMethod) {
                continue;
            }

            const externalCandidates = buildExternalEndpointCandidates(
                route.prefix,
                route.routePath,
                endpoint.path,
            );
            for (const externalCandidate of externalCandidates) {
                if (!isEndpointPathCompatible(call.path, externalCandidate)) {
                    continue;
                }
                matches.set(endpoint.id, {
                    endpointId: endpoint.id,
                    externalPath: externalCandidate,
                });
            }
        }
    }

    if (matches.size !== 1) {
        return null;
    }
    return [...matches.values()][0] ?? null;
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

interface SmartEndpointRouteAlias {
    path: string;
    routeKind: SmartGatewayRoute['kind'];
    routeId: string;
    routePath: string;
    routeBasePath: string;
    configPath: string;
    externalPrefix: string;
    internalPath: string;
    serviceName: string;
}

interface SmartTargetEndpoint {
    method: string;
    path: string;
    id: string;
    routeAliases?: SmartEndpointRouteAlias[];
}

function filterGatewayRoutesForProvider(
    gatewayRoutes: SmartGatewayRoute[],
    providerServiceName: string,
): SmartGatewayRoute[] {
    const normalizedProviderName = normalizeServiceName(providerServiceName);
    return gatewayRoutes.filter((route) => normalizeServiceName(route.serviceName) === normalizedProviderName);
}

function buildRouteAliasPath(
    route: SmartGatewayRoute,
    endpointPath: string,
): string | null {
    if (!route.stripPrefix) {
        return null;
    }

    const normalizedEndpointPath = normalizePath(endpointPath);
    if (normalizedEndpointPath.length === 0) {
        return null;
    }
    if (normalizedEndpointPath === '/') {
        return joinGatewayPaths(route.prefix, route.routeBasePath);
    }
    return joinGatewayPaths(route.prefix, route.routeBasePath, normalizedEndpointPath);
}

function buildRouteAwareTargetEndpoints(
    providerServiceName: string,
    providerEndpoints: Array<{ method: string; path: string; id: string }>,
    gatewayRoutes: SmartGatewayRoute[],
): SmartTargetEndpoint[] {
    const matchingRoutes = filterGatewayRoutesForProvider(gatewayRoutes, providerServiceName);
    return providerEndpoints.map((endpoint) => {
        const routeAliases = matchingRoutes.flatMap((route) => {
            const aliasPath = buildRouteAliasPath(route, endpoint.path);
            if (!aliasPath) return [];
            return [{
                path: aliasPath,
                routeKind: route.kind,
                routeId: route.routeId,
                routePath: route.routePath,
                routeBasePath: route.routeBasePath,
                configPath: route.configPath,
                externalPrefix: route.prefix,
                internalPath: endpoint.path,
                serviceName: route.serviceName,
            }];
        });

        return {
            ...endpoint,
            routeAliases,
        };
    });
}

function buildGatewayRecoveredCalls(
    providerServiceName: string,
    providerEndpoints: SmartTargetEndpoint[],
): ExtractedCall[] {
    const deduped = new Map<string, ExtractedCall>();

    for (const endpoint of providerEndpoints) {
        for (const alias of endpoint.routeAliases ?? []) {
            const normalizedMethod = endpoint.method.trim().toUpperCase();
            const normalizedPath = alias.path.trim();
            if (normalizedMethod.length === 0 || normalizedPath.length === 0) continue;

            const key = `${normalizedMethod}::${normalizePath(normalizedPath)}`;
            if (deduped.has(key)) continue;
            deduped.set(key, {
                targetService: providerServiceName,
                httpMethod: normalizedMethod,
                path: normalizedPath,
                sourceFile: relative(process.cwd(), alias.configPath),
                evidence: `${alias.routeKind} route ${alias.routePath} -> ${alias.serviceName} mapped to ${alias.internalPath}`,
                confidence: 0.89,
            });
        }
    }

    return [...deduped.values()];
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
    allDependencies: SmartConfigDependencyHit[];
    servicePairCount: number;
}> {
    const knownServiceNames = allServices.map((s) => s.name);
    const consumerSet = new Set<string>();
    const allDeps: SmartConfigDependencyHit[] = [];
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
                return content ? { absPath: fp, path: relative(configDir!, fp), content } : null;
            })
            .filter((f): f is FileContent => f !== null);

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
                allDeps.push({
                    sourceServiceId: service.id,
                    dep,
                    evidenceFilePath: resolveConfigEvidenceFilePath(configContents, dep.evidence),
                });
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
    allDeps: SmartConfigDependencyHit[],
): Promise<number> {
    let created = 0;

    for (const { sourceServiceId, dep, evidenceFilePath } of allDeps) {
        const targetServiceId = findServiceId(dep.targetService, allServices);
        if (!targetServiceId || targetServiceId === sourceServiceId) continue;

        // evidence 생성
        const evidenceId = generateId();
        await db.insert(evidences).values({
            id: evidenceId,
            workspaceId,
            evidenceType: 'LLM_CONFIG',
            filePath: evidenceFilePath ?? '__smart__/llm-config-analysis',
            lineStart: null,
            lineEnd: null,
            excerpt: dep.evidence.slice(0, 4000),
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
    allDependencies: SmartConfigDependencyHit[],
): Promise<{
    analysisMode: SmartAtomicAnalysisMode;
    analyzedServiceCount: number;
    endpointCallCount: number;
    candidateCount: number;
    atomicCandidateCount: number;
    serviceFallbackCount: number;
    fallbackReasonBreakdown: SmartFallbackReasonBreakdown;
    deepInspectionCount: number;
    deepInspectionTrace: SmartDeepInspectionTrace;
    agentEscalatedPairCount: number;
    agentRecoveredAtomicCount: number;
    agentFailedPairCount: number;
    agentToolUsageSummary: SmartDeepInspectionToolUsage;
}> {
    const { workspaceId } = options;
    const filterKeywords = options.sourceFilterKeywords ?? DEFAULT_FILTER_KEYWORDS;
    const analysisMode = options.atomicAnalysisMode ?? 'pair_pack';

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
    let agentEscalatedPairCount = 0;
    let agentRecoveredAtomicCount = 0;
    let agentFailedPairCount = 0;
    const fallbackReasonBreakdown = createFallbackReasonBreakdown();
    const deepInspectionTrace = createDeepInspectionTrace();
    let agentToolUsageSummary = createDeepInspectionToolUsage();

    for (const consumerId of consumerServiceIds) {
        const consumer = allServices.find((s) => s.id === consumerId);
        if (!consumer) continue;

        const sourceDir = resolveServiceDirectory(consumer, options.repoRoots);
        if (!sourceDir) continue;

        const consumerSourceFiles = collectSourceFiles(sourceDir);
        const consumerConfigFiles = collectConfigFiles(sourceDir);
        const consumerGatewayRoutes = collectGatewayRoutes(consumerConfigFiles);

        if (consumerSourceFiles.length === 0 && consumerGatewayRoutes.length === 0) continue;

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
            const gatewayRoutesForProvider = filterGatewayRoutesForProvider(
                consumerGatewayRoutes,
                provider.name,
            );
            const routeAwareProviderEndpoints = buildRouteAwareTargetEndpoints(
                provider.name,
                providerEndpoints,
                gatewayRoutesForProvider,
            );

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
            const pairTargetEndpoints = [{
                serviceName: provider.name,
                serviceId: provider.id,
                endpoints: routeAwareProviderEndpoints,
            }];
            const agentPairContext: SmartAgentPairContext = {
                consumerServiceName: consumer.name,
                providerServiceName: provider.name,
                consumerEvidenceFiles,
                providerEvidenceFiles,
                configSnippets,
                providerEndpoints: providerEndpoints.map((endpoint) => ({
                    method: endpoint.method.toUpperCase(),
                    path: endpoint.path,
                })),
                gatewayRoutes: gatewayRoutesForProvider,
                initialCalls: [],
                fallbackReasons: [],
                pairConfidence,
            };

            if (analysisMode === 'full_agent' && options.generateAgentStep) {
                analyzedCount += 1;
                agentEscalatedPairCount += 1;
                deepInspectionCount += 1;
                deepInspectionTrace.attemptedCount += 1;

                const detail: SmartDeepInspectionTraceDetail = {
                    consumerServiceName: consumer.name,
                    providerServiceName: provider.name,
                    trigger: {
                        lowConfidence: false,
                        insufficientContext: false,
                        pathNotMatched: false,
                        noEndpointObjects: false,
                    },
                    status: 'no_result',
                    fallbackReasons: [],
                    toolUsage: createDeepInspectionToolUsage(),
                    recoveredCalls: [],
                };

                try {
                    const generateAgentStep = options.generateAgentStep;
                    if (!generateAgentStep) {
                        throw new Error('generateAgentStep is required for full_agent mode');
                    }
                    const agentResult = await runLlmAtomicAgent(
                        agentPairContext,
                        generateAgentStep as LlmGenerateFn<SmartAtomicAgentStep>,
                        options.deepInspectionBudget,
                        options.agentMaxSteps,
                    );
                    detail.status = agentResult.status;
                    detail.toolUsage = agentResult.toolUsage;
                    detail.recoveredCalls = buildRecoveredCallSummaries(agentResult.calls);
                    agentToolUsageSummary = mergeDeepInspectionToolUsage(
                        agentToolUsageSummary,
                        agentResult.toolUsage,
                    );

                    for (const call of agentResult.calls) {
                        totalCalls += 1;
                        const saved = await saveLlmCallCandidate(
                            db,
                            workspaceId,
                            consumerId,
                            call,
                            allServices,
                            pairTargetEndpoints,
                            configSnippets,
                            'full_agent',
                        );
                        if (saved.created) {
                            candidateCount += 1;
                        }
                        if (saved.targetType === 'api_endpoint') {
                            if (saved.created) {
                                atomicCandidateCount += 1;
                                agentRecoveredAtomicCount += 1;
                            }
                        } else if (saved.fallbackReason) {
                            serviceFallbackCount += 1;
                            fallbackReasonBreakdown[saved.fallbackReason] += 1;
                            detail.fallbackReasons.push(saved.fallbackReason);
                        }
                    }
                } catch (error) {
                    agentFailedPairCount += 1;
                    deepInspectionTrace.failureCount += 1;
                    detail.status = 'failed';
                    console.error(
                        `[SmartPipeline] Full-agent atomic 분석 실패: ${consumer.name} -> ${provider.name}`,
                        error,
                    );
                }

                deepInspectionTrace.details.push(detail);
                continue;
            }

            try {
                const result = await options.generateCallExtraction(prompt);
                analyzedCount += 1;
                totalCalls += result.calls.length;
                const fallbackReasons: SmartFallbackReason[] = [];
                for (const call of result.calls) {
                    const saved = await saveLlmCallCandidate(
                        db, workspaceId, consumerId, call,
                        allServices, pairTargetEndpoints, configSnippets, 'pair_pack',
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
                if (
                    result.calls.length === 0
                    && gatewayRoutesForProvider.length > 0
                    && providerEndpoints.length > 0
                ) {
                    fallbackReasons.push('INSUFFICIENT_CONTEXT');
                }
                agentPairContext.initialCalls = result.calls;
                agentPairContext.fallbackReasons = [...fallbackReasons];

                const hasDeepInspectionRunner = Boolean(options.runDeepInspection || options.deepInspectionTools);
                const shouldEscalateToAgent =
                    analysisMode === 'agent_assisted'
                    && options.generateAgentStep
                    && shouldRunDeepInspection(pairConfidence, fallbackReasons);
                if (shouldEscalateToAgent) {
                    const trigger = buildDeepInspectionTrigger(pairConfidence, fallbackReasons);
                    recordDeepInspectionTrigger(deepInspectionTrace, trigger);
                    agentEscalatedPairCount += 1;
                    deepInspectionCount += 1;
                    deepInspectionTrace.attemptedCount += 1;

                    const detail: SmartDeepInspectionTraceDetail = {
                        consumerServiceName: consumer.name,
                        providerServiceName: provider.name,
                        trigger,
                        status: 'no_result',
                        fallbackReasons: [...new Set(fallbackReasons)],
                        toolUsage: createDeepInspectionToolUsage(),
                        recoveredCalls: [],
                    };

                    try {
                        const generateAgentStep = options.generateAgentStep;
                        if (!generateAgentStep) {
                            throw new Error('generateAgentStep is required for agent_assisted mode');
                        }
                        const agentResult = await runLlmAtomicAgent(
                            agentPairContext,
                            generateAgentStep as LlmGenerateFn<SmartAtomicAgentStep>,
                            options.deepInspectionBudget,
                            options.agentMaxSteps,
                        );
                        detail.status = agentResult.status;
                        detail.toolUsage = agentResult.toolUsage;
                        detail.recoveredCalls = buildRecoveredCallSummaries(agentResult.calls);
                        agentToolUsageSummary = mergeDeepInspectionToolUsage(
                            agentToolUsageSummary,
                            agentResult.toolUsage,
                        );

                        for (const call of agentResult.calls) {
                            totalCalls += 1;
                            const saved = await saveLlmCallCandidate(
                                db,
                                workspaceId,
                                consumerId,
                                call,
                                allServices,
                                pairTargetEndpoints,
                                configSnippets,
                                'agent_deep_inspection',
                            );
                            if (saved.created) {
                                candidateCount += 1;
                            }
                            if (saved.targetType === 'api_endpoint') {
                                if (saved.created) {
                                    atomicCandidateCount += 1;
                                    agentRecoveredAtomicCount += 1;
                                }
                            } else if (saved.fallbackReason) {
                                serviceFallbackCount += 1;
                                fallbackReasonBreakdown[saved.fallbackReason] += 1;
                            }
                        }
                    } catch (error) {
                        agentFailedPairCount += 1;
                        deepInspectionTrace.failureCount += 1;
                        detail.status = 'failed';
                        console.error(
                            `[SmartPipeline] Agent atomic deep inspection 실패: ${consumer.name} -> ${provider.name}`,
                            error,
                        );
                    }

                    deepInspectionTrace.details.push(detail);
                } else if (hasDeepInspectionRunner && shouldRunDeepInspection(pairConfidence, fallbackReasons)) {
                    const trigger = buildDeepInspectionTrigger(pairConfidence, fallbackReasons);
                    recordDeepInspectionTrigger(deepInspectionTrace, trigger);
                    deepInspectionCount += 1;
                    deepInspectionTrace.attemptedCount += 1;

                    const detail: SmartDeepInspectionTraceDetail = {
                        consumerServiceName: consumer.name,
                        providerServiceName: provider.name,
                        trigger,
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
                                    allServices, pairTargetEndpoints, configSnippets, 'agent_deep_inspection',
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
        analysisMode,
        analyzedServiceCount: analyzedCount,
        endpointCallCount: totalCalls,
        candidateCount,
        atomicCandidateCount,
        serviceFallbackCount,
        fallbackReasonBreakdown,
        deepInspectionCount,
        deepInspectionTrace,
        agentEscalatedPairCount,
        agentRecoveredAtomicCount,
        agentFailedPairCount,
        agentToolUsageSummary,
    };
}

/** LLM이 추출한 call을 relation candidate로 저장 */
async function saveLlmCallCandidate(
    db: DbClient,
    workspaceId: string,
    sourceServiceId: string,
    call: ExtractedCall,
    allServices: ServiceRecord[],
    targetEndpoints: Array<{ serviceName: string; serviceId: string; endpoints: SmartTargetEndpoint[] }>,
    configSnippets: ConfigSnippet[],
    analysisMode: 'pair_pack' | 'agent_deep_inspection' | 'full_agent',
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
    let routeAwareExternalPath: string | undefined;
    let routeInterpretation: SmartEndpointRouteAlias | undefined;

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
            const exactAliasMatches = targetService.endpoints.filter((ep) => (
                ep.method.toUpperCase() === normalizedMethod
                && (ep.routeAliases ?? []).some((alias) => normalizePath(alias.path) === normalizedPath)
            ));
            if (exactAliasMatches.length === 1) {
                const exactAliasMatch = exactAliasMatches[0];
                targetObjectId = exactAliasMatch?.id ?? targetServiceId;
                targetType = 'api_endpoint';
                routeInterpretation = exactAliasMatch?.routeAliases?.find(
                    (alias) => normalizePath(alias.path) === normalizedPath,
                );
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
                const compatibleAliasMatches = targetService.endpoints.filter((ep) => (
                    ep.method.toUpperCase() === normalizedMethod
                    && (ep.routeAliases ?? []).some((alias) => isEndpointPathCompatible(normalizedCallPath, alias.path))
                ));
                if (compatibleAliasMatches.length === 1) {
                    const compatibleAliasMatch = compatibleAliasMatches[0];
                    targetObjectId = compatibleAliasMatch?.id ?? targetServiceId;
                    targetType = 'api_endpoint';
                    routeInterpretation = compatibleAliasMatch?.routeAliases?.find(
                        (alias) => isEndpointPathCompatible(normalizedCallPath, alias.path),
                    );
                } else {
                const samePathEndpoints = targetService.endpoints.filter(
                    (ep) => isEndpointPathCompatible(normalizedCallPath, ep.path),
                );
                    const sameAliasPathEndpoints = targetService.endpoints.filter((ep) => (
                        (ep.routeAliases ?? []).some((alias) => isEndpointPathCompatible(normalizedCallPath, alias.path))
                    ));
                    if (
                        (samePathEndpoints.length > 0 || sameAliasPathEndpoints.length > 0)
                        && compatibleMethodEndpoints.length === 0
                        && compatibleAliasMatches.length === 0
                    ) {
                        fallbackReason = 'METHOD_NOT_MATCHED';
                    } else {
                        fallbackReason = 'PATH_NOT_MATCHED';
                    }
                }
            }
            }
        }
    }

    if (
        targetType === 'service'
        && (fallbackReason === 'PATH_NOT_MATCHED' || fallbackReason === 'NO_ENDPOINT_OBJECTS')
        && targetService
    ) {
        const routeAwareMatch = findZuulRouteAwareEndpointMatch(
            call,
            targetService.serviceName,
            targetService.endpoints,
            configSnippets,
        );
        if (routeAwareMatch) {
            targetObjectId = routeAwareMatch.endpointId;
            targetType = 'api_endpoint';
            fallbackReason = undefined;
            routeAwareExternalPath = routeAwareMatch.externalPath;
            routeInterpretation = {
                path: routeAwareMatch.externalPath,
                routeKind: 'zuul',
                routeId: 'config-snippet',
                routePath: routeAwareMatch.externalPath,
                routeBasePath: routeAwareMatch.externalPath,
                configPath: configSnippets[0]?.path ?? '__smart__/config-snippet',
                externalPrefix: '',
                internalPath: call.path,
                serviceName: targetService.serviceName,
            };
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
                analysisMode,
                ...(routeInterpretation || routeAwareExternalPath
                    ? {
                        matchStrategy: 'route_mapping',
                        ...(routeAwareExternalPath ? { routeAwareExternalPath } : {}),
                    }
                    : { matchStrategy: 'call_path' }),
                ...(routeInterpretation
                    ? {
                        inferenceKind: 'proxy_route',
                        routeInterpretation: {
                            kind: routeInterpretation.routeKind,
                            routeId: routeInterpretation.routeId,
                            routePath: routeInterpretation.routePath,
                            routeBasePath: routeInterpretation.routeBasePath,
                            externalPrefix: routeInterpretation.externalPrefix,
                            externalPath: routeInterpretation.path,
                            internalPath: routeInterpretation.internalPath,
                            configPath: routeInterpretation.configPath,
                            serviceName: routeInterpretation.serviceName,
                        },
                    }
                    : {}),
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
            analysisMode,
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
            analysisMode: phase3Result.analysisMode,
            analyzedServiceCount: phase3Result.analyzedServiceCount,
            endpointCallCount: phase3Result.endpointCallCount,
            candidateCount: phase3Result.candidateCount,
            atomicCandidateCount: phase3Result.atomicCandidateCount,
            serviceFallbackCount: phase3Result.serviceFallbackCount,
            fallbackReasonBreakdown: phase3Result.fallbackReasonBreakdown,
            deepInspectionCount: phase3Result.deepInspectionCount,
            deepInspectionTrace: phase3Result.deepInspectionTrace,
            agentEscalatedPairCount: phase3Result.agentEscalatedPairCount,
            agentRecoveredAtomicCount: phase3Result.agentRecoveredAtomicCount,
            agentFailedPairCount: phase3Result.agentFailedPairCount,
            agentToolUsageSummary: phase3Result.agentToolUsageSummary,
        },
        totalDurationMs: Date.now() - startTime,
    };
}
