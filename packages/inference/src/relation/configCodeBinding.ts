/**
 * Config→Code 크로스 바인딩
 *
 * config 추론이 생성한 서비스→서비스(COMPOUND→COMPOUND) 후보를
 * code 추론이 발견한 endpoint 정보와 교차하여
 * 서비스→엔드포인트(COMPOUND→ATOMIC) 후보로 분해한다.
 *
 * 예: config에서 gateway→order-service (COMPOUND) 후보가 있고
 *     code에서 order-service 아래 GET /api/orders 엔드포인트가 있으면
 *     → gateway→GET /api/orders (ATOMIC) 후보를 추가 생성
 */
import type { DbClient } from '@archi-navi/db';
import {
    evidences,
    objects,
    objectRelations,
    relationCandidates,
    relationCandidateEvidences,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { and, eq, inArray, or } from 'drizzle-orm';

export interface ConfigCodeBindingOptions {
    workspaceId: string;
    repoRoots?: string[];
}

export interface ConfigCodeBindingResult {
    /** 처리한 COMPOUND→COMPOUND 후보 수 */
    compoundCandidateCount: number;
    /** 새로 생성한 endpoint 레벨 후보 수 */
    createdEndpointCandidateCount: number;
    /** 타겟 서비스 하위 endpoint가 없어 스킵된 수 */
    skippedNoEndpointCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getRawCandidateConfidence(confidence: number, metadata: unknown): number {
    return asFiniteNumber(asRecord(asRecord(metadata)?.crossValidation)?.originalConfidence) ?? confidence;
}

function stripCrossValidationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    if (!Object.prototype.hasOwnProperty.call(metadata, 'crossValidation')) {
        return metadata;
    }

    const nextMetadata = { ...metadata };
    delete nextMetadata.crossValidation;
    return nextMetadata;
}

function normalizeRepoRoots(repoRoots?: string[]): string[] {
    return Array.from(
        new Set(
            (repoRoots ?? [])
                .map((repoRoot) => repoRoot.replace(/\\/g, '/').replace(/\/+$/, ''))
                .filter((repoRoot) => repoRoot.length > 0),
        ),
    );
}

function isPathInRepoScope(pathValue: string | null, repoRoots: string[]): boolean {
    if (repoRoots.length === 0 || !pathValue) return repoRoots.length === 0;
    const normalizedValue = pathValue.replace(/\\/g, '/');
    return repoRoots.some(
        (repoRoot) => normalizedValue === repoRoot || normalizedValue.startsWith(`${repoRoot}/`),
    );
}

function matchesRepoScope(metadata: unknown, evidenceFilePaths: string[], repoRoots: string[]): boolean {
    if (repoRoots.length === 0) return true;

    const record = asRecord(metadata) ?? {};
    if (isPathInRepoScope(typeof record.repoRoot === 'string' ? record.repoRoot : null, repoRoots)) {
        return true;
    }
    if (isPathInRepoScope(typeof record.specFile === 'string' ? record.specFile : null, repoRoots)) {
        return true;
    }

    return evidenceFilePaths.some((filePath) => isPathInRepoScope(filePath, repoRoots));
}

/**
 * config 후보(service→service)를 endpoint 레벨로 분해
 *
 * 동작:
 * 1. PENDING 상태의 call 후보 중 양쪽 모두 service(COMPOUND)인 것을 찾는다
 * 2. 타겟 서비스 하위의 api_endpoint 목록을 조회한다
 * 3. 각 endpoint에 대해 낮은 confidence(0.6)의 새 후보를 생성한다
 * 4. 원본 후보의 evidence를 새 후보에도 연결한다
 */
export async function bindConfigToCodeEndpoints(
    db: DbClient,
    options: ConfigCodeBindingOptions,
): Promise<ConfigCodeBindingResult> {
    const { workspaceId } = options;
    const scopedRepoRoots = normalizeRepoRoots(options.repoRoots);

    // 1) service→service PENDING call 후보 조회
    const allCompoundCandidates = await db
        .select({
            id: relationCandidates.id,
            subjectObjectId: relationCandidates.subjectObjectId,
            objectId: relationCandidates.objectId,
            confidence: relationCandidates.confidence,
            metadata: relationCandidates.metadata,
        })
        .from(relationCandidates)
        .innerJoin(
            objects,
            and(
                eq(relationCandidates.objectId, objects.id),
                eq(objects.granularity, 'COMPOUND'),
                eq(objects.objectType, 'service'),
            ),
        )
        .where(
            and(
                eq(relationCandidates.workspaceId, workspaceId),
                eq(relationCandidates.relationType, 'call'),
                eq(relationCandidates.status, 'PENDING'),
            ),
        );
    const evidenceRows = allCompoundCandidates.length > 0
        ? await db
            .select({
                candidateId: relationCandidateEvidences.candidateId,
                evidenceId: relationCandidateEvidences.evidenceId,
                filePath: evidences.filePath,
            })
            .from(relationCandidateEvidences)
            .innerJoin(evidences, eq(relationCandidateEvidences.evidenceId, evidences.id))
            .where(
                and(
                    eq(relationCandidateEvidences.workspaceId, workspaceId),
                    inArray(
                        relationCandidateEvidences.candidateId,
                        allCompoundCandidates.map((candidate) => candidate.id),
                    ),
                ),
            )
        : [];
    const evidenceIdsByCandidateId = new Map<string, string[]>();
    const evidencePathsByCandidateId = new Map<string, string[]>();
    for (const row of evidenceRows) {
        const evidenceIds = evidenceIdsByCandidateId.get(row.candidateId) ?? [];
        evidenceIds.push(row.evidenceId);
        evidenceIdsByCandidateId.set(row.candidateId, evidenceIds);

        const evidencePaths = evidencePathsByCandidateId.get(row.candidateId) ?? [];
        if (row.filePath) evidencePaths.push(row.filePath);
        evidencePathsByCandidateId.set(row.candidateId, evidencePaths);
    }
    const compoundCandidates = allCompoundCandidates.filter((candidate) =>
        matchesRepoScope(
            candidate.metadata,
            evidencePathsByCandidateId.get(candidate.id) ?? [],
            scopedRepoRoots,
        ));

    let createdEndpointCandidateCount = 0;
    let skippedNoEndpointCount = 0;

    // 타겟 서비스별 endpoint 캐시
    const endpointCache = new Map<string, Array<{ id: string; name: string }>>();

    async function getEndpointsForService(serviceId: string) {
        const cached = endpointCache.get(serviceId);
        if (cached) return cached;

        const endpoints = await db
            .select({ id: objects.id, name: objects.name, metadata: objects.metadata })
            .from(objects)
            .where(
                and(
                    eq(objects.workspaceId, workspaceId),
                    eq(objects.objectType, 'api_endpoint'),
                    eq(objects.parentId, serviceId),
                ),
            );
        const scopedEndpoints = endpoints
            .filter((endpoint) => matchesRepoScope(endpoint.metadata, [], scopedRepoRoots))
            .map(({ id, name }) => ({ id, name }));
        endpointCache.set(serviceId, scopedEndpoints);
        return scopedEndpoints;
    }

    for (const candidate of compoundCandidates) {
        const targetServiceId = candidate.objectId;
        const endpoints = await getEndpointsForService(targetServiceId);

        if (endpoints.length === 0) {
            skippedNoEndpointCount += 1;
            continue;
        }

        // 원본 후보의 evidence 조회
        const evidenceIds = evidenceIdsByCandidateId.get(candidate.id) ?? [];
        const baseMeta = stripCrossValidationMetadata((candidate.metadata ?? {}) as Record<string, unknown>);
        const rawCandidateConfidence = getRawCandidateConfidence(candidate.confidence ?? 0.7, candidate.metadata);

        for (const endpoint of endpoints) {
            const existingRelation = await db
                .select({ id: objectRelations.id })
                .from(objectRelations)
                .where(
                    and(
                        eq(objectRelations.workspaceId, workspaceId),
                        eq(objectRelations.relationType, 'call'),
                        eq(objectRelations.subjectObjectId, candidate.subjectObjectId),
                        eq(objectRelations.objectId, endpoint.id),
                        eq(objectRelations.isDerived, false),
                    ),
                )
                .limit(1);

            if (existingRelation.length > 0) continue;

            // 이미 동일 후보가 있는지 확인
            const existing = await db
                .select({ id: relationCandidates.id })
                .from(relationCandidates)
                .where(
                    and(
                        eq(relationCandidates.workspaceId, workspaceId),
                        eq(relationCandidates.relationType, 'call'),
                        eq(relationCandidates.subjectObjectId, candidate.subjectObjectId),
                        eq(relationCandidates.objectId, endpoint.id),
                        or(
                            eq(relationCandidates.status, 'PENDING'),
                            eq(relationCandidates.status, 'APPROVED'),
                        ),
                    ),
                )
                .limit(1);

            if (existing.length > 0) continue;

            // endpoint 레벨 후보 생성 (confidence 할인: 원본 * 0.85, 최소 0.5)
            const endpointConfidence = Math.max(
                rawCandidateConfidence * 0.85,
                0.5,
            );

            const candidateId = generateId();
            await db.insert(relationCandidates).values({
                id: candidateId,
                workspaceId,
                relationType: 'call',
                subjectObjectId: candidate.subjectObjectId,
                objectId: endpoint.id,
                confidence: endpointConfidence,
                metadata: {
                    ...baseMeta,
                    crossBound: true,
                    originalCandidateId: candidate.id,
                    targetType: 'api_endpoint',
                    targetServiceId,
                },
                status: 'PENDING',
            });

            // evidence 링크 복사
            for (const evidenceId of evidenceIds) {
                await db
                    .insert(relationCandidateEvidences)
                    .values({ workspaceId, candidateId, evidenceId })
                    .onConflictDoNothing();
            }

            createdEndpointCandidateCount += 1;
        }
    }

    return {
        compoundCandidateCount: compoundCandidates.length,
        createdEndpointCandidateCount,
        skippedNoEndpointCount,
    };
}
