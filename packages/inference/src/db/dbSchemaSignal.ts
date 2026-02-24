/**
 * DB 스키마 신호 추출기
 * db_table objects의 FK 제약조건/컬럼 패턴을 분석하여
 * relation_candidates를 생성하고, 서비스별 dbScore를 계산한다.
 *
 * 설계 참조: docs/03-inference-engine.md §5 DB 스키마 신호 추출
 */
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects, relationCandidates, codeArtifacts, codeCallEdges, evidences } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

/** FK 제약조건 메타데이터 구조 */
interface FkConstraint {
    column: string;
    references_table: string;
    references_column: string;
}

/** 컬럼 메타데이터 구조 */
interface ColumnInfo {
    name: string;
    type?: string;
}

/** db_table object의 metadata 구조 */
interface DbTableMetadata {
    columns?: ColumnInfo[];
    fk_constraints?: FkConstraint[];
    [key: string]: unknown;
}

/** extractDbSchemaSignals 입력 옵션 */
export interface DbSchemaSignalOptions {
    workspaceId: string;
}

/** extractDbSchemaSignals 반환 결과 */
export interface DbSchemaSignalResult {
    tableCount: number;
    fkCandidateCount: number;
    implicitFkCandidateCount: number;
}

// ─── 제외 패턴 ────────────────────────────────────────────────────────────────

/** implicit FK 추출 시 false positive를 유발하는 컬럼명 */
const EXCLUDE_COLUMNS = new Set([
    'id',
    'created_by', 'updated_by', 'deleted_by',
    'created_at', 'updated_at', 'deleted_at',
]);

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 테이블명에서 도메인 prefix 추출
 * - `order_items` → `order`
 * - `users` → `users` (언더스코어 없으면 전체)
 */
export function extractTablePrefix(tableName: string): string {
    const idx = tableName.indexOf('_');
    return idx > 0 ? tableName.substring(0, idx) : tableName;
}

/**
 * prefix와 도메인 이름 매칭
 * 1. 정확 매칭 (대소문자 무시)
 * 2. 도메인명이 prefix에 포함되거나 역방향
 */
export function matchDomainByPrefix(
    prefix: string,
    domains: { id: string; name: string }[],
): string | null {
    const lower = prefix.toLowerCase();

    const exact = domains.find((d) => d.name.toLowerCase() === lower);
    if (exact) return exact.id;

    const partial = domains.find(
        (d) =>
            d.name.toLowerCase().includes(lower) ||
            lower.includes(d.name.toLowerCase()),
    );
    return partial?.id ?? null;
}

/**
 * 컬럼명에서 참조 대상 테이블명 후보 추정
 * `order_id` → ['orders', 'order']
 * `item_no`  → ['items', 'item']
 */
function inferReferencedTables(columnName: string): string[] {
    // *_id 또는 *_no 패턴 추출
    const idMatch = columnName.match(/^(.+)_(?:id|no)$/);
    if (!idMatch) return [];
    const base = idMatch[1] ?? '';
    if (!base) return [];
    // 복수형 우선 시도
    return [`${base}s`, base];
}

// ─── 메인 함수들 ──────────────────────────────────────────────────────────────

/**
 * DB 스키마 신호 추출
 * - FK 제약조건 → relation_candidates (confidence 0.95)
 * - 컬럼명 패턴 (implicit FK) → relation_candidates (confidence 0.5)
 *
 * @param db - DB 클라이언트
 * @param options - 추출 옵션
 */
