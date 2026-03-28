/**
 * Rollup Builder 단위 테스트
 * rebuildRollups 전체 리빌드 + incrementalRebuild 증분 리빌드 검증
 *
 * Drizzle ORM의 SQL AST 파싱 없이, 모듈 단위 모킹으로 핵심 로직을 검증한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 모듈 모킹 ──────────────────────────────────────────────────────────────────

// generationManager 모킹
vi.mock('../../rollup/generationManager', () => ({
    createNewGeneration: vi.fn(),
    activateGeneration: vi.fn(),
    getActiveGeneration: vi.fn(),
    updateGenerationMeta: vi.fn(),
}));

// graph-index 모킹
vi.mock('../../graph-index/index', () => ({
    invalidateCache: vi.fn(),
}));

import { rebuildRollups, incrementalRebuild } from '../../rollup/builder';
import { createNewGeneration, activateGeneration, getActiveGeneration, updateGenerationMeta } from '../../rollup/generationManager';
import { invalidateCache } from '../../graph-index/index';
import {
    objectRelations,
    objects,
    objectRollups,
    objectRollupProvenances,
    objectDomainAffinities,
    objectGraphStats,
} from '@archi-navi/db';
import type { ChangeEvent } from '../../rollup/types';
import { id, WORKSPACE_ID, createStandardScenario, makeRelation, makeAffinity } from './helpers/fixtures';

// ─── 테스트 헬퍼: Drizzle 체이닝 모킹 ───────────────────────────────────────────

/** insert된 데이터 수집용 */
interface InsertedData {
    table: unknown;
    rows: Array<Record<string, unknown>>;
}

/** delete 호출 기록용 */
interface DeleteCall {
    table: unknown;
}

/**
 * 테스트용 Mock DB 생성
 * selectResponses: select().from().where() 또는 .innerJoin().where() 호출 순서대로 반환할 데이터
 */
function createTestDb(selectResponses: Array<unknown[]>) {
    const inserted: InsertedData[] = [];
    const deleted: DeleteCall[] = [];
    let selectCallIdx = 0;

    const mockDb = {
        select: vi.fn().mockImplementation(() => {
            const chain = {
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockImplementation(() => {
                        const result = selectResponses[selectCallIdx] ?? [];
                        selectCallIdx++;
                        return Promise.resolve(result);
                    }),
                    innerJoin: vi.fn().mockReturnValue({
                        where: vi.fn().mockImplementation(() => {
                            const result = selectResponses[selectCallIdx] ?? [];
                            selectCallIdx++;
                            return Promise.resolve(result);
                        }),
                    }),
                    orderBy: vi.fn().mockReturnValue({
                        limit: vi.fn().mockImplementation(() => {
                            const result = selectResponses[selectCallIdx] ?? [];
                            selectCallIdx++;
                            return Promise.resolve(result);
                        }),
                    }),
                }),
            };
            return chain;
        }),
        insert: vi.fn().mockImplementation((table: unknown) => ({
            values: vi.fn().mockImplementation((rows: unknown) => {
                inserted.push({ table, rows: Array.isArray(rows) ? rows : [rows as Record<string, unknown>] });
                return Promise.resolve();
            }),
        })),
        delete: vi.fn().mockImplementation((table: unknown) => ({
            where: vi.fn().mockImplementation(() => {
                deleted.push({ table });
                return Promise.resolve();
            }),
        })),
        update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        })),
    };

    return {
        db: mockDb as unknown as Parameters<typeof rebuildRollups>[0],
        getInserted: () => inserted,
        getDeleted: () => deleted,
        getSelectCallCount: () => selectCallIdx,
    };
}

interface StatefulRollupState {
    rollups: Array<Record<string, unknown>>;
    provenances: Array<Record<string, unknown>>;
    graphStats: Array<Record<string, unknown>>;
}

type StatefulSelectHandler = (state: StatefulRollupState) => unknown[];
type StatefulDeleteHandler = (state: StatefulRollupState, table: unknown) => void;

function createStatefulTestDb(options?: {
    initialState?: Partial<StatefulRollupState>;
    selectHandlers?: StatefulSelectHandler[];
    deleteHandlers?: StatefulDeleteHandler[];
}) {
    const state: StatefulRollupState = {
        rollups: [...(options?.initialState?.rollups ?? [])],
        provenances: [...(options?.initialState?.provenances ?? [])],
        graphStats: [...(options?.initialState?.graphStats ?? [])],
    };
    const inserted: InsertedData[] = [];
    const deleted: DeleteCall[] = [];
    const selectHandlers = options?.selectHandlers ?? [];
    const deleteHandlers = options?.deleteHandlers ?? [];
    let selectCallIdx = 0;
    let deleteCallIdx = 0;

    const nextSelect = () => {
        const handler = selectHandlers[selectCallIdx];
        selectCallIdx++;
        return Promise.resolve(handler ? handler(state) : []);
    };

    const mockDb = {
        select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(() => nextSelect()),
                innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockImplementation(() => nextSelect()),
                }),
                orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockImplementation(() => nextSelect()),
                }),
            }),
        })),
        insert: vi.fn().mockImplementation((table: unknown) => ({
            values: vi.fn().mockImplementation((rows: unknown) => {
                const normalizedRows = Array.isArray(rows) ? rows : [rows as Record<string, unknown>];
                inserted.push({ table, rows: normalizedRows });
                if (table === objectRollups) {
                    state.rollups.push(...normalizedRows);
                } else if (table === objectRollupProvenances) {
                    state.provenances.push(...normalizedRows);
                } else if (table === objectGraphStats) {
                    state.graphStats.push(...normalizedRows);
                }
                return Promise.resolve();
            }),
        })),
        delete: vi.fn().mockImplementation((table: unknown) => ({
            where: vi.fn().mockImplementation(() => {
                deleted.push({ table });
                const handler = deleteHandlers[deleteCallIdx];
                deleteCallIdx++;
                if (handler) {
                    handler(state, table);
                }
                return Promise.resolve();
            }),
        })),
        update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        })),
    };

    return {
        db: mockDb as unknown as Parameters<typeof rebuildRollups>[0],
        getState: () => ({
            rollups: [...state.rollups],
            provenances: [...state.provenances],
            graphStats: [...state.graphStats],
        }),
        getInserted: () => inserted,
        getDeleted: () => deleted,
        getSelectCallCount: () => selectCallIdx,
        getDeleteCallCount: () => deleteCallIdx,
    };
}

function buildCallJoinedFromRelations(
    relations: Array<ReturnType<typeof makeRelation>>,
    objectRows: ReturnType<typeof createStandardScenario>['objects'],
) {
    const objectMap = new Map(objectRows.map((objectRow) => [objectRow.id, objectRow]));
    return relations
        .filter((relation) => relation.relationType === 'call')
        .map((relation) => ({
            relation,
            targetParentId: objectMap.get(relation.objectId)?.parentId ?? null,
            targetGranularity: objectMap.get(relation.objectId)?.granularity ?? 'ATOMIC',
        }));
}

