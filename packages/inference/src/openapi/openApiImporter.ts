/**
 * OpenAPI 스펙 임포터
 * 리포지토리에서 OpenAPI/Swagger 스펙 파일을 탐색하고
 * 각 엔드포인트를 api_endpoint 객체로 DB에 upsert
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, relative, sep } from 'path';
import { eq, and } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { generateId, buildUrn } from '@archi-navi/shared';
import { parseOpenApiSpec } from './openApiParser';
import type { ParsedSpec, ParsedEndpoint } from './openApiParser';

// ─── 타입 정의 ─────────────────────────────────────────────────────────────────

export interface OpenApiImportOptions {
    workspaceId: string;
    repoRoot: string;
}

export interface OpenApiImportResult {
    /** 발견된 스펙 파일 수 */
    specFileCount: number;
    /** 파싱된 총 엔드포인트 수 */
    endpointCount: number;
    /** 새로 생성된 엔드포인트 수 */
    createdEndpointCount: number;
    /** 메타데이터 갱신된 엔드포인트 수 */
    updatedEndpointCount: number;
    /** 서비스 매칭 실패한 스펙 파일 수 */
    unmatchedServiceCount: number;
}

/** api_endpoint 선언 스펙의 신뢰도 */
const OPENAPI_CONFIDENCE = 0.98;

// 탐색 제외 디렉토리
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'target',
]);

// ─── 파일 탐색 ─────────────────────────────────────────────────────────────────

/**
 * 재귀적으로 디렉토리를 탐색하여 조건에 맞는 파일 경로 수집
 */
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

/** OpenAPI/Swagger 스펙 파일명 패턴 */
const SPEC_FILE_NAMES = new Set([
    'openapi.yml', 'openapi.yaml', 'openapi.json',
    'swagger.yml', 'swagger.yaml', 'swagger.json',
]);

/**
 * OpenAPI/Swagger 스펙 파일 탐색
 * - 정확한 파일명 매칭 (openapi.yml, swagger.json 등)
 * - src/main/resources/ 및 docs/ 디렉토리 내부 탐색
 * - *api-docs* 패턴 파일
 */
function findOpenApiSpecFiles(repoRoot: string): string[] {
    return findFiles(repoRoot, (filePath) => {
        const base = basename(filePath).toLowerCase();
        const ext = base.split('.').pop() ?? '';

        // 지원하는 확장자 확인
        if (!['yml', 'yaml', 'json'].includes(ext)) return false;

        // 정확한 파일명 매칭
        if (SPEC_FILE_NAMES.has(base)) return true;

        // api-docs 패턴
        if (base.includes('api-docs')) return true;

        // src/main/resources/ 또는 docs/ 내의 yaml/json 중 openapi/swagger 키워드 포함 파일명
        const normalized = filePath.replace(/\\/g, '/');
        const inResourcesOrDocs =
            normalized.includes('/src/main/resources/') ||
            normalized.includes('/docs/');
        if (inResourcesOrDocs && (base.includes('openapi') || base.includes('swagger'))) {
            return true;
        }

        return false;
    });
}

// ─── 서비스 매칭 ───────────────────────────────────────────────────────────────

interface ServiceInfo {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
}

/** 이름 정규화 (하이픈/언더스코어 제거, 소문자) */
function normalizeNameKey(value: string): string {
    return value.toLowerCase().replace(/[-_]/g, '');
}

/**
 * 서비스 매칭 전략 (우선순위순):
 * 1. x-service-name 커스텀 확장 필드
 * 2. info.title → 등록된 서비스 이름 매칭
 * 3. 디렉토리 경로 기반 추론
 * 4. spring.application.name 이 같은 리포에서 발견된 경우 (metadata 비교)
 */
