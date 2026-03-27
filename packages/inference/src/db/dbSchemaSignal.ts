/**
 * DB 스키마 신호 추출기
 * db_table objects의 FK 제약조건/컬럼 패턴을 분석하여
 * relation_candidates를 생성하고, 서비스별 dbScore를 계산한다.
 *
 * 설계 참조: docs/03-inference-engine.md §5 DB 스키마 신호 추출
 */
import { eq, and, inArray } from 'drizzle-orm';
import { createHash } from 'crypto';
import type { DbClient } from '@archi-navi/db';
import {
    objects,
    relationCandidates,
    relationCandidateEvidences,
    codeArtifacts,
    codeCallEdges,
    evidences,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
    asRecord,
    getRawCandidateConfidence,
    stripCrossValidationMetadata,
} from '../utils/metadata';

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

/** 인덱스 메타데이터 구조 */
interface IndexInfo {
    name?: string;
    columns: string[];
    unique?: boolean;
}

/** Unique 제약조건 메타데이터 구조 */
interface UniqueConstraintInfo {
    name?: string;
    columns: string[];
}

/** db_table object의 metadata 구조 */
interface DbTableMetadata {
    columns?: ColumnInfo[];
    fk_constraints?: FkConstraint[];
    indexes?: unknown[];
    unique_constraints?: unknown[];
    [key: string]: unknown;
}

/** extractDbSchemaSignals 입력 옵션 */
export interface DbSchemaSignalOptions {
    workspaceId: string;
    /** true: 변경된 db_table만 재처리, false: 전체 재처리 */
    incremental?: boolean;
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
    const normalized = columnName.trim().toLowerCase();
    // *_id 또는 *_no 패턴 추출
    const idMatch = normalized.match(/^(.+)_(?:id|no)$/);
    if (!idMatch) return [];
    const base = idMatch[1] ?? '';
    if (!base) return [];
    // 복수형 우선 시도
    return [`${base}s`, base];
}

/** FK 추론 대상 컬럼명인지 검사 */
function isFkLikeColumn(columnName: string): boolean {
    const lower = columnName.toLowerCase();
    if (EXCLUDE_COLUMNS.has(lower)) return false;
    return /_(?:id|no)$/.test(lower);
}

function normalizeColumnList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

function parseIndexes(meta: DbTableMetadata): IndexInfo[] {
    const rawIndexes = meta.indexes;
    if (!Array.isArray(rawIndexes)) return [];
    return rawIndexes
        .map((entry): IndexInfo | null => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const row = entry as Record<string, unknown>;
            const columns = normalizeColumnList(row.columns);
            if (columns.length === 0) return null;
            const name = typeof row.name === 'string' ? row.name : null;
            return {
                ...(name ? { name } : {}),
                columns,
                unique: row.unique === true,
            };
        })
        .filter((v): v is IndexInfo => v !== null);
}

function parseUniqueConstraints(
    meta: DbTableMetadata,
    indexes: IndexInfo[],
): UniqueConstraintInfo[] {
    const constraints: UniqueConstraintInfo[] = [];
    const rawUnique = meta.unique_constraints;
    if (Array.isArray(rawUnique)) {
        for (const entry of rawUnique) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const row = entry as Record<string, unknown>;
            const columns = normalizeColumnList(row.columns);
            if (columns.length === 0) continue;
            const name = typeof row.name === 'string' ? row.name : null;
            constraints.push({
                ...(name ? { name } : {}),
                columns,
            });
        }
    }

    // unique index도 unique 제약과 동일하게 취급한다.
    for (const idx of indexes) {
        if (!idx.unique) continue;
        const name = typeof idx.name === 'string' ? idx.name : null;
        constraints.push({
            ...(name ? { name } : {}),
            columns: idx.columns,
        });
    }
    return constraints;
}