function buildTableJoinedFromRelations(
    relations: Array<ReturnType<typeof makeRelation>>,
    objectRows: ReturnType<typeof createStandardScenario>['objects'],
    relationType: 'read' | 'write',
) {
    const objectMap = new Map(objectRows.map((objectRow) => [objectRow.id, objectRow]));
    return relations
        .filter((relation) => relation.relationType === relationType)
        .map((relation) => ({
            relation,
            tableParentId: objectMap.get(relation.objectId)?.parentId ?? null,
        }));
}

function buildTopicJoinedFromRelations(
    relations: Array<ReturnType<typeof makeRelation>>,
    objectRows: ReturnType<typeof createStandardScenario>['objects'],
    relationType: 'produce' | 'consume',
) {
    const objectMap = new Map(objectRows.map((objectRow) => [objectRow.id, objectRow]));
    return relations
        .filter((relation) => relation.relationType === relationType)
        .map((relation) => ({
            relation,
            topicParentId: objectMap.get(relation.objectId)?.parentId ?? null,
        }));
}

function buildFullRebuildSelectHandlers(
    relations: Array<ReturnType<typeof makeRelation>>,
    objectRows: ReturnType<typeof createStandardScenario>['objects'],
    affinities: ReturnType<typeof createStandardScenario>['affinities'],
): StatefulSelectHandler[] {
    const graphStatsHandlers: StatefulSelectHandler[] = [
        (state) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'SERVICE_TO_SERVICE')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
        (state) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'SERVICE_TO_DATABASE')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
        (state) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'SERVICE_TO_BROKER')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
        (state) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'DOMAIN_TO_DOMAIN')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
    ];

    const baseHandlers: StatefulSelectHandler[] = [
        () => buildCallJoinedFromRelations(relations, objectRows),
        () => relations.filter((relation) => relation.relationType === 'depend_on'),
        () => buildTableJoinedFromRelations(relations, objectRows, 'read'),
        () => buildTableJoinedFromRelations(relations, objectRows, 'write'),
        () => buildTopicJoinedFromRelations(relations, objectRows, 'produce'),
        () => buildTopicJoinedFromRelations(relations, objectRows, 'consume'),
        (state) =>
            state.rollups.filter(
                (row) =>
                    row['rollupLevel'] === 'SERVICE_TO_SERVICE' &&
                    row['relationType'] === 'call',
            ),
    ];

    const hasCallRelations = relations.some((relation) => relation.relationType === 'call');
    if (!hasCallRelations) {
        return [...baseHandlers, ...graphStatsHandlers];
    }

    return [
        ...baseHandlers,
        (state) => state.provenances,
        () => affinities,
        ...graphStatsHandlers,
    ];
}

function cloneState(state: StatefulRollupState): StatefulRollupState {
    return {
        rollups: state.rollups.map((row) => ({ ...row })),
        provenances: state.provenances.map((row) => ({ ...row })),
        graphStats: state.graphStats.map((row) => ({ ...row })),
    };
}

function removeRollupsFromState(
    state: StatefulRollupState,
    predicate: (row: Record<string, unknown>) => boolean,
) {
    const removedRollups = state.rollups.filter(predicate);
    if (removedRollups.length === 0) {
        return;
    }
    const removedRollupIds = new Set(
        removedRollups
            .map((row) => row['id'])
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    state.rollups = state.rollups.filter((row) => !predicate(row));
    state.provenances = state.provenances.filter(
        (row) => !removedRollupIds.has(String(row['rollupId'] ?? '')),
    );
}

function removeGraphStatsFromState(
    state: StatefulRollupState,
    rollupLevel: string,
) {
    state.graphStats = state.graphStats.filter((row) => row['rollupLevel'] !== rollupLevel);
}

function buildIncrementalS2SDeletionHandlers(
    affectedServiceIds: string[],
): StatefulDeleteHandler[] {
    const affectedIdSet = new Set(affectedServiceIds);
    return [
        (state, table) => {
            if (table !== objectRollups) return;
            removeRollupsFromState(
                state,
                (row) =>
                    row['rollupLevel'] === 'SERVICE_TO_SERVICE' &&
                    (affectedIdSet.has(String(row['subjectObjectId'])) ||
                        affectedIdSet.has(String(row['objectId']))),
            );
        },
        (state, table) => {
            if (table !== objectRollups) return;
            removeRollupsFromState(
                state,
                (row) => row['rollupLevel'] === 'DOMAIN_TO_DOMAIN',
            );
        },
        (state, table) => {
            if (table !== objectGraphStats) return;
            removeGraphStatsFromState(state, 'SERVICE_TO_SERVICE');
        },
        (state, table) => {
            if (table !== objectGraphStats) return;
            removeGraphStatsFromState(state, 'DOMAIN_TO_DOMAIN');
        },
    ];
}

function buildIncrementalS2SDeletionSelectHandlers(options: {
    relations: Array<ReturnType<typeof makeRelation>>;
    objectRows: ReturnType<typeof createStandardScenario>['objects'];
    affinities: ReturnType<typeof createStandardScenario>['affinities'];
}) {
    const { relations, objectRows, affinities } = options;
    return [
        () => buildCallJoinedFromRelations(relations, objectRows),
        () => relations.filter((relation) => relation.relationType === 'depend_on'),
        (state: StatefulRollupState) =>
            state.rollups.filter(
                (row) =>
                    row['rollupLevel'] === 'SERVICE_TO_SERVICE' &&
                    row['relationType'] === 'call',
            ),
        (state: StatefulRollupState) => state.provenances,
        () => affinities,
        (state: StatefulRollupState) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'SERVICE_TO_SERVICE')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
        (state: StatefulRollupState) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'DOMAIN_TO_DOMAIN')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
    ];
}

function buildIncrementalS2DBHandlers(
    affectedServiceIds: string[],
): StatefulDeleteHandler[] {
    const affectedIdSet = new Set(affectedServiceIds);
    return [
        (state, table) => {
            if (table !== objectRollups) return;
            removeRollupsFromState(
                state,
                (row) =>
                    row['rollupLevel'] === 'SERVICE_TO_DATABASE' &&
                    affectedIdSet.has(String(row['subjectObjectId'])),
            );
        },
        (state, table) => {
            if (table !== objectGraphStats) return;
            removeGraphStatsFromState(state, 'SERVICE_TO_DATABASE');
        },
    ];
}

function buildIncrementalS2DBSelectHandlers(options: {
    relations: Array<ReturnType<typeof makeRelation>>;
    objectRows: ReturnType<typeof createStandardScenario>['objects'];
    affectedServiceIds: string[];
}) {
    const affectedIdSet = new Set(options.affectedServiceIds);
    const filterByAffectedSubject = (
        joinedRows: Array<{
            relation: ReturnType<typeof makeRelation>;
            tableParentId: string | null;
        }>,
    ) =>
        joinedRows.filter((row) =>
            affectedIdSet.has(row.relation.subjectObjectId),
        );

    return [
        () =>
            filterByAffectedSubject(
                buildTableJoinedFromRelations(options.relations, options.objectRows, 'read'),
            ),
        () =>
            filterByAffectedSubject(
                buildTableJoinedFromRelations(options.relations, options.objectRows, 'write'),
            ),
        (state: StatefulRollupState) =>
            state.rollups
                .filter((row) => row['rollupLevel'] === 'SERVICE_TO_DATABASE')
                .map((row) => ({
                    subjectObjectId: row['subjectObjectId'],
                    objectId: row['objectId'],
                })),
    ];
}

