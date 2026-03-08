/**
 * OpenAPI 3.x / Swagger 2.x 스펙 파서
 * YAML/JSON 형식의 스펙 파일을 파싱하여 구조화된 엔드포인트 목록 반환
 */
import * as yaml from 'js-yaml';

// ─── 타입 정의 ─────────────────────────────────────────────────────────────────

/** 파싱된 개별 엔드포인트 */
export interface ParsedEndpoint {
    /** HTTP 메서드 (GET, POST, PUT, DELETE, PATCH 등) */
    method: string;
    /** 전체 경로 (basePath 포함) */
    path: string;
    /** operationId (있으면) */
    operationId?: string;
    /** 태그 목록 */
    tags: string[];
    /** 요약 설명 */
    summary?: string;
}

/** 스펙 파싱 결과 */
export interface ParsedSpec {
    /** 스펙 제목 (info.title) */
    title: string;
    /** 스펙 버전 (openapi / swagger 필드 값) */
    specVersion: string;
    /** 커스텀 확장: x-service-name */
    serviceName?: string;
    /** 파싱된 엔드포인트 목록 */
    endpoints: ParsedEndpoint[];
}

// HTTP 메서드 목록 (OpenAPI 표준)
const HTTP_METHODS = new Set([
    'get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace',
]);

// ─── 내부 유틸 ─────────────────────────────────────────────────────────────────

/** 값이 non-null 객체인지 확인 */
function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 안전하게 문자열 추출 */
function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 배열로 변환 (string[] 보장) */
function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

/**
 * 경로 정규화: 선행 슬래시 보장, 이중 슬래시 제거
 */
function normalizePath(basePath: string, path: string): string {
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const combined = `${base}${suffix}`;
    return combined.replace(/\/+/g, '/') || '/';
}

// ─── 파서 ──────────────────────────────────────────────────────────────────────

/**
 * OpenAPI/Swagger 스펙 문자열을 파싱하여 엔드포인트 목록 반환
 * YAML과 JSON 모두 지원
 */
export function parseOpenApiSpec(content: string): ParsedSpec | null {
    let doc: unknown;
    try {
        doc = yaml.load(content);
    } catch {
        // YAML 파싱 실패 시 JSON 시도
        try {
            doc = JSON.parse(content);
        } catch {
            return null;
        }
    }

    if (!isObject(doc)) return null;

    // OpenAPI 3.x vs Swagger 2.x 판별
    const openApiVersion = asString(doc['openapi']);
    const swaggerVersion = asString(doc['swagger']);

    if (!openApiVersion && !swaggerVersion) return null;

    const specVersion = openApiVersion ?? swaggerVersion ?? 'unknown';
    const isSwagger2 = !!swaggerVersion && swaggerVersion.startsWith('2');

    // info 블록
    const info = isObject(doc['info']) ? doc['info'] : {};
    const title = asString(info['title']) ?? 'Untitled';
    const serviceName = asString(doc['x-service-name']);

    // basePath (Swagger 2.x 전용, OpenAPI 3.x는 servers에서 추출 가능하나 단순화)
    let basePath = '/';
    if (isSwagger2) {
        basePath = asString(doc['basePath']) ?? '/';
    } else if (Array.isArray(doc['servers']) && doc['servers'].length > 0) {
        const firstServer = doc['servers'][0];
        if (isObject(firstServer)) {
            const serverUrl = asString(firstServer['url']);
            if (serverUrl) {
                try {
                    const url = new URL(serverUrl, 'http://placeholder');
                    basePath = url.pathname;
                } catch {
                    // URL 파싱 실패 시 직접 경로 추출
                    const pathMatch = serverUrl.match(/^https?:\/\/[^/]*(\/.*)/);
                    basePath = pathMatch?.[1] ?? '/';
                }
            }
        }
    }

    // paths 파싱
    const paths = isObject(doc['paths']) ? doc['paths'] : {};
    const endpoints: ParsedEndpoint[] = [];

    for (const [pathKey, pathItem] of Object.entries(paths)) {
        if (!isObject(pathItem)) continue;

        for (const [methodKey, operation] of Object.entries(pathItem)) {
            if (!HTTP_METHODS.has(methodKey.toLowerCase())) continue;
            if (!isObject(operation)) continue;

            const fullPath = normalizePath(basePath, pathKey);
            const method = methodKey.toUpperCase();
            const operationId = asString(operation['operationId']);
            const tags = asStringArray(operation['tags']);
            const summary = asString(operation['summary']);

            endpoints.push({
                method,
                path: fullPath,
                ...(operationId ? { operationId } : {}),
                tags,
                ...(summary ? { summary } : {}),
            });
        }
    }

    return {
        title,
        specVersion,
        ...(serviceName ? { serviceName } : {}),
        endpoints,
    };
}