function matchService(
    spec: ParsedSpec,
    specFilePath: string,
    repoRoot: string,
    allServices: ServiceInfo[],
): string | null {
    // 전략 1: x-service-name 커스텀 확장
    if (spec.serviceName) {
        const matched = findServiceByName(spec.serviceName, allServices);
        if (matched) return matched;
    }

    // 전략 2: info.title 기반 매칭
    if (spec.title && spec.title !== 'Untitled') {
        const matched = findServiceByName(spec.title, allServices);
        if (matched) return matched;
    }

    // 전략 3: 디렉토리 경로 기반 (스펙 파일 경로에서 서비스명 추론)
    const dirMatch = matchServiceByDirectory(specFilePath, repoRoot, allServices);
    if (dirMatch) return dirMatch;

    // 전략 4: spring.application.name 매칭 (metadata 기반)
    const springMatch = matchServiceBySpringAppName(spec, allServices);
    if (springMatch) return springMatch;

    return null;
}

/** 정확 + 정규화 매칭으로 서비스 ID 조회 */
function findServiceByName(
    serviceName: string,
    allServices: ServiceInfo[],
): string | null {
    // 대소문자 무시 정확 매칭
    const exactMatch = allServices.find(
        (s) => s.name.toLowerCase() === serviceName.toLowerCase(),
    );
    if (exactMatch) return exactMatch.id;

    // 하이픈/언더스코어 정규화 후 매칭
    const normalizedInput = normalizeNameKey(serviceName);
    const normalizedMatch = allServices.find(
        (s) => normalizeNameKey(s.name) === normalizedInput,
    );
    if (normalizedMatch) return normalizedMatch.id;

    return null;
}

/**
 * 디렉토리 경로 기반 서비스 매칭
 * 스펙 파일에서 위로 올라가며 디렉토리명과 서비스명 비교
 */
function matchServiceByDirectory(
    specFilePath: string,
    repoRoot: string,
    allServices: ServiceInfo[],
): string | null {
    const relPath = relative(repoRoot, specFilePath);
    const parts = relPath.split(sep);

    // 상위 디렉토리부터 아래로 매칭 시도 (가장 가까운 매칭 우선)
    for (let i = parts.length - 2; i >= 0; i--) {
        const dirName = parts[i];
        if (!dirName) continue;
        const matched = findServiceByName(dirName, allServices);
        if (matched) return matched;
    }

    return null;
}

/**
 * spring.application.name 기반 매칭
 * 서비스 metadata에 springAppName이 spec.title과 일치하면 매칭
 */
function matchServiceBySpringAppName(
    spec: ParsedSpec,
    allServices: ServiceInfo[],
): string | null {
    if (!spec.title || spec.title === 'Untitled') return null;

    const normalizedTitle = normalizeNameKey(spec.title);
    for (const service of allServices) {
        const meta = service.metadata;
        const springName = typeof meta['springAppName'] === 'string'
            ? meta['springAppName']
            : typeof meta['spring_app_name'] === 'string'
                ? meta['spring_app_name']
                : null;
        if (springName && normalizeNameKey(springName) === normalizedTitle) {
            return service.id;
        }
    }

    return null;
}

// ─── 엔드포인트 Upsert ────────────────────────────────────────────────────────

/** 경로를 slug로 변환 */
function slugifyPath(value: string): string {
    const trimmed = value.trim().toLowerCase();
    const replaced = trimmed
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return replaced.length > 0 ? replaced : 'root';
}

/**
 * api_endpoint 객체를 URN 기반으로 upsert
 * 존재하면 metadata 갱신, 없으면 신규 생성
 */