export async function extractDbSchemaSignals(
    db: DbClient,
    options: DbSchemaSignalOptions,
): Promise<DbSchemaSignalResult> {
    const { workspaceId } = options;

    // db_table 타입 objects 조회
    const dbTables = await db
        .select({ id: objects.id, name: objects.name, metadata: objects.metadata })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'db_table'),
            ),
        );

    if (dbTables.length === 0) {
        return { tableCount: 0, fkCandidateCount: 0, implicitFkCandidateCount: 0 };
    }

    // 테이블명 → objectId 인덱스 (빠른 조회)
    const tableNameIndex = new Map<string, string>();
    for (const t of dbTables) {
        tableNameIndex.set(t.name.toLowerCase(), t.id);
    }

    let fkCandidateCount = 0;
    let implicitFkCandidateCount = 0;

    // 이미 PENDING 상태의 relation_candidates 집합 (중복 방지)
    const existingCandidates = await db
        .select({
            subjectObjectId: relationCandidates.subjectObjectId,
            objectId: relationCandidates.objectId,
            relationType: relationCandidates.relationType,
        })
        .from(relationCandidates)
        .where(
            and(
                eq(relationCandidates.workspaceId, workspaceId),
                eq(relationCandidates.status, 'PENDING'),
            ),
        );

    const pendingKey = (subject: string, object: string, type: string) =>
        `${subject}::${object}::${type}`;
    const pendingSet = new Set(
        existingCandidates.map((r) => pendingKey(r.subjectObjectId, r.objectId, r.relationType)),
    );

    /** relation_candidate 삽입 헬퍼 */
    async function insertCandidate(
        subjectId: string,
        objectId: string,
        confidence: number,
        meta: Record<string, unknown>,
    ) {
        const key = pendingKey(subjectId, objectId, 'fk_reference');
        if (pendingSet.has(key)) return false;
        pendingSet.add(key);
        await db.insert(relationCandidates).values({
            id: generateId(),
            workspaceId,
            relationType: 'fk_reference',
            subjectObjectId: subjectId,
            objectId,
            confidence,
            metadata: meta,
            status: 'PENDING',
        });
        return true;
    }

    // 각 테이블 처리
    for (const table of dbTables) {
        const meta = (table.metadata ?? {}) as DbTableMetadata;

        // ── FK 제약조건 처리 ─────────────────────────────────────────────
        const fkConstraints = meta.fk_constraints ?? [];
        for (const fk of fkConstraints) {
            const refTableId = tableNameIndex.get(fk.references_table.toLowerCase());
            if (!refTableId) continue;

            const inserted = await insertCandidate(table.id, refTableId, 0.95, {
                column: fk.column,
                references_table: fk.references_table,
                references_column: fk.references_column,
                source: 'fk_constraint',
            });
            if (inserted) fkCandidateCount++;
        }

        // FK로 이미 처리한 관계 (컬럼패턴 중복 방지)
        const fkProcessedTargets = new Set(
            fkConstraints
                .map((fk) => tableNameIndex.get(fk.references_table.toLowerCase()))
                .filter((id): id is string => id !== undefined),
        );

        // ── 컬럼명 패턴 처리 (implicit FK) ─────────────────────────────
        const columns = meta.columns ?? [];
        for (const col of columns) {
            if (EXCLUDE_COLUMNS.has(col.name.toLowerCase())) continue;
            // *_id, *_no 패턴만 처리
            if (!/_(?:id|no)$/.test(col.name)) continue;

            const candidates = inferReferencedTables(col.name);
            for (const candidateTable of candidates) {
                const refTableId = tableNameIndex.get(candidateTable.toLowerCase());
                if (!refTableId) continue;
                if (fkProcessedTargets.has(refTableId)) break; // FK 처리된 관계 스킵

                const inserted = await insertCandidate(table.id, refTableId, 0.5, {
                    column: col.name,
                    inferred_table: candidateTable,
                    source: 'column_pattern',
                });
                if (inserted) implicitFkCandidateCount++;
                break; // 첫 번째 매칭 테이블에서 중단
            }
        }
    }

    return { tableCount: dbTables.length, fkCandidateCount, implicitFkCandidateCount };
}

/**
 * 서비스의 code_call_edges에서 DB 접근 신호를 추출하여
 * 각 도메인에 대한 dbScore를 계산
 *
 * @param db - DB 클라이언트
 * @param serviceId - 서비스 object ID
 * @param domains - 도메인 목록
 * @param workspaceId - 워크스페이스 ID
 * @returns domainId → score 맵
 */
export async function computeDbScores(
    db: DbClient,
    serviceId: string,
    domains: { id: string; name: string }[],
    workspaceId: string,
): Promise<Record<string, number>> {
    if (domains.length === 0) return {};

    // 서비스의 code_artifacts 조회
    const artifacts = await db
        .select({ id: codeArtifacts.id })
        .from(codeArtifacts)
        .where(
            and(
                eq(codeArtifacts.workspaceId, workspaceId),
                eq(codeArtifacts.ownerObjectId, serviceId),
            ),
        );

    if (artifacts.length === 0) return {};

    const artifactIds = artifacts.map((a) => a.id);

    // 해당 artifact들의 code_call_edges 조회
    const edges = await db
        .select({
            calleeSymbol: codeCallEdges.calleeSymbol,
            evidenceId: codeCallEdges.evidenceId,
        })
        .from(codeCallEdges)
        .where(
            and(
                eq(codeCallEdges.workspaceId, workspaceId),
                inArray(codeCallEdges.callerArtifactId, artifactIds),
            ),
        );

    if (edges.length === 0) return {};

    // evidenceId → calleeSymbol 매핑 (중복 evidence 처리)
    const evidenceIds = [
        ...new Set(
            edges
                .map((e) => e.evidenceId)
                .filter((id): id is string => id !== null),
        ),
    ];

    if (evidenceIds.length === 0) return {};

    // evidences 조회 — db_* kind 필터링
    const dbKinds = new Set(['db_read', 'db_write', 'db_mapping']);
    const dbEvidences = await db
        .select({ id: evidences.id, metadata: evidences.metadata })
        .from(evidences)
        .where(inArray(evidences.id, evidenceIds));

    const dbEvidenceIds = new Set(
        dbEvidences
            .filter((e) => {
                const kind = (e.metadata as Record<string, unknown>)['kind'];
                return typeof kind === 'string' && dbKinds.has(kind);
            })
            .map((e) => e.id),
    );

    if (dbEvidenceIds.size === 0) return {};

    // DB 신호에 해당하는 calleeSymbol(테이블명) 수집
    const dbTableNames: string[] = [];
    for (const edge of edges) {
        if (edge.evidenceId && dbEvidenceIds.has(edge.evidenceId)) {
            dbTableNames.push(edge.calleeSymbol);
        }
    }

    // 테이블명 → prefix → 도메인 매칭 → score 누적 (raw count)
    const rawScores: Record<string, number> = {};
    for (const tableName of dbTableNames) {
        const prefix = extractTablePrefix(tableName);
        const domainId = matchDomainByPrefix(prefix, domains);
        if (domainId) {
            rawScores[domainId] = (rawScores[domainId] ?? 0) + 1;
        }
    }

    // 0~1 범위로 정규화 (max count 기준)
    const maxScore = Math.max(...Object.values(rawScores), 1);
    const scores: Record<string, number> = {};
    for (const [domainId, raw] of Object.entries(rawScores)) {
        scores[domainId] = raw / maxScore;
    }

    return scores;
}