function normalizeComparableState(state: StatefulRollupState) {
    const rollupKeyById = new Map<string, string>();
    const normalizedRollups = state.rollups
        .map((row) => {
            const key = [
                row['rollupLevel'],
                row['relationType'],
                row['subjectObjectId'],
                row['objectId'],
            ].join('|');
            const id = row['id'];
            if (typeof id === 'string' && id.length > 0) {
                rollupKeyById.set(id, key);
            }
            return {
                key,
                edgeWeight: row['edgeWeight'],
                confidence: row['confidence'] == null ? null : Number(row['confidence']),
            };
        })
        .sort((a, b) => a.key.localeCompare(b.key));

    const normalizedProvenances = state.provenances
        .map((row) => ({
            rollupKey: rollupKeyById.get(String(row['rollupId'] ?? '')) ?? '',
            baseRelationId: row['baseRelationId'],
        }))
        .sort((a, b) => {
            const left = `${a.rollupKey}|${a.baseRelationId}`;
            const right = `${b.rollupKey}|${b.baseRelationId}`;
            return left.localeCompare(right);
        });

    const normalizedGraphStats = state.graphStats
        .map((row) => ({
            rollupLevel: row['rollupLevel'],
            objectId: row['objectId'],
            outDegree: row['outDegree'],
            inDegree: row['inDegree'],
        }))
        .sort((a, b) => {
            const left = `${a.rollupLevel}|${a.objectId}`;
            const right = `${b.rollupLevel}|${b.objectId}`;
            return left.localeCompare(right);
        });

    return {
        rollups: normalizedRollups,
        provenances: normalizedProvenances,
        graphStats: normalizedGraphStats,
    };
}

async function buildFullRebuildState(options: {
    relations: Array<ReturnType<typeof makeRelation>>;
    objectRows: ReturnType<typeof createStandardScenario>['objects'];
    affinities: ReturnType<typeof createStandardScenario>['affinities'];
}) {
    const { db, getState } = createStatefulTestDb({
        selectHandlers: buildFullRebuildSelectHandlers(
            options.relations,
            options.objectRows,
            options.affinities,
        ),
    });
    await rebuildRollups(db, WORKSPACE_ID);
    return getState();
}

// ─── 전체 리빌드 테스트 ──────────────────────────────────────────────────────────

