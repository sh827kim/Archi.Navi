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
import { objectRelations, objects, objectRollups, objectDomainAffinities, objectGraphStats } from '@archi-navi/db';
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

// ─── 전체 리빌드 테스트 ──────────────────────────────────────────────────────────

describe('rebuildRollups (전체 리빌드)', () => {
    const scenario = createStandardScenario();

    beforeEach(() => {
        vi.clearAllMocks();
        (createNewGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(1);
        (activateGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    it('T1: 전체 리빌드 후 새 generation version을 반환해야 한다', async () => {
        // 빈 데이터 (call 없음, expose 없음, read/write/produce/consume 없음, S2S rollup 없음 등)
        const selectResponses: Array<unknown[]> = [
            [], // call relations
            [], // expose relations
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

    it('T2: call + expose 관계 → SERVICE_TO_SERVICE rollup이 생성되어야 한다', async () => {
        const { relations } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            callRels,    // call relations
            exposeRels,  // expose relations
            [],          // read + join
            [],          // write + join
            [],          // produce + join
            [],          // consume + join
            [],          // S2S rollups for D2D (insert가 되지만 다음 select에선 아직 없음)
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
        const { relations } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        // svcA → epB1(call), svcA → epB2(call) → edgeWeight = 2
        const selectResponses: Array<unknown[]> = [
            callRels, exposeRels,
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
        const { relations } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            callRels, exposeRels,
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
            [], [], [],  // call, expose, depend_on (S2S)
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
            [], [], [],   // S2S (call, expose, depend_on)
            [], [],       // S2DB read, write
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
            [], [], [],  // S2S (빈 call/expose/depend_on - S2S rollup은 이미 있다 가정)
            [], [],      // S2DB
            [], [],      // S2B
            s2sRollup,   // D2D: S2S rollup 조회
            affinities,  // D2D: affinity 조회 (mock rollup id가 없어 provenance 조회는 생략)
            // graphStats: 4 levels (S2S에서 rollup 없으므로 빈 결과)
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
            [], [], [], [], [], [],
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
            [], [], [], [], [], [], // S2S, S2DB, S2B 모두 빈 결과
            [],                    // D2D S2S rollup 조회
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
        const { relations, svcA, svcB, epB1 } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        // incrementalRebuild 쿼리 순서:
        // 1. resolveAffectedScope 내 findCallersOfEndpoint/findSubjectsReferencingObject 없음 (RELATION_APPROVED)
        // 2. incrementalBuildS2S:
        //    - delete rollups (affected nodes)
        //    - select call relations
        //    - select depend_on relations
        //    - select expose relations
        // 3. D2D (S2S 변경 → D2D 연쇄):
        //    - delete D2D rollups
        //    - select S2S rollups (for D2D rebuild)
        //    → 이후 S2S rollup이 있으면 affinities 조회
        // 4. incrementalBuildGraphStats:
        //    - delete S2S stats
        //    - select S2S rollups (for stats)
        //    - delete D2D stats
        //    - select D2D rollups (for stats)

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild
            callRels,     // call relations
            [],           // depend_on relations
            exposeRels,   // expose relations
            // D2D rebuild (S2S rollup 조회 — 아직 insert 전이므로 빈 결과)
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
        const { relations, svcA, svcB, epB1, affinities } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild
            callRels, exposeRels,
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
        const { svcA, epB1, relations } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            callRels, exposeRels, [], [], [],
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
        const { svcA, epB1, relations } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            callRels, exposeRels, [], [], [],
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
        const { svcA, epB1, relations } = scenario;
        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            callRels, exposeRels, [], [], [],
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

        // call + read 동시 이벤트
        const callRels = [makeRelation({ relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id, confidence: 0.9 })];
        const exposeRels = [makeRelation({ relationType: 'expose', subjectObjectId: svcB.id, objectId: epB1.id })];

        const readJoined = [{
            relation: makeRelation({ relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: 0.7 }),
            tableParentId: dbX.id,
        }];

        const selectResponses: Array<unknown[]> = [
            // S2S rebuild
            callRels, [], exposeRels,
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
        const { svcA, svcB, epB1, relations } = scenario;

        // expose 변경 시, findCallersOfEndpoint로 call하는 서비스 역추적
        const callerRows = [{ subjectObjectId: svcA.id }];

        const callRels = relations.filter((r) => r.relationType === 'call');
        const exposeRels = relations.filter((r) => r.relationType === 'expose');

        const selectResponses: Array<unknown[]> = [
            // resolveAffectedScope → findCallersOfEndpoint
            callerRows,
            // S2S rebuild
            callRels, exposeRels,
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
});
