/**
 * DOMAIN_SUMMARY — 결정론적 도메인 집계
 *
 * 집계 항목:
 *  - 도메인 소속 Object 수 및 type별 분포
 *  - 평균 affinity (object_domain_affinities 기반)
 *  - 상위 5개 멤버 (affinity 내림차순)
 *  - 외부 의존 도메인 (DOMAIN_TO_DOMAIN rollup 기반)
 *  - 관계 밀도 (intra-domain relations / max_possible)
 */
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
    objects,
    objectDomainAffinities,
    objectRelations,
    objectRollups,
    objectRollupProvenances,
} from '@archi-navi/db';
import type { QueryParams, QueryResponse, ObjectType, RelationType } from '@archi-navi/shared';
import { OBJECT_TYPES, RELATION_TYPES } from '@archi-navi/shared';

// ─── 타입 가드 ──────────────────────────────────────────────────────────────

const objectTypeSet = new Set<string>(OBJECT_TYPES);
const relationTypeSet = new Set<string>(RELATION_TYPES);

function isObjectType(value: string): value is ObjectType {
    return objectTypeSet.has(value);
}

function isRelationType(value: string): value is RelationType {
    return relationTypeSet.has(value);
}

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

/** 도메인 요약 집계 결과 */
export interface DomainSummaryData {
    /** 도메인 Object ID */
    domainId: string;
    /** 도메인 표시 이름 (displayName 우선, 없으면 name) */
    domainName: string;
    /** 도메인 소속 Object 수 */
    memberCount: number;
    /** Object type별 카운트 e.g. { service: 5, db_table: 2 } */
    membersByType: Record<string, number>;
    /** object_domain_affinities.affinity 평균 */
    avgAffinity: number;
    /** affinity 내림차순 상위 5개 멤버 */
    topMembers: Array<{ id: string; name: string; objectType: string; affinity: number }>;
    /** DOMAIN_TO_DOMAIN rollup 외부 의존 도메인 */
    externalDependencies: Array<{
        domainId: string;
        relationType: string;
        edgeWeight: number;
        confidence: number;
    }>;
    /**
     * intra-domain 관계 밀도 (0~1)
     * density = intra_relation_count / (memberCount * (memberCount - 1))
     */
    relationDensity: number;
}

// ─── 핵심 함수 ────────────────────────────────────────────────────────────────

/**
 * DOMAIN_SUMMARY 쿼리 실행
 *
 * - params.domainId가 있으면 해당 도메인의 상세 집계
 * - params.domainId가 없으면 워크스페이스 내 모든 도메인 목록
 */
export async function summarizeDomain(
    db: DbClient,
    workspaceId: string,
    generationVersion: number,
    params: QueryParams,
): Promise<QueryResponse['result']> {
    const { domainId } = params;

    if (!domainId) {
        return summarizeAllDomains(db, workspaceId);
    }

    return summarizeSingleDomain(db, workspaceId, generationVersion, domainId);
}

// ─── 내부 구현 ────────────────────────────────────────────────────────────────

/** 전체 도메인 목록 반환 (domainId 미지정 시) */
async function summarizeAllDomains(
    db: DbClient,
    workspaceId: string,
): Promise<QueryResponse['result']> {
    const domainObjects = await db
        .select()
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'domain'),
            ),
        );

    const nodes: QueryResponse['result']['nodes'] = domainObjects.map((d) => {
        const node: QueryResponse['result']['nodes'][0] = {
            id: d.id,
            type: 'domain' as const,
            name: d.name,
        };
        if (d.displayName !== null) node.displayName = d.displayName;
        return node;
    });

    return {
        nodes,
        edges: [],
        summary: {
            type: 'DOMAIN_LIST',
            domainCount: domainObjects.length,
            domains: domainObjects.map((d) => ({
                id: d.id,
                name: d.name,
                displayName: d.displayName,
            })),
        },
    };
}