async function upsertApiEndpoint(
    db: DbClient,
    params: {
        workspaceId: string;
        serviceId: string;
        serviceName: string;
        endpoint: ParsedEndpoint;
        specFilePath: string;
    },
): Promise<{ isNew: boolean; isUpdated: boolean }> {
    const { workspaceId, serviceId, serviceName, endpoint, specFilePath } = params;
    const { method, path, operationId, tags, summary } = endpoint;

    const endpointKey = `${serviceName}:${method}:${path}`;
    const urn = buildUrn(workspaceId, 'compute', 'api_endpoint', endpointKey);
    const displayName = `${method} ${path}`;

    // URN으로 기존 객체 조회
    const existing = await db
        .select({ id: objects.id, metadata: objects.metadata })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.urn, urn),
            ),
        )
        .limit(1);

    const metadata: Record<string, unknown> = {
        method,
        path,
        source: 'OPENAPI',
        confidence: OPENAPI_CONFIDENCE,
        specFile: specFilePath,
        ...(operationId ? { operationId } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(summary ? { summary } : {}),
    };

    if (existing[0]) {
        // 기존 객체 metadata 갱신
        await db
            .update(objects)
            .set({
                metadata,
                parentId: serviceId,
                updatedAt: new Date(),
            })
            .where(eq(objects.id, existing[0].id));
        return { isNew: false, isUpdated: true };
    }

    // parentId + name 기반 중복 확인 (legacy/seed 데이터)
    const existingByName = await db
        .select({ id: objects.id })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'api_endpoint'),
                eq(objects.parentId, serviceId),
                eq(objects.name, displayName),
            ),
        )
        .limit(1);

    if (existingByName[0]) {
        // 기존 객체에 URN과 metadata 갱신
        await db
            .update(objects)
            .set({
                urn,
                metadata,
                updatedAt: new Date(),
            })
            .where(eq(objects.id, existingByName[0].id));
        return { isNew: false, isUpdated: true };
    }

    // 신규 생성
    const id = generateId();
    const slug = `${method.toLowerCase()}-${slugifyPath(path)}`;
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        urn,
        name: displayName,
        displayName,
        parentId: serviceId,
        path: `/${serviceName}/${slug}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata,
    });

    return { isNew: true, isUpdated: false };
}

// ─── 메인 임포트 함수 ──────────────────────────────────────────────────────────

/**
 * OpenAPI 스펙 기반 엔드포인트 임포트
 * 1. repoRoot에서 스펙 파일 탐색
 * 2. 각 스펙 파싱
 * 3. 서비스 매칭
 * 4. 엔드포인트별 api_endpoint 객체 upsert
 */
export async function importOpenApiSpecs(
    db: DbClient,
    options: OpenApiImportOptions,
): Promise<OpenApiImportResult> {
    const { workspaceId, repoRoot } = options;

    // 등록된 서비스 전체 조회
    const allServices: ServiceInfo[] = await db
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
        ) as ServiceInfo[];

    // 스펙 파일 탐색
    const specFiles = findOpenApiSpecFiles(repoRoot);

    const result: OpenApiImportResult = {
        specFileCount: specFiles.length,
        endpointCount: 0,
        createdEndpointCount: 0,
        updatedEndpointCount: 0,
        unmatchedServiceCount: 0,
    };

    for (const specFilePath of specFiles) {
        // 파일 읽기
        let content: string;
        try {
            content = readFileSync(specFilePath, 'utf-8');
        } catch {
            continue;
        }

        // 스펙 파싱
        const spec = parseOpenApiSpec(content);
        if (!spec || spec.endpoints.length === 0) continue;

        result.endpointCount += spec.endpoints.length;

        // 서비스 매칭
        const serviceId = matchService(spec, specFilePath, repoRoot, allServices);
        if (!serviceId) {
            result.unmatchedServiceCount += 1;
            continue;
        }

        // 매칭된 서비스명 조회
        const service = allServices.find((s) => s.id === serviceId);
        const serviceName = service?.name ?? 'unknown';

        // 엔드포인트별 upsert
        for (const endpoint of spec.endpoints) {
            const { isNew, isUpdated } = await upsertApiEndpoint(db, {
                workspaceId,
                serviceId,
                serviceName,
                endpoint,
                specFilePath,
            });
            if (isNew) result.createdEndpointCount += 1;
            if (isUpdated) result.updatedEndpointCount += 1;
        }
    }

    return result;
}