interface DbSchemaArtifactEntry {
    id: string;
    filePath: string;
    sha256: string | null;
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashTableNameSet(tableNames: string[]): string {
    const normalized = tableNames
        .map((name) => name.toLowerCase())
        .sort();
    return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

function hashDbTableSchema(
    tableName: string,
    metadata: DbTableMetadata,
    tableNameSetHash: string,
): string {
    // 테이블명 변경/metadata 변경 + 글로벌 테이블 집합 변경 모두 반영한다.
    const payload = { tableName, metadata, tableNameSetHash };
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function dbSchemaArtifactPath(tableId: string): string {
    return `db-table://${tableId}`;
}

// ─── 메인 함수들 ──────────────────────────────────────────────────────────────

/**
 * DB 스키마 신호 추출
 * - FK 제약조건 → relation_candidates (confidence 0.95)
 * - Unique 패턴 → relation_candidates (confidence 0.85)
 * - 복합 인덱스 패턴 → relation_candidates (confidence 0.7)
 * - 컬럼명 패턴 (implicit FK) → relation_candidates (confidence 0.5)
 *
 * @param db - DB 클라이언트
 * @param options - 추출 옵션
 */
export async function extractDbSchemaSignals(
    db: DbClient,
    options: DbSchemaSignalOptions,
): Promise<DbSchemaSignalResult> {
    const { workspaceId, incremental = false } = options;

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
    const tableIdToName = new Map<string, string>();
    const tableNameSetHash = hashTableNameSet(dbTables.map((table) => table.name));
    for (const t of dbTables) {
        tableNameIndex.set(t.name.toLowerCase(), t.id);
        tableIdToName.set(t.id, t.name);
    }

    // 증분 판단용: db_schema artifact 조회
    const artifactPaths = dbTables.map((t) => dbSchemaArtifactPath(t.id));
    const existingArtifacts = artifactPaths.length > 0
        ? await db
            .select({
                id: codeArtifacts.id,
                filePath: codeArtifacts.filePath,
                sha256: codeArtifacts.sha256,
            })
            .from(codeArtifacts)
            .where(
                and(
                    eq(codeArtifacts.workspaceId, workspaceId),
                    eq(codeArtifacts.language, 'db_schema'),
                    inArray(codeArtifacts.filePath, artifactPaths),
                ),
            )
        : [];
    const artifactMap = new Map<string, DbSchemaArtifactEntry>(
        existingArtifacts.map((a) => [a.filePath, a]),
    );

    const tablesToProcess = dbTables.filter((table) => {
        if (!incremental) return true;
        const meta = (table.metadata ?? {}) as DbTableMetadata;
        const hash = hashDbTableSchema(table.name, meta, tableNameSetHash);
        const existing = artifactMap.get(dbSchemaArtifactPath(table.id));
        return existing?.sha256 !== hash;
    });

    // 증분 모드에서만: 변경된 테이블의 기존 PENDING fk_reference 후보를 정리 후 재계산한다.
    if (incremental) {
        for (const table of tablesToProcess) {
            await db
                .delete(relationCandidates)
                .where(
                    and(
                        eq(relationCandidates.workspaceId, workspaceId),
                        eq(relationCandidates.status, 'PENDING'),
                        eq(relationCandidates.relationType, 'fk_reference'),
                        eq(relationCandidates.subjectObjectId, table.id),
                    ),
                );
        }
    }

    if (tablesToProcess.length === 0) {
        return { tableCount: dbTables.length, fkCandidateCount: 0, implicitFkCandidateCount: 0 };
    }

    const candidateRefreshTableIds = tablesToProcess.map((table) => table.id);

    const staleValidatedCandidates = await db
        .select({
            id: relationCandidates.id,
            confidence: relationCandidates.confidence,
            metadata: relationCandidates.metadata,
        })
        .from(relationCandidates)
        .where(
            and(
                eq(relationCandidates.workspaceId, workspaceId),
                eq(relationCandidates.status, 'PENDING'),
                eq(relationCandidates.relationType, 'fk_reference'),
                inArray(relationCandidates.subjectObjectId, candidateRefreshTableIds),
            ),
        );

    for (const candidate of staleValidatedCandidates) {
        const nextMetadata = stripCrossValidationMetadata(candidate.metadata);
        if (nextMetadata === candidate.metadata && candidate.metadata !== null) continue;

        await db
            .update(relationCandidates)
            .set({
                confidence: getRawCandidateConfidence(candidate.confidence, candidate.metadata),
                metadata: nextMetadata,
            })
            .where(eq(relationCandidates.id, candidate.id));
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
        evidenceMeta: {
            kind: 'db_schema_fk' | 'db_schema_implicit_fk' | 'db_schema_unique_hint' | 'db_schema_index_hint';
            excerpt: string;
            uri: string;
            metadata: Record<string, unknown>;
        },
    ) {
        const key = pendingKey(subjectId, objectId, 'fk_reference');
        if (pendingSet.has(key)) return false;
        pendingSet.add(key);

        const candidateId = generateId();
        const evidenceId = generateId();

        await db.transaction(async (tx) => {
            await tx.insert(relationCandidates).values({
                id: candidateId,
                workspaceId,
                relationType: 'fk_reference',
                subjectObjectId: subjectId,
                objectId,
                confidence,
                metadata: meta,
                status: 'PENDING',
            });

            await tx.insert(evidences).values({
                id: evidenceId,
                workspaceId,
                evidenceType: 'SCHEMA',
                excerpt: evidenceMeta.excerpt,
                uri: evidenceMeta.uri,
                metadata: {
                    kind: evidenceMeta.kind,
                    confidence,
                    ...evidenceMeta.metadata,
                },
            });

            await tx.insert(relationCandidateEvidences).values({
                workspaceId,
                candidateId,
                evidenceId,
            });
        });

        return true;
    }

    // 각 테이블 처리
    for (const table of tablesToProcess) {
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
            }, {
                kind: 'db_schema_fk',
                excerpt: `${table.name}.${fk.column} -> ${fk.references_table}.${fk.references_column}`,
                uri: `db-table://${table.name}`,
                metadata: {
                    source: 'fk_constraint',
                    subject_table: table.name,
                    object_table: tableIdToName.get(refTableId) ?? fk.references_table,
                    column: fk.column,
                    references_column: fk.references_column,
                },
            });
            fkCandidateCount += Number(inserted);
        }

        // 우선순위가 높은 신호로 이미 처리한 관계
        const highPriorityProcessedTargets = new Set(
            fkConstraints
                .map((fk) => tableNameIndex.get(fk.references_table.toLowerCase()))
                .filter((id): id is string => id !== undefined),
        );

        const indexes = parseIndexes(meta);
        const uniqueConstraints = parseUniqueConstraints(meta, indexes);

        // ── unique 패턴 처리 ──────────────────────────────────────────
        for (const unique of uniqueConstraints) {
            for (const colName of unique.columns) {
                if (!isFkLikeColumn(colName)) continue;
                const inferredTables = inferReferencedTables(colName);
                for (const candidateTable of inferredTables) {
                    const refTableId = tableNameIndex.get(candidateTable.toLowerCase());
                    if (!refTableId) continue;
                    if (highPriorityProcessedTargets.has(refTableId)) break;

                    const inserted = await insertCandidate(table.id, refTableId, 0.85, {
                        column: colName,
                        unique_name: unique.name ?? null,
                        unique_columns: unique.columns,
                        source: 'unique_pattern',
                        cardinality_hint: 'one_to_one_or_identifying',
                    }, {
                        kind: 'db_schema_unique_hint',
                        excerpt: `${table.name}.${colName} unique -> ${candidateTable}`,
                        uri: `db-table://${table.name}`,
                        metadata: {
                            source: 'unique_pattern',
                            subject_table: table.name,
                            object_table: tableIdToName.get(refTableId) ?? candidateTable,
                            column: colName,
                            unique_name: unique.name ?? null,
                            unique_columns: unique.columns,
                            cardinality_hint: 'one_to_one_or_identifying',
                        },
                    });
                    implicitFkCandidateCount += Number(inserted);
                    if (inserted) highPriorityProcessedTargets.add(refTableId);
                    break;
                }
            }
        }

        // ── 복합 인덱스 패턴 처리 ──────────────────────────────────────
        for (const index of indexes) {
            if (index.unique) continue;
            if (index.columns.length < 2) continue;

            for (const colName of index.columns) {
                if (!isFkLikeColumn(colName)) continue;
                const inferredTables = inferReferencedTables(colName);
                for (const candidateTable of inferredTables) {
                    const refTableId = tableNameIndex.get(candidateTable.toLowerCase());
                    if (!refTableId) continue;
                    if (highPriorityProcessedTargets.has(refTableId)) break;

                    const inserted = await insertCandidate(table.id, refTableId, 0.7, {
                        column: colName,
                        index_name: index.name ?? null,
                        index_columns: index.columns,
                        source: 'index_pattern',
                    }, {
                        kind: 'db_schema_index_hint',
                        excerpt: `${table.name}.${colName} indexed -> ${candidateTable}`,
                        uri: `db-table://${table.name}`,
                        metadata: {
                            source: 'index_pattern',
                            subject_table: table.name,
                            object_table: tableIdToName.get(refTableId) ?? candidateTable,
                            column: colName,
                            index_name: index.name ?? null,
                            index_columns: index.columns,
                        },
                    });
                    implicitFkCandidateCount += Number(inserted);
                    if (inserted) highPriorityProcessedTargets.add(refTableId);
                    break;
                }
            }
        }

        // ── 컬럼명 패턴 처리 (implicit FK) ─────────────────────────────
        const columns = meta.columns ?? [];
        for (const col of columns) {
            if (!isFkLikeColumn(col.name)) continue;

            const candidates = inferReferencedTables(col.name);
            for (const candidateTable of candidates) {
                const refTableId = tableNameIndex.get(candidateTable.toLowerCase());
                if (!refTableId) continue;
                if (highPriorityProcessedTargets.has(refTableId)) break;

                const inserted = await insertCandidate(table.id, refTableId, 0.5, {
                    column: col.name,
                    inferred_table: candidateTable,
                    source: 'column_pattern',
                }, {
                    kind: 'db_schema_implicit_fk',
                    excerpt: `${table.name}.${col.name} ~= ${candidateTable}`,
                    uri: `db-table://${table.name}`,
                    metadata: {
                        source: 'column_pattern',
                        subject_table: table.name,
                        object_table: tableIdToName.get(refTableId) ?? candidateTable,
                        column: col.name,
                        inferred_table: candidateTable,
                    },
                });
                implicitFkCandidateCount += Number(inserted);
                if (inserted) highPriorityProcessedTargets.add(refTableId);
                break; // 첫 번째 매칭 테이블에서 중단
            }
        }

        // 처리 완료된 테이블의 해시를 artifact에 반영
        const artifactPath = dbSchemaArtifactPath(table.id);
        const schemaHash = hashDbTableSchema(table.name, meta, tableNameSetHash);
        const existingArtifact = artifactMap.get(artifactPath);
        if (existingArtifact) {
            await db
                .update(codeArtifacts)
                .set({
                    sha256: schemaHash,
                    repoRoot: 'db-meta',
                    ownerObjectId: table.id,
                    updatedAt: new Date(),
                })
                .where(eq(codeArtifacts.id, existingArtifact.id));
        } else {
            await db.insert(codeArtifacts).values({
                id: generateId(),
                workspaceId,
                language: 'db_schema',
                repoRoot: 'db-meta',
                filePath: artifactPath,
                ownerObjectId: table.id,
                sha256: schemaHash,
            });
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