/** 특정 도메인 상세 집계 */
async function summarizeSingleDomain(
    db: DbClient,
    workspaceId: string,
    generationVersion: number,
    domainId: string,
): Promise<QueryResponse['result']> {
    // ─── 1. 도메인 Object 조회 ─────────────────────────────────────────────────
    const domainRows = await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, domainId)));

    const domainObj = domainRows[0];
    if (!domainObj) {
        return { nodes: [], edges: [], summary: { domainId, error: 'Domain not found' } };
    }

    // ─── 2. 도메인 멤버 affinity 조회 ─────────────────────────────────────────
    const affinityRows = await db
        .select()
        .from(objectDomainAffinities)
        .where(
            and(
                eq(objectDomainAffinities.workspaceId, workspaceId),
                eq(objectDomainAffinities.domainId, domainId),
            ),
        );

    const memberIds = affinityRows.map((a) => a.objectId);
    const affinityByObjectId = new Map(affinityRows.map((a) => [a.objectId, a.affinity]));

    // ─── 3. 멤버 Object 상세 조회 ─────────────────────────────────────────────
    const memberObjects = memberIds.length > 0
        ? await db
            .select()
            .from(objects)
            .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, memberIds)))
        : [];

    const memberMap = new Map(memberObjects.map((o) => [o.id, o]));

    // type별 카운트
    const membersByType: Record<string, number> = {};
    for (const obj of memberObjects) {
        membersByType[obj.objectType] = (membersByType[obj.objectType] ?? 0) + 1;
    }

    // 평균 affinity
    const avgAffinity = affinityRows.length > 0
        ? affinityRows.reduce((sum, a) => sum + a.affinity, 0) / affinityRows.length
        : 0;

    // 상위 멤버 (affinity 내림차순 상위 5개)
    const topMembers = [...memberIds]
        .sort((a, b) => (affinityByObjectId.get(b) ?? 0) - (affinityByObjectId.get(a) ?? 0))
        .slice(0, 5)
        .map((id) => {
            const obj = memberMap.get(id);
            return {
                id,
                name: obj?.name ?? id,
                objectType: obj?.objectType ?? 'unknown',
                affinity: affinityByObjectId.get(id) ?? 0,
            };
        });

    // ─── 4. intra-domain 관계 수 (밀도 계산용) ────────────────────────────────
    const memberIdSet = new Set(memberIds);
    let intraDomainRelationCount = 0;

    if (memberIds.length > 0) {
        const relationRows = await db
            .select()
            .from(objectRelations)
            .where(
                and(
                    eq(objectRelations.workspaceId, workspaceId),
                    inArray(objectRelations.subjectObjectId, memberIds),
                ),
            );
        // subject AND object 모두 도메인 멤버인 관계만 카운트
        intraDomainRelationCount = relationRows.filter(
            (r) => memberIdSet.has(r.subjectObjectId) && memberIdSet.has(r.objectId),
        ).length;
    }

    const maxPossibleRelations = memberIds.length * (memberIds.length - 1);
    const relationDensity = maxPossibleRelations > 0
        ? intraDomainRelationCount / maxPossibleRelations
        : 0;

    // ─── 5. 외부 의존 도메인 (DOMAIN_TO_DOMAIN rollup) ────────────────────────
    const externalRollupRows = await db
        .select()
        .from(objectRollups)
        .where(
            and(
                eq(objectRollups.workspaceId, workspaceId),
                eq(objectRollups.generationVersion, generationVersion),
                eq(objectRollups.rollupLevel, 'DOMAIN_TO_DOMAIN'),
                eq(objectRollups.subjectObjectId, domainId),
            ),
        );

    const externalDependencies = externalRollupRows.map((r) => ({
        domainId: r.objectId,
        relationType: r.relationType,
        edgeWeight: r.edgeWeight,
        confidence: r.confidence ?? 0,
    }));

    const externalRollupIds = externalRollupRows.map((r) => r.id);
    const externalProvenanceRows = externalRollupIds.length > 0
        ? await db
            .select({
                rollupId: objectRollupProvenances.rollupId,
                baseRelationId: objectRollupProvenances.baseRelationId,
            })
            .from(objectRollupProvenances)
            .where(
                and(
                    eq(objectRollupProvenances.workspaceId, workspaceId),
                    eq(objectRollupProvenances.generationVersion, generationVersion),
                    inArray(objectRollupProvenances.rollupId, externalRollupIds),
                ),
            )
        : [];
    const baseRelationIdsByRollupId = new Map<string, string[]>();
    for (const row of externalProvenanceRows) {
        const existing = baseRelationIdsByRollupId.get(row.rollupId) ?? [];
        existing.push(row.baseRelationId);
        baseRelationIdsByRollupId.set(row.rollupId, existing);
    }

    // ─── 결과 조립 ────────────────────────────────────────────────────────────

    const summaryData: DomainSummaryData = {
        domainId,
        domainName: domainObj.displayName ?? domainObj.name,
        memberCount: memberIds.length,
        membersByType,
        avgAffinity,
        topMembers,
        externalDependencies,
        relationDensity,
    };

    const nodes: QueryResponse['result']['nodes'] = memberObjects
        .filter((obj) => isObjectType(obj.objectType))
        .map((obj) => {
            const node: QueryResponse['result']['nodes'][0] = {
                id: obj.id,
                type: obj.objectType as ObjectType,
                name: obj.name,
                metadata: { affinity: affinityByObjectId.get(obj.id) ?? 0 },
            };
            if (obj.displayName !== null) node.displayName = obj.displayName;
            return node;
        });

    const edges: QueryResponse['result']['edges'] = externalRollupRows
        .filter((r) => isRelationType(r.relationType))
        .map((r) => ({
            subjectId: r.subjectObjectId,
            objectId: r.objectId,
            relationType: r.relationType as RelationType,
            level: 'DOMAIN_TO_DOMAIN' as const,
            edgeWeight: r.edgeWeight,
            confidence: r.confidence ?? 0,
            provenance: { rollupId: r.id, baseRelationIds: baseRelationIdsByRollupId.get(r.id) ?? [] },
        }));

    return { nodes, edges, summary: { ...summaryData } };
}