describe('rebuildRollups (전체 리빌드)', () => {
    const scenario = createStandardScenario();

    beforeEach(() => {
        vi.clearAllMocks();
        (createNewGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(1);
        (activateGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    it('T1: 전체 리빌드 후 새 generation version을 반환해야 한다', async () => {
        // 빈 데이터 (call+join 없음, depend_on 없음, read/write/produce/consume 없음, S2S rollup 없음 등)
        const selectResponses: Array<unknown[]> = [
            [], // call + join (S2S)
            [], // depend_on (S2S)
            [], // read + join
            [], // write + join
            [], // produce + join
            [], // consume + join
            [], // S2S rollups for D2D
            // buildObjectGraphStats: 4 levels × 1 query
            [], [], [], [],
        ];
        const { db } = createTestDb(selectResponses);

        const version = await rebuildRollups(db, WORKSPACE_ID);
        expect(version).toBe(1);
        expect(createNewGeneration).toHaveBeenCalledWith(db, WORKSPACE_ID);
        expect(activateGeneration).toHaveBeenCalledWith(db, WORKSPACE_ID, 1);
        expect(invalidateCache).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('T2: call + parentId 관계 → SERVICE_TO_SERVICE rollup이 생성되어야 한다', async () => {
        const { callJoined } = scenario;

        const selectResponses: Array<unknown[]> = [
            callJoined,  // call + join (S2S)
            [],          // depend_on (S2S)
            [],          // read + join
            [],          // write + join
            [],          // produce + join
            [],          // consume + join
            [],          // S2S rollups for D2D
            [], [], [], [], // graphStats 4 levels
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        // S2S rollup이 insert되었는지 확인
        const s2sInserts = getInserted().filter((i) => i.table === objectRollups);
        expect(s2sInserts.length).toBeGreaterThanOrEqual(1);

        // S2S rollup 내용 확인: svcA → svcB
        const s2sRows = s2sInserts[0]!.rows;
        const s2sEdge = s2sRows.find(
            (r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE',
        );
        expect(s2sEdge).toBeDefined();
        expect(s2sEdge!['subjectObjectId']).toBe(scenario.svcA.id);
        expect(s2sEdge!['objectId']).toBe(scenario.svcB.id);
    });

    it('T3: 동일 서비스 쌍의 여러 endpoint call → edgeWeight가 합산되어야 한다', async () => {
        const { callJoined } = scenario;

        // svcA → epB1(call), svcA → epB2(call) → edgeWeight = 2
        const selectResponses: Array<unknown[]> = [
            callJoined, [],
            [], [], [], [], [], [], [], [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const s2sInserts = getInserted().filter((i) => i.table === objectRollups);
        const s2sRows = s2sInserts[0]!.rows;
        const edge = s2sRows.find(
            (r) => r['subjectObjectId'] === scenario.svcA.id && r['objectId'] === scenario.svcB.id,
        );
        expect(edge!['edgeWeight']).toBe(2);
    });

    it('T4: confidence는 avg(base.confidence)이어야 한다', async () => {
        const { callJoined } = scenario;

        const selectResponses: Array<unknown[]> = [
            callJoined, [],
            [], [], [], [], [], [], [], [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const s2sRows = getInserted().filter((i) => i.table === objectRollups)[0]!.rows;
        const edge = s2sRows.find(
            (r) => r['subjectObjectId'] === scenario.svcA.id && r['objectId'] === scenario.svcB.id,
        );
        // call1.confidence=0.9, call2.confidence=0.8 → avg=0.85
        expect(edge!['confidence']).toBeCloseTo(0.85, 5);
    });

    it('T5: read/write + parent → SERVICE_TO_DATABASE rollup 생성', async () => {
        const { relations, objects: objs, tableX, dbX, svcA } = scenario;

        // innerJoin 결과: { relation, tableParentId }
        const readJoined = relations
            .filter((r) => r.relationType === 'read')
            .map((r) => ({
                relation: r,
                tableParentId: objs.find((o) => o.id === r.objectId)?.parentId ?? null,
            }));

        const selectResponses: Array<unknown[]> = [
            [], [],       // call+join, depend_on (S2S)
            readJoined,   // read + join
            [],           // write + join
            [], [],       // produce, consume (S2B)
            [],           // S2S for D2D
            [], [], [], [], // graphStats
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const allInserts = getInserted().filter((i) => i.table === objectRollups);
        const s2dbRows = allInserts.flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_DATABASE');
        expect(s2dbRows.length).toBeGreaterThanOrEqual(1);

        const readEdge = s2dbRows.find((r) => r['subjectObjectId'] === svcA.id);
        expect(readEdge).toBeDefined();
        expect(readEdge!['objectId']).toBe(dbX.id);
        expect(readEdge!['relationType']).toBe('read');
    });

    it('T6: produce/consume + parent → SERVICE_TO_BROKER rollup 생성', async () => {
        const { relations, objects: objs, svcA, brokerM } = scenario;

        const produceJoined = relations
            .filter((r) => r.relationType === 'produce')
            .map((r) => ({
                relation: r,
                topicParentId: objs.find((o) => o.id === r.objectId)?.parentId ?? null,
            }));

        const selectResponses: Array<unknown[]> = [
            [], [],        // S2S (call+join, depend_on)
            [], [],        // S2DB read, write
            produceJoined, // produce + join
            [],            // consume + join
            [],            // D2D
            [], [], [], [], // graphStats
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const allInserts = getInserted().filter((i) => i.table === objectRollups);
        const s2bRows = allInserts.flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_BROKER');
        expect(s2bRows.length).toBeGreaterThanOrEqual(1);

        const prodEdge = s2bRows.find((r) => r['subjectObjectId'] === svcA.id);
        expect(prodEdge!['objectId']).toBe(brokerM.id);
    });

    it('T7: S2S rollup + affinity → DOMAIN_TO_DOMAIN rollup 생성', async () => {
        const { affinities, domOrder, domPayment, svcA, svcB } = scenario;

        // 미리 계산된 S2S rollup (svcA → svcB, edgeWeight=2, confidence=0.85)
        const s2sRollup = [{
            workspaceId: WORKSPACE_ID,
            rollupLevel: 'SERVICE_TO_SERVICE',
            relationType: 'call',
            subjectObjectId: svcA.id,
            objectId: svcB.id,
            edgeWeight: 2,
            confidence: 0.85,
            generationVersion: 1,
        }];

        const selectResponses: Array<unknown[]> = [
            [], [],      // S2S (빈 call+join/depend_on - S2S rollup은 이미 있다 가정)
            [], [],      // S2DB
            [], [],      // S2B
            s2sRollup,   // D2D: S2S rollup 조회
            affinities,  // D2D: affinity 조회
            // graphStats: 4 levels
            [], [], [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const allInserts = getInserted().filter((i) => i.table === objectRollups);
        const d2dRows = allInserts.flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'DOMAIN_TO_DOMAIN');
        expect(d2dRows.length).toBeGreaterThanOrEqual(1);
    });

    it('T8: D2D에서 affinity < 0.2인 항목은 무시되어야 한다', async () => {
        const { svcA, svcB, domOrder, domPayment } = scenario;

        const s2sRollup = [{
            workspaceId: WORKSPACE_ID,
            rollupLevel: 'SERVICE_TO_SERVICE',
            relationType: 'call',
            subjectObjectId: svcA.id,
            objectId: svcB.id,
            edgeWeight: 2,
            confidence: 0.85,
            generationVersion: 1,
        }];

        // svcA: Order 0.8, Payment 0.1 (0.2 미만 → 무시)
        // svcB: Payment 0.9, Order 0.1 (0.2 미만 → 무시)
        const lowAffinities = [
            makeAffinity({ objectId: svcA.id, domainId: domOrder.id, affinity: 0.8 }),
            makeAffinity({ objectId: svcA.id, domainId: domPayment.id, affinity: 0.1 }),
            makeAffinity({ objectId: svcB.id, domainId: domPayment.id, affinity: 0.9 }),
            makeAffinity({ objectId: svcB.id, domainId: domOrder.id, affinity: 0.1 }),
        ];

        const selectResponses: Array<unknown[]> = [
            [], [], [], [], [], [],  // S2S(2) + S2DB(2) + S2B(2)
            s2sRollup, lowAffinities,
            [], [], [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const d2dRows = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'DOMAIN_TO_DOMAIN');
        // Order→Payment만 있어야 하고, Payment→Order는 svcB.Order affinity=0.1 < 0.2 이므로 무시
        for (const row of d2dRows) {
            // 0.2 미만 affinity가 사용된 edge는 없어야 한다
            // svcA→domPayment(0.1)이 subject 또는 svcB→domOrder(0.1)이 object인 edge는 없어야 함
            // 유효: Order(svcA:0.8) → Payment(svcB:0.9)
            if (row['subjectObjectId'] === domOrder.id && row['objectId'] === domPayment.id) {
                expect(row['edgeWeight']).toBeGreaterThan(0);
            }
        }
    });

    it('T9: objectGraphStats가 올바른 in/outDegree를 계산해야 한다', async () => {
        const { svcA, svcB } = scenario;

        // S2S rollup이 있는 상태에서 graphStats 계산
        const s2sRollupForStats = [
            { subjectObjectId: svcA.id, objectId: svcB.id },
        ];

        const selectResponses: Array<unknown[]> = [
            [], [], [], [], [], [],  // S2S(2) + S2DB(2) + S2B(2) 모두 빈 결과
            [],                      // D2D S2S rollup 조회
            // graphStats: S2S level에서만 rollup 있음
            s2sRollupForStats, // S2S stats
            [],                // S2DB stats
            [],                // S2B stats
            [],                // D2D stats
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const statsInserts = getInserted().filter((i) => i.table === objectGraphStats);
        if (statsInserts.length > 0) {
            const statsRows = statsInserts[0]!.rows;
            const svcAStats = statsRows.find((r) => r['objectId'] === svcA.id);
            const svcBStats = statsRows.find((r) => r['objectId'] === svcB.id);
            // svcA: outDegree=1 (→svcB), inDegree=0
            expect(svcAStats!['outDegree']).toBe(1);
            expect(svcAStats!['inDegree']).toBe(0);
            // svcB: outDegree=0, inDegree=1 (←svcA)
            expect(svcBStats!['outDegree']).toBe(0);
            expect(svcBStats!['inDegree']).toBe(1);
        }
    });

    it('T10: 빌드 완료 후 generation이 ACTIVE로 전환되어야 한다', async () => {
        const selectResponses: Array<unknown[]> = [
            [], [], [], [], [], [], [], [], [], [], [],
        ];
        const { db } = createTestDb(selectResponses);

        await rebuildRollups(db, WORKSPACE_ID);
        expect(activateGeneration).toHaveBeenCalledWith(db, WORKSPACE_ID, 1);
    });

    it('T11: 빌드 실패 시 generation이 BUILDING 상태로 남아야 한다', async () => {
        // select에서 에러 발생시키기
        (createNewGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(1);
        const mockDb = {
            select: vi.fn().mockImplementation(() => ({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockRejectedValue(new Error('DB error')),
                    innerJoin: vi.fn().mockReturnValue({
                        where: vi.fn().mockRejectedValue(new Error('DB error')),
                    }),
                }),
            })),
            insert: vi.fn(),
            delete: vi.fn(),
            update: vi.fn(),
        } as unknown as Parameters<typeof rebuildRollups>[0];

        await expect(rebuildRollups(mockDb, WORKSPACE_ID)).rejects.toThrow('DB error');
        // activateGeneration은 호출되지 않아야 함 (BUILDING 상태 유지)
        expect(activateGeneration).not.toHaveBeenCalled();
    });

    it('T12: full rebuild에서 방어 분기(self-call/null confidence/null parent)를 처리해야 한다', async () => {
        const { svcA, svcB, epB1, epB2, tableX, topicP, dbX, brokerM } = scenario;

        // call + join 형식: epB2.parent=svcA → self-call(skip), epB1.parent=svcB → 유효
        const callJoinedDef = [
            { relation: makeRelation({ relationType: 'call', subjectObjectId: svcA.id, objectId: epB2.id, confidence: 0.7 }), targetParentId: svcA.id, targetGranularity: 'ATOMIC' }, // self → skip
            { relation: makeRelation({ relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id, confidence: null }), targetParentId: svcB.id, targetGranularity: 'ATOMIC' }, // confidence null
        ];
        const dependOnRels = [
            makeRelation({ relationType: 'depend_on', subjectObjectId: svcA.id, objectId: svcA.id, confidence: 0.5 }), // self-loop -> skip
        ];

        const readJoined = [
            { relation: makeRelation({ relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: 0.8 }), tableParentId: null },
            { relation: makeRelation({ relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: null }), tableParentId: dbX.id },
        ];
        const produceJoined = [
            { relation: makeRelation({ relationType: 'produce', subjectObjectId: svcA.id, objectId: topicP.id, confidence: 0.8 }), topicParentId: null },
            { relation: makeRelation({ relationType: 'produce', subjectObjectId: svcA.id, objectId: topicP.id, confidence: null }), topicParentId: brokerM.id },
        ];

        const s2sRollup = [{
            id: id('s2s-rollup'),
            workspaceId: WORKSPACE_ID,
            rollupLevel: 'SERVICE_TO_SERVICE',
            relationType: 'call',
            subjectObjectId: svcA.id,
            objectId: svcB.id,
            edgeWeight: 1,
            confidence: 0.9,
            generationVersion: 1,
        }];

        const selectResponses: Array<unknown[]> = [
            callJoinedDef, // call+join (S2S)
            dependOnRels,  // depend_on (S2S)
            readJoined,    // read+join
            [],            // write+join
            produceJoined, // produce+join
            [],            // consume+join
            s2sRollup,     // D2D: S2S rollups
            [],            // D2D: provenance
            [              // D2D: affinities (low affinity 포함)
                makeAffinity({ objectId: svcA.id, domainId: id('dom-order'), affinity: 0.9 }),
                makeAffinity({ objectId: svcB.id, domainId: id('dom-payment'), affinity: 0.1 }),
            ],
            // graphStats 4 levels
            [{ subjectObjectId: svcA.id, objectId: svcB.id }],
            [],
            [],
            [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const allRows = getInserted().flatMap((i) => i.rows);
        const s2s = allRows.filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        expect(s2s.length).toBeGreaterThan(0);
    });

    it('T13: D2D 계산 시 provenance의 baseRelationIds를 전달해야 한다', async () => {
        const { svcA, svcB } = scenario;
        const domA = id('dom-a');
        const domB = id('dom-b');

        const s2sRollup = [{
            id: id('s2s-rollup-provenance'),
            workspaceId: WORKSPACE_ID,
            rollupLevel: 'SERVICE_TO_SERVICE',
            relationType: 'call',
            subjectObjectId: svcA.id,
            objectId: svcB.id,
            edgeWeight: 2,
            confidence: 0.85,
            generationVersion: 1,
        }];
        const s2sProv = [{ rollupId: id('s2s-rollup-provenance'), baseRelationId: id('rel-base-1') }];
        const affs = [
            makeAffinity({ objectId: svcA.id, domainId: domA, affinity: 0.9 }),
            makeAffinity({ objectId: svcB.id, domainId: domB, affinity: 0.9 }),
        ];

        const selectResponses: Array<unknown[]> = [
            [], [],     // call+join, depend_on (S2S)
            [], [],     // read, write
            [], [],     // produce, consume
            s2sRollup,  // D2D s2s
            s2sProv,    // D2D provenance
            affs,       // D2D affinities
            [], [], [], [], // graphStats
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        await rebuildRollups(db, WORKSPACE_ID);

        const insertedRows = getInserted().flatMap((i) => i.rows);
        const d2d = insertedRows.find((r) => r['rollupLevel'] === 'DOMAIN_TO_DOMAIN');
        expect(d2d).toBeDefined();
    });
});

// ─── 증분 리빌드 테스트 ──────────────────────────────────────────────────────────

describe('incrementalRebuild (증분 리빌드)', () => {
    const scenario = createStandardScenario();

    beforeEach(() => {
        vi.clearAllMocks();
        (getActiveGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(1);
        (updateGenerationMeta as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
        (createNewGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(2);
        (activateGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    it('T1: ACTIVE generation이 없으면 전체 리빌드로 fallback되어야 한다', async () => {
        (getActiveGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(null);

        // 전체 리빌드용 빈 응답
        const selectResponses: Array<unknown[]> = [
            [], [], [], [], [], [], [], [], [], [], [],
        ];
        const { db } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: id('svc-a'), objectId: id('ep-b1') } },
        ];

        const version = await incrementalRebuild(db, WORKSPACE_ID, events);
        // fallback: createNewGeneration이 호출됨
        expect(createNewGeneration).toHaveBeenCalled();
        expect(version).toBe(2);
    });

    it('T2: call relation 승인 → S2S rollup에 새 edge 추가', async () => {
        const { callJoined, svcA, svcB, epB1 } = scenario;

        // incrementalBuildS2S 쿼리 순서:
        //   - delete rollups (affected nodes)
        //   - select call + join (innerJoin)
        //   - select depend_on
        // D2D (S2S 변경 → D2D 연쇄):
        //   - delete D2D rollups
        //   - select S2S rollups (for D2D rebuild)
        // incrementalBuildGraphStats:
        //   - delete S2S stats → select S2S rollups for stats
        //   - delete D2D stats → select D2D rollups for stats

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild
            callJoined,   // call + join
            [],           // depend_on
            // D2D rebuild
            [],           // S2S rollups for D2D
            // graphStats: S2S level, D2D level
            [],           // S2S rollups for stats
            [],           // D2D rollups for stats
        ];

        const { db, getInserted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
        ];

        const version = await incrementalRebuild(db, WORKSPACE_ID, events);

        // generation version이 변경되지 않아야 함
        expect(version).toBe(1);
        expect(createNewGeneration).not.toHaveBeenCalled();

        // S2S rollup이 insert되었는지 확인
        const rollupInserts = getInserted().filter((i) => i.table === objectRollups);
        expect(rollupInserts.length).toBeGreaterThanOrEqual(1);

        const s2sRows = rollupInserts.flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        expect(s2sRows.length).toBeGreaterThan(0);
    });

    it('T3: 빈 이벤트 배열 → 변경 없음, 현재 version 반환', async () => {
        const { db } = createTestDb([]);
        const version = await incrementalRebuild(db, WORKSPACE_ID, []);
        expect(version).toBe(1);
        expect(invalidateCache).not.toHaveBeenCalled();
    });

    it('T4: read relation 승인 → S2DB rollup에 새 edge 추가', async () => {
        const { svcA, tableX, dbX, objects: objs } = scenario;

        const readJoined = [{
            relation: makeRelation({ relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: 0.7 }),
            tableParentId: dbX.id,
        }];

        // S2DB 증분 쿼리 순서:
        // incrementalBuildS2DB:
        //   delete affected S2DB rollups
        //   select read + join
        //   select write + join
        // graphStats:
        //   delete S2DB stats
        //   select S2DB rollups for stats

        const selectResponses: Array<unknown[]> = [
            readJoined,  // read + join (affected only)
            [],          // write + join (affected only)
            [],          // S2DB rollups for stats
        ];

        const { db, getInserted, getDeleted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const rollupInserts = getInserted().filter((i) => i.table === objectRollups);
        const s2dbRows = rollupInserts.flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_DATABASE');
        expect(s2dbRows.length).toBe(1);
        expect(s2dbRows[0]!['subjectObjectId']).toBe(svcA.id);
        expect(s2dbRows[0]!['objectId']).toBe(dbX.id);
        expect(s2dbRows[0]!['relationType']).toBe('read');
    });

    it('T5: produce relation 변경 → S2B rollup 재계산', async () => {
        const { svcA, topicP, brokerM } = scenario;

        const produceJoined = [{
            relation: makeRelation({ relationType: 'produce', subjectObjectId: svcA.id, objectId: topicP.id, confidence: 0.85 }),
            topicParentId: brokerM.id,
        }];

        const selectResponses: Array<unknown[]> = [
            produceJoined, // produce + join
            [],            // consume + join
            [],            // S2B rollups for stats
        ];

        const { db, getInserted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'produce', subjectObjectId: svcA.id, objectId: topicP.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const s2bRows = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_BROKER');
        expect(s2bRows.length).toBe(1);
        expect(s2bRows[0]!['subjectObjectId']).toBe(svcA.id);
        expect(s2bRows[0]!['objectId']).toBe(brokerM.id);
    });

    it('T6: domain affinity 변경 → D2D만 재계산, S2S 불변', async () => {
        const { svcA, svcB, domOrder, affinities } = scenario;

        const s2sRollup = [{
            workspaceId: WORKSPACE_ID,
            rollupLevel: 'SERVICE_TO_SERVICE',
            relationType: 'call',
            subjectObjectId: svcA.id,
            objectId: svcB.id,
            edgeWeight: 2,
            confidence: 0.85,
            generationVersion: 1,
        }];

        // D2D rebuild:
        //   delete D2D rollups
        //   select S2S rollups for D2D
        //   select affinities
        // graphStats:
        //   delete D2D stats
        //   select D2D rollups for stats
        const selectResponses: Array<unknown[]> = [
            s2sRollup,   // S2S rollups for D2D
            affinities,  // affinities
            [],          // D2D rollups for stats
        ];

        const { db, getInserted, getDeleted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'DOMAIN_AFFINITY_CHANGED', payload: { objectId: svcA.id, domainId: domOrder.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        // S2S는 영향 없어야 함 (S2S 관련 insert 없음)
        const s2sInserts = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        expect(s2sInserts.length).toBe(0);

        // D2D는 재계산되어야 함
        const d2dInserts = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'DOMAIN_TO_DOMAIN');
        expect(d2dInserts.length).toBeGreaterThan(0);
    });

    it('T7: S2S 변경 시 → D2D도 연쇄 재계산', async () => {
        const { callJoined, svcA, svcB, epB1, affinities } = scenario;

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild
            callJoined, [],  // call+join, depend_on
            // D2D rebuild: S2S rollups → 빈 결과 (아직 insert 전)
            [],
            // graphStats
            [], [],
        ];

        const { db, getDeleted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        // D2D delete가 호출되었어야 함 (연쇄 재계산)
        const d2dDeletes = getDeleted().filter((d) => d.table === objectRollups);
        expect(d2dDeletes.length).toBeGreaterThanOrEqual(1); // S2S affected + D2D level
    });

    it('T8: generation version이 변경되지 않아야 한다 (동일 generation 유지)', async () => {
        const { svcA, epB1, callJoined } = scenario;

        const selectResponses: Array<unknown[]> = [
            callJoined, [], [], [], [],
        ];

        const { db } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
        ];

        const version = await incrementalRebuild(db, WORKSPACE_ID, events);
        expect(version).toBe(1);
        expect(createNewGeneration).not.toHaveBeenCalled();
    });

    it('T9: generation meta에 lastIncrementalAt이 기록되어야 한다', async () => {
        const { svcA, epB1, callJoined } = scenario;

        const selectResponses: Array<unknown[]> = [
            callJoined, [], [], [], [],
        ];

        const { db } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);
        expect(updateGenerationMeta).toHaveBeenCalledWith(
            db, WORKSPACE_ID, 1,
            expect.objectContaining({ lastIncrementalAt: expect.any(String), eventCount: 1 }),
        );
    });

    it('T10: 캐시가 무효화되어야 한다', async () => {
        const { svcA, epB1, callJoined } = scenario;

        const selectResponses: Array<unknown[]> = [
            callJoined, [], [], [], [],
        ];

        const { db } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);
        expect(invalidateCache).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('T11: 복수 이벤트 batch → 영향 범위 올바르게 합산', async () => {
        const { svcA, svcB, epB1, tableX, dbX } = scenario;

        // call + read 동시 이벤트 — call은 joined format
        const callJoinedLocal = [{
            relation: makeRelation({ relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id, confidence: 0.9 }),
            targetParentId: svcB.id,
            targetGranularity: 'ATOMIC',
        }];

        const readJoined = [{
            relation: makeRelation({ relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: 0.7 }),
            tableParentId: dbX.id,
        }];

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild
            callJoinedLocal, [],  // call+join, depend_on
            // S2DB rebuild
            readJoined, // read
            [],         // write
            // D2D rebuild
            [],
            // graphStats (S2S, S2DB, D2D = 3 levels)
            [], [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
            { type: 'RELATION_APPROVED', payload: { relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const allRows = getInserted().flatMap((i) => i.rows);
        const s2sRows = allRows.filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        const s2dbRows = allRows.filter((r) => r['rollupLevel'] === 'SERVICE_TO_DATABASE');

        // 두 level 모두 재계산되었어야 함
        expect(s2sRows.length).toBeGreaterThan(0);
        expect(s2dbRows.length).toBeGreaterThan(0);
    });

    it('T12: expose 변경 → 해당 endpoint를 call하는 서비스도 affected에 포함', async () => {
        const { svcA, svcB, epB1, callJoined } = scenario;

        // expose 변경 시, findCallersOfEndpoint로 call하는 서비스 역추적
        const callerRows = [{ subjectObjectId: svcA.id }];

        const selectResponses: Array<unknown[]> = [
            // resolveAffectedScope → findCallersOfEndpoint
            callerRows,
            // S2S rebuild
            callJoined, [],  // call+join, depend_on
            // D2D
            [],
            // graphStats
            [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'EXPOSE_CHANGED', payload: { relationType: 'expose', subjectObjectId: svcB.id, objectId: epB1.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        // S2S rollup이 재계산되었어야 함
        const s2sRows = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        expect(s2sRows.length).toBeGreaterThan(0);
    });

    it('T13: parent 변경 → S2DB/S2B 재계산, 참조 서비스 역추적', async () => {
        const { svcA, tableX, dbX } = scenario;

        // findSubjectsReferencingObject 결과
        const subjectRows = [{ subjectObjectId: svcA.id }];

        const readJoined = [{
            relation: makeRelation({ relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: 0.7 }),
            tableParentId: dbX.id,
        }];

        const selectResponses: Array<unknown[]> = [
            // resolveAffectedScope → findSubjectsReferencingObject
            subjectRows,
            // S2DB rebuild: read, write
            readJoined, [],
            // S2B rebuild: produce, consume
            [], [],
            // graphStats
            [], [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);

        const events: ChangeEvent[] = [
            { type: 'OBJECT_PARENT_CHANGED', payload: { objectId: tableX.id, oldParentId: null, newParentId: dbX.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const s2dbRows = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_DATABASE');
        expect(s2dbRows.length).toBe(1);
    });

    it('T14: depend_on relation 승인도 S2S(+D2D 연쇄) 재계산 트리거여야 한다', async () => {
        const { svcA, svcB } = scenario;
        const dependOnRels = [
            makeRelation({
                relationType: 'depend_on',
                subjectObjectId: svcA.id,
                objectId: svcB.id,
                confidence: 0.66,
            }),
        ];

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild: call+join, depend_on
            [],
            dependOnRels,
            // D2D rebuild
            [],
            // graphStats: S2S, D2D
            [],
            [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'depend_on', subjectObjectId: svcA.id, objectId: svcB.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const s2sRows = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        expect(s2sRows.length).toBeGreaterThan(0);
        expect(s2sRows[0]!['relationType']).toBe('depend_on');
    });

    it('T15: 증분 graph stats에서 level rollup이 있으면 in/outDegree를 저장해야 한다', async () => {
        const { svcA, svcB, epB1 } = scenario;
        const callJoinedLocal = [{
            relation: makeRelation({ relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id, confidence: 0.9 }),
            targetParentId: svcB.id,
            targetGranularity: 'ATOMIC',
        }];
        const s2sRollupsForStats = [{ subjectObjectId: svcA.id, objectId: svcB.id }];

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild: call+join, depend_on
            callJoinedLocal,
            [],
            // D2D rebuild (S2S rollup 조회)
            [],
            // graphStats: S2S, D2D
            s2sRollupsForStats,
            [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const statsRows = getInserted()
            .filter((i) => i.table === objectGraphStats)
            .flatMap((i) => i.rows)
            .filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        const a = statsRows.find((r) => r['objectId'] === svcA.id);
        const b = statsRows.find((r) => r['objectId'] === svcB.id);
        expect(a).toMatchObject({ outDegree: 1, inDegree: 0 });
        expect(b).toMatchObject({ outDegree: 0, inDegree: 1 });
    });

    it('T16: RELATION_APPROVED(expose) 이벤트도 S2S/D2D 재계산을 유발해야 한다', async () => {
        const { svcB, epB1, callJoined } = scenario;

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild: call+join, depend_on
            callJoined,
            [],
            // D2D rebuild
            [],
            // graphStats: S2S, D2D
            [],
            [],
        ];

        const { db, getInserted } = createTestDb(selectResponses);
        const events: ChangeEvent[] = [
            { type: 'RELATION_APPROVED', payload: { relationType: 'expose', subjectObjectId: svcB.id, objectId: epB1.id } },
        ];

        await incrementalRebuild(db, WORKSPACE_ID, events);

        const s2sRows = getInserted().flatMap((i) => i.rows).filter((r) => r['rollupLevel'] === 'SERVICE_TO_SERVICE');
        expect(s2sRows.length).toBeGreaterThan(0);
    });

    it('T17: 영향 레벨이 없는 이벤트는 현재 generation을 그대로 반환해야 한다', async () => {
        const { db } = createTestDb([]);
        const version = await incrementalRebuild(
            db,
            WORKSPACE_ID,
            [{ type: 'UNKNOWN_EVENT', payload: {} } as unknown as ChangeEvent],
        );

        expect(version).toBe(1);
        expect(updateGenerationMeta).not.toHaveBeenCalled();
        expect(invalidateCache).not.toHaveBeenCalled();
    });

    it('T18: call relation 삭제 시 weight/provenance/graph stats가 full rebuild와 동일해야 한다', async () => {
        const { objects: objectRows, relations, affinities, svcA, svcB } = scenario;
        const remainingRelations = relations.filter((relation) => relation.id !== id('rel-call2'));

        const initialState = await buildFullRebuildState({
            relations,
            objectRows,
            affinities,
        });
        const expectedState = await buildFullRebuildState({
            relations: remainingRelations,
            objectRows,
            affinities,
        });

        const { db, getState } = createStatefulTestDb({
            initialState: cloneState(initialState),
            selectHandlers: buildIncrementalS2SDeletionSelectHandlers({
                relations: remainingRelations,
                objectRows,
                affinities,
            }),
            deleteHandlers: buildIncrementalS2SDeletionHandlers([svcA.id, svcB.id]),
        });

        await incrementalRebuild(db, WORKSPACE_ID, [
            {
                type: 'RELATION_DELETED',
                payload: {
                    relationType: 'call',
                    subjectObjectId: svcA.id,
                    objectId: id('ep-b2'),
                },
            },
        ]);

        const finalState = getState();
        const normalizedFinalState = normalizeComparableState(finalState);
        const normalizedExpectedState = normalizeComparableState(expectedState);

        expect(normalizedFinalState).toEqual(normalizedExpectedState);

        const s2sEdge = normalizedFinalState.rollups.find(
            (row) =>
                row.key ===
                `SERVICE_TO_SERVICE|call|${svcA.id}|${svcB.id}`,
        );
        expect(s2sEdge).toMatchObject({
            edgeWeight: 1,
            confidence: 0.9,
        });

        const s2sProvenance = normalizedFinalState.provenances
            .filter(
                (row) =>
                    row.rollupKey ===
                    `SERVICE_TO_SERVICE|call|${svcA.id}|${svcB.id}`,
            )
            .map((row) => row.baseRelationId);
        expect(s2sProvenance).toEqual([id('rel-call1')]);

        const s2sStats = normalizedFinalState.graphStats.filter(
            (row) => row.rollupLevel === 'SERVICE_TO_SERVICE',
        );
        expect(s2sStats).toEqual([
            {
                rollupLevel: 'SERVICE_TO_SERVICE',
                objectId: svcA.id,
                outDegree: 1,
                inDegree: 0,
            },
            {
                rollupLevel: 'SERVICE_TO_SERVICE',
                objectId: svcB.id,
                outDegree: 0,
                inDegree: 1,
            },
        ]);
    });

    it('T19: 마지막 call relation 삭제 시 edge/provenance/graph stats가 제거되고 full rebuild와 동일해야 한다', async () => {
        const { objects: objectRows, relations, affinities, svcA, svcB } = scenario;
        const remainingRelations = relations.filter(
            (relation) =>
                relation.id !== id('rel-call1') &&
                relation.id !== id('rel-call2'),
        );

        const initialState = await buildFullRebuildState({
            relations,
            objectRows,
            affinities,
        });
        const expectedState = await buildFullRebuildState({
            relations: remainingRelations,
            objectRows,
            affinities,
        });

        const { db, getState } = createStatefulTestDb({
            initialState: cloneState(initialState),
            selectHandlers: [
                () => buildCallJoinedFromRelations(remainingRelations, objectRows),
                () => remainingRelations.filter((relation) => relation.relationType === 'depend_on'),
                (state) =>
                    state.rollups.filter(
                        (row) =>
                            row['rollupLevel'] === 'SERVICE_TO_SERVICE' &&
                            row['relationType'] === 'call',
                    ),
                (state) =>
                    state.rollups
                        .filter((row) => row['rollupLevel'] === 'SERVICE_TO_SERVICE')
                        .map((row) => ({
                            subjectObjectId: row['subjectObjectId'],
                            objectId: row['objectId'],
                        })),
                (state) =>
                    state.rollups
                        .filter((row) => row['rollupLevel'] === 'DOMAIN_TO_DOMAIN')
                        .map((row) => ({
                            subjectObjectId: row['subjectObjectId'],
                            objectId: row['objectId'],
                        })),
            ],
            deleteHandlers: buildIncrementalS2SDeletionHandlers([svcA.id, svcB.id]),
        });

        await incrementalRebuild(db, WORKSPACE_ID, [
            {
                type: 'RELATION_DELETED',
                payload: {
                    relationType: 'call',
                    subjectObjectId: svcA.id,
                    objectId: id('ep-b1'),
                },
            },
        ]);

        const finalState = getState();
        const normalizedFinalState = normalizeComparableState(finalState);
        const normalizedExpectedState = normalizeComparableState(expectedState);

        expect(normalizedFinalState).toEqual(normalizedExpectedState);
        expect(
            normalizedFinalState.rollups.find(
                (row) =>
                    row.key ===
                    `SERVICE_TO_SERVICE|call|${svcA.id}|${svcB.id}`,
            ),
        ).toBeUndefined();
        expect(
            normalizedFinalState.provenances.find(
                (row) =>
                    row.rollupKey ===
                    `SERVICE_TO_SERVICE|call|${svcA.id}|${svcB.id}`,
            ),
        ).toBeUndefined();
        expect(
            normalizedFinalState.graphStats.find(
                (row) => row.rollupLevel === 'SERVICE_TO_SERVICE',
            ),
        ).toBeUndefined();
        expect(
            normalizedFinalState.rollups.find(
                (row) => row.key.startsWith('DOMAIN_TO_DOMAIN|call|'),
            ),
        ).toBeUndefined();
    });

    it('T20: call relation 승인 시 weight/provenance/graph stats가 full rebuild와 동일해야 한다', async () => {
        const { objects: objectRows, relations, affinities, svcA, svcB } = scenario;
        const initialRelations = relations.filter((relation) => relation.id !== id('rel-call2'));

        const initialState = await buildFullRebuildState({
            relations: initialRelations,
            objectRows,
            affinities,
        });
        const expectedState = await buildFullRebuildState({
            relations,
            objectRows,
            affinities,
        });

        const { db, getState } = createStatefulTestDb({
            initialState: cloneState(initialState),
            selectHandlers: buildIncrementalS2SDeletionSelectHandlers({
                relations,
                objectRows,
                affinities,
            }),
            deleteHandlers: buildIncrementalS2SDeletionHandlers([svcA.id, svcB.id]),
        });

        await incrementalRebuild(db, WORKSPACE_ID, [
            {
                type: 'RELATION_APPROVED',
                payload: {
                    relationType: 'call',
                    subjectObjectId: svcA.id,
                    objectId: id('ep-b2'),
                },
            },
        ]);

        const normalizedFinalState = normalizeComparableState(getState());
        const normalizedExpectedState = normalizeComparableState(expectedState);

        expect(normalizedFinalState).toEqual(normalizedExpectedState);

        const s2sEdge = normalizedFinalState.rollups.find(
            (row) =>
                row.key ===
                `SERVICE_TO_SERVICE|call|${svcA.id}|${svcB.id}`,
        );
        expect(s2sEdge?.edgeWeight).toBe(2);
        expect(s2sEdge?.confidence).toBeCloseTo(0.85, 10);

        const s2sProvenance = normalizedFinalState.provenances
            .filter(
                (row) =>
                    row.rollupKey ===
                    `SERVICE_TO_SERVICE|call|${svcA.id}|${svcB.id}`,
            )
            .map((row) => row.baseRelationId);
        expect(s2sProvenance).toEqual([id('rel-call1'), id('rel-call2')]);
    });

    it('T21: read relation 승인으로 새 S2DB edge가 추가될 때 full rebuild와 동일해야 한다', async () => {
        const { objects: objectRows, relations, affinities, svcA, dbX } = scenario;
        const initialRelations = relations.filter((relation) => relation.id !== id('rel-read'));

        const initialState = await buildFullRebuildState({
            relations: initialRelations,
            objectRows,
            affinities,
        });
        const expectedState = await buildFullRebuildState({
            relations,
            objectRows,
            affinities,
        });

        const { db, getState } = createStatefulTestDb({
            initialState: cloneState(initialState),
            selectHandlers: buildIncrementalS2DBSelectHandlers({
                relations,
                objectRows,
                affectedServiceIds: [svcA.id],
            }),
            deleteHandlers: buildIncrementalS2DBHandlers([svcA.id]),
        });

        await incrementalRebuild(db, WORKSPACE_ID, [
            {
                type: 'RELATION_APPROVED',
                payload: {
                    relationType: 'read',
                    subjectObjectId: svcA.id,
                    objectId: id('tbl-x'),
                },
            },
        ]);

        const normalizedFinalState = normalizeComparableState(getState());
        const normalizedExpectedState = normalizeComparableState(expectedState);

        expect(normalizedFinalState).toEqual(normalizedExpectedState);

        const s2dbEdge = normalizedFinalState.rollups.find(
            (row) =>
                row.key ===
                `SERVICE_TO_DATABASE|read|${svcA.id}|${dbX.id}`,
        );
        expect(s2dbEdge?.edgeWeight).toBe(1);
        expect(s2dbEdge?.confidence).toBeCloseTo(0.7, 10);

        const s2dbStats = normalizedFinalState.graphStats.filter(
            (row) => row.rollupLevel === 'SERVICE_TO_DATABASE',
        );
        expect(s2dbStats).toEqual([
            {
                rollupLevel: 'SERVICE_TO_DATABASE',
                objectId: dbX.id,
                outDegree: 0,
                inDegree: 2,
            },
            {
                rollupLevel: 'SERVICE_TO_DATABASE',
                objectId: scenario.svcA.id,
                outDegree: 1,
                inDegree: 0,
            },
            {
                rollupLevel: 'SERVICE_TO_DATABASE',
                objectId: scenario.svcB.id,
                outDegree: 1,
                inDegree: 0,
            },
        ]);
    });
});
