// @vitest-environment node

/**
 * POST /api/domains/approve 단위 테스트
 * 검증 항목:
 *  - T1: 다른 워크스페이스 객체가 멤버에 끼면 403 + foreignObjectIds
 *  - T2: 같은 (workspace, /domain/<slug>) 가 이미 있으면 재사용 (reused: true)
 *  - T3: 신규 도메인 생성 흐름은 reused: false
 *  - T4: 승인 성공 시 멤버 수만큼 DOMAIN_AFFINITY_CHANGED 이벤트가 발행됨
 *  - T5: 동시 승인 race — insert 가 partial unique index 충돌로 0행을 돌려줘도,
 *        재조회로 동일 domainId 에 합류해 reused:true 로 응답한다.
 *  - T6: name 이 slug 정규화 후 빈 문자열이 되면 400 INVALID_NAME 반환
 *  - T7: invalid 멤버 payload 가 섞이면 부분 승인하지 않고 400 으로 거절
 *  - T8: workspaceId/name 이 문자열이 아니거나 공백만 있으면 400
 *  - T9: rollup 갱신 실패는 warning 과 함께 200 success 로 반환
 *  - T10: 중복 objectId 멤버는 400 DUPLICATE_MEMBER 로 거절
 *  - T11: domain 타입 멤버는 400 INVALID_MEMBER_TYPE 으로 거절
 *  - T12: 재승인 시 빠진 기존 멤버 affinity 를 삭제하고 rollup 이벤트도 발행
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getDbMock,
    applyRollupChangesMock,
    createDomainAffinityChangedEventMock,
    objectsTable,
    objectDomainAffinitiesTable,
    objectRelationsTable,
} = vi.hoisted(() => ({
    getDbMock: vi.fn(),
    applyRollupChangesMock: vi.fn(async () => undefined),
    createDomainAffinityChangedEventMock: vi.fn((objectId: string, domainId: string) => ({
        type: 'DOMAIN_AFFINITY_CHANGED',
        payload: { objectId, domainId },
    })),
    objectsTable: {
        id: 'objects.id',
        workspaceId: 'objects.workspace_id',
        path: 'objects.path',
        objectType: 'objects.object_type',
        parentId: 'objects.parent_id',
    },
    objectDomainAffinitiesTable: {
        workspaceId: 'object_domain_affinities.workspace_id',
        objectId: 'object_domain_affinities.object_id',
        domainId: 'object_domain_affinities.domain_id',
        affinity: 'object_domain_affinities.affinity',
    },
    objectRelationsTable: {
        workspaceId: 'object_relations.workspace_id',
        relationType: 'object_relations.relation_type',
        subjectObjectId: 'object_relations.subject_object_id',
        objectId: 'object_relations.object_id',
        isDerived: 'object_relations.is_derived',
        source: 'object_relations.source',
    },
}));

vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
    objects: objectsTable,
    objectDomainAffinities: objectDomainAffinitiesTable,
    objectRelations: objectRelationsTable,
}));

vi.mock('drizzle-orm', () => ({
    and: (...args: unknown[]) => ({ type: 'and', args }),
    eq: (col: unknown, value: unknown) => ({ type: 'eq', col, value }),
    inArray: (col: unknown, values: unknown) => ({ type: 'inArray', col, values }),
    sql: () => 'now()',
}));

vi.mock('@/lib/rollup-change-events', () => ({
    applyRollupChanges: applyRollupChangesMock,
    createDomainAffinityChangedEvent: createDomainAffinityChangedEventMock,
}));

import { POST } from '@/app/api/domains/approve/route';

interface ApproveBody {
    workspaceId: unknown;
    name: unknown;
    primaryMembers: unknown;
    secondaryMembers?: unknown;
}

function makeRequest(body: ApproveBody): Request {
    return new Request('http://localhost/api/domains/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * 테스트용 db mock 빌더
 *  - select(...).from(objects).where(...) 호출을 가로채 ownedRows / existing 응답 반환
 *  - transaction 안에서는 insert/upsert 가 호출되지만 실 동작은 무시 (스파이만 기록)
 *
 * tx.select 는 호출 순서별 큐로 응답한다.
 *  - 첫 select: 기존 도메인 조회. existingDomainId 가 있으면 그 행, 없으면 빈 배열.
 *  - (race 시) 두 번째 select: insert 가 conflict 로 0행이면, raceFallbackDomainId 가 있는 행.
 */
function buildDbMock(opts: {
    // 기존 Task 7 계약 유지 (호환)
    ownedIds?: string[];
    ownedObjects?: Array<{ id: string; objectType: string }>;
    existingDomainId?: string;
    insertedDomainId?: string;
    existingAffinityObjectIds?: string[];
    /** insert 가 partial unique index 충돌로 0행을 돌려주는 race 시뮬레이션 */
    insertReturnsEmpty?: boolean;
    /** race fallback 시 두 번째 tx.select 가 돌려줄 domainId */
    raceFallbackDomainId?: string;
    /** relevantChildren 쿼리 결과 (S_old/S_new 계산용). undefined 면 빈 배열 반환. */
    relevantChildren?: Array<{ id: string; parentId: string | null }>;
    /** serviceParent 필터 결과 (service 로 판정될 parent id 들). undefined 면 빈 배열. */
    serviceParents?: string[];
    // Task 8 추가 계약 ───────────────────────────────────────────
    /**
     * Task 8 간편 입력: 멤버 id 와 objectType 만 넘기면 ownedObjects 를 자동 구성.
     * ownedObjects / ownedIds 가 넘겨지지 않은 경우에만 사용됨.
     */
    members?: Array<{ id: string; objectType: string }>;
    /** Task 8 간편 입력: existingDomainId 대신 객체 형태 */
    existingDomain?: { id: string } | null;
    /** Task 8 간편 입력: existingAffinityObjectIds 별칭 */
    existingAffinityMemberIds?: string[];
    /** Task 8 간편 입력: memberId → parent serviceId. relevantChildren/serviceParents 자동 구성. */
    parentByMember?: Record<string, string>;
    /** service 별 자식 조회용 (Task 8 implements 재계산) */
    serviceChildren?: Record<string, Array<{ id: string; objectType: string }>>;
    /** childId → primary affinity domainId (null 이면 affinity 없음) — DISTINCT ON 결과 mock */
    primaryAffinityByChild?: Record<string, string | null>;
    /** tx.delete(objectRelations) 호출 시, 순서대로 대응 serviceId 를 이 배열에 push. */
    captureObjectRelationDeletes?: string[];
    /** tx.insert(objectRelations).values(row) 의 row 를 이 배열에 push. */
    captureObjectRelationInserts?: unknown[];
}) {
    const insertSpy = vi.fn();
    const deleteWhereConditions: unknown[] = [];

    // ownedObjects 유도 — 간편 입력(members/parentByMember) 과 호환
    const ownedIds = opts.ownedIds ?? Object.keys(opts.parentByMember ?? {});
    const ownedObjects: Array<{ id: string; objectType: string }> = opts.ownedObjects
        ?? opts.members
        ?? ownedIds.map((id) => ({ id, objectType: 'function' }));

    // existingDomainId 유도
    const existingDomainId = opts.existingDomainId
        ?? (opts.existingDomain ? opts.existingDomain.id : undefined);
    const existingAffinityObjectIds = opts.existingAffinityObjectIds
        ?? opts.existingAffinityMemberIds;

    // relevantChildren / serviceParents 유도 — parentByMember 로부터
    let relevantChildren = opts.relevantChildren;
    let serviceParents = opts.serviceParents;
    if (!relevantChildren && opts.parentByMember) {
        relevantChildren = Object.entries(opts.parentByMember).map(([id, parentId]) => ({
            id,
            parentId,
        }));
    }
    if (!serviceParents && opts.parentByMember) {
        serviceParents = Array.from(new Set(Object.values(opts.parentByMember)));
    }

    // tx.select 호출 시퀀스를 미리 큐로 정의해두고 차례대로 소비.
    const selectQueue: Array<Array<{ id: string; parentId?: string | null }>> = [];
    selectQueue.push(existingDomainId ? [{ id: existingDomainId }] : []);
    if (opts.insertReturnsEmpty) {
        // insert 후 fallback 재조회용
        selectQueue.push(opts.raceFallbackDomainId ? [{ id: opts.raceFallbackDomainId }] : []);
    }
    // S_old/S_new 계산용: relevantChildren, serviceParents 순서로 소비됨.
    // 라우트가 relevantObjectIds 가 비어있을 때 select 를 호출하지 않으면 queue 에 남아 무시됨.
    selectQueue.push(relevantChildren ?? []);
    selectQueue.push((serviceParents ?? []).map((id) => ({ id })));

    // Task 8: affectedServiceIds 순회 순서 (sorted) 에 맞춘 delete 카운터 매핑.
    //   라우트는 `for (const serviceId of affectedServiceIds)` 로 반복하며 delete 를 호출하므로
    //   delete 호출 순서 == sorted affectedServiceIds 순서.
    //   serviceChildren 의 key 를 정렬해 deleteCallIndex 에 매핑한다.
    const sortedServiceIds = Object.keys(opts.serviceChildren ?? {}).sort();
    let objectRelationsDeleteCount = 0;

    const txInsertChain = (table: unknown) => {
        const isObjectsTable = table === objectsTable;
        const isObjectRelationsTable = table === objectRelationsTable;
        return {
            values: (row?: unknown) => {
                if (isObjectRelationsTable && opts.captureObjectRelationInserts && row !== undefined) {
                    opts.captureObjectRelationInserts.push(row);
                }
                return {
                    // 도메인 insert 체인: values().onConflictDoNothing().returning()
                    onConflictDoNothing: (_opts?: unknown) => ({
                        returning: async () =>
                            isObjectsTable && opts.insertReturnsEmpty
                                ? []
                                : [{ id: opts.insertedDomainId ?? 'new-domain' }],
                        // objectRelations insert 에서는 .returning 없이 바로 await 되는 경우도 지원
                        then: (resolve: (value: unknown) => unknown) => resolve(undefined),
                    }),
                    // affinity upsert 체인: values().onConflictDoUpdate()
                    onConflictDoUpdate: async () => undefined,
                };
            },
        };
    };

    // tx.select 용 where 결과 빌더
    const makeObjectsSelectResult = () => {
        const consume = () => selectQueue.shift() ?? [];
        return {
            limit: async () => consume(),
            then: (resolve: (value: unknown) => unknown) => resolve(consume()),
        };
    };

    // tx.select 가 반환하는 from builder — 일반 select 용
    const selectFromBuilder = (table: unknown) => ({
        where: (condition: unknown) => {
            void condition;
            if (table === objectsTable) {
                return makeObjectsSelectResult();
            }
            if (table === objectDomainAffinitiesTable) {
                return Promise.resolve(
                    (existingAffinityObjectIds ?? []).map((objectId) => ({ objectId })),
                );
            }
            return Promise.resolve([]);
        },
    });

    // tx.select 는 Task 8 의 "service 자식 조회" 에도 사용됨.
    //   라우트: tx.select({id: objects.id}).from(objects).where(parentId=serviceId AND objectType IN [...])
    //   이 경로는 serviceChildren 에서 children 을 code 자식 필터로 반환해야 한다.
    //   간단히 "objects 테이블 + limit 없음" 경로에 추가 레이어를 끼워넣는다 — 쿼리 순서로 구분.
    //   호출 순서: task8 루프에서 각 serviceId 당 1회씩 호출 (selectQueue 소진 이후).
    const task8ChildrenQueue: Array<Array<{ id: string }>> = sortedServiceIds.map((svcId) =>
        (opts.serviceChildren?.[svcId] ?? [])
            .filter((c) => c.objectType === 'function' || c.objectType === 'api_endpoint')
            .map((c) => ({ id: c.id })),
    );

    const tx = {
        select: vi.fn(() => ({
            from: (table: unknown) => {
                // Task 8 이후 selectQueue 가 다 소진되고 service 자식 조회 단계에 들어오면
                //   task8ChildrenQueue 에서 순서대로 꺼내 반환.
                if (table === objectsTable && selectQueue.length === 0 && task8ChildrenQueue.length > 0) {
                    return {
                        where: (condition: unknown) => {
                            void condition;
                            const next = task8ChildrenQueue.shift() ?? [];
                            return {
                                limit: async () => next,
                                then: (resolve: (value: unknown) => unknown) => resolve(next),
                            };
                        },
                    };
                }
                return selectFromBuilder(table);
            },
        })),
        // Task 8: selectDistinctOn 지원 (primary affinity 조회)
        selectDistinctOn: vi.fn((_distinctCols: unknown, _selection: unknown) => ({
            from: (_table: unknown) => ({
                where: (_cond: unknown) => ({
                    orderBy: (..._args: unknown[]) => {
                        // 최근 delete 호출의 serviceId 와 매칭해 해당 service 의 자식에 대한
                        //   primaryAffinityByChild 를 DISTINCT ON 결과로 반환.
                        // 호출 순서: 현재 반복 중인 serviceId 는 sortedServiceIds[objectRelationsDeleteCount-1]
                        const currentServiceId: string | undefined =
                            sortedServiceIds[objectRelationsDeleteCount - 1];
                        const children = currentServiceId
                            ? (opts.serviceChildren?.[currentServiceId] ?? [])
                                .filter((c: { id: string; objectType: string }) =>
                                    c.objectType === 'function' || c.objectType === 'api_endpoint')
                            : [];
                        const rows = children
                            .map((c: { id: string; objectType: string }) => {
                                const domainId = opts.primaryAffinityByChild?.[c.id] ?? null;
                                return domainId ? { childId: c.id, domainId } : null;
                            })
                            .filter(
                                (r: { childId: string; domainId: string } | null): r is { childId: string; domainId: string } =>
                                    r !== null,
                            );
                        return Promise.resolve(rows);
                    },
                }),
            }),
        })),
        delete: vi.fn((table: unknown) => ({
            where: async (condition: unknown) => {
                deleteWhereConditions.push(condition);
                if (table === objectRelationsTable) {
                    // delete 호출 순서 == sortedServiceIds 순서 가정
                    const serviceId = sortedServiceIds[objectRelationsDeleteCount];
                    if (serviceId !== undefined && opts.captureObjectRelationDeletes) {
                        opts.captureObjectRelationDeletes.push(serviceId);
                    }
                    objectRelationsDeleteCount += 1;
                }
            },
        })),
        insert: vi.fn((table: unknown) => {
            insertSpy(table);
            return txInsertChain(table);
        }),
    };

    const db = {
        select: vi.fn(() => ({
            from: () => ({
                // service 는 멤버 허용 타입이 아니므로 기본값은 'function' 을 사용
                where: async () => ownedObjects,
            }),
        })),
        transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
        insertSpy,
        deleteWhereConditions,
    };

    return db;
}

function hasPredicate(
    input: unknown,
    predicate: (node: { type: string; [key: string]: unknown }) => boolean,
): boolean {
    if (!input || typeof input !== 'object') return false;
    const node = input as { type?: string; args?: unknown[] };
    if (typeof node.type === 'string' && predicate(node as { type: string; [key: string]: unknown })) {
        return true;
    }
    if (Array.isArray(node.args)) {
        return node.args.some((arg) => hasPredicate(arg, predicate));
    }
    return false;
}

describe('POST /api/domains/approve', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('malformed JSON 또는 non-object body 는 400 BAD_REQUEST 반환', async () => {
        const malformedRes = await POST(
            new Request('http://localhost/api/domains/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{',
            }),
        );
        expect(malformedRes.status).toBe(400);
        expect((await malformedRes.json()).error.code).toBe('BAD_REQUEST');

        const nullRes = await POST(
            new Request('http://localhost/api/domains/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'null',
            }),
        );
        expect(nullRes.status).toBe(400);
        expect((await nullRes.json()).error.code).toBe('BAD_REQUEST');

        expect(getDbMock).not.toHaveBeenCalled();
        expect(applyRollupChangesMock).not.toHaveBeenCalled();
    });

    it('T1: 멤버 중 다른 워크스페이스 객체가 있으면 403 + foreignObjectIds 반환', async () => {
        const db = buildDbMock({ ownedIds: ['obj-a'] }); // obj-b 는 미소유
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [
                    { objectId: 'obj-a', affinity: 0.8, confidence: 0.7 },
                    { objectId: 'obj-b', affinity: 0.5, confidence: 0.4 },
                ],
            }),
        );

        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('FORBIDDEN_MEMBER');
        expect(json.error.foreignObjectIds).toEqual(['obj-b']);
        expect(applyRollupChangesMock).not.toHaveBeenCalled();
    });

    it('T2: 같은 (workspace, path) 도메인이 이미 있으면 재사용', async () => {
        const db = buildDbMock({
            ownedIds: ['obj-a', 'obj-b'],
            existingDomainId: 'existing-domain-id',
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [
                    { objectId: 'obj-a', affinity: 0.8, confidence: 0.7 },
                    { objectId: 'obj-b', affinity: 0.6, confidence: 0.5 },
                ],
            }),
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.data.reused).toBe(true);
        expect(json.data.domainId).toBe('existing-domain-id');
        expect(json.data.memberCount).toBe(2);
    });

    it('T3: 기존 도메인이 없으면 신규 생성 (reused: false)', async () => {
        const db = buildDbMock({
            ownedIds: ['obj-a'],
            insertedDomainId: 'fresh-domain-id',
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.data.reused).toBe(false);
        expect(json.data.domainId).toBe('fresh-domain-id');
    });

    it('T7: invalid 멤버 payload 가 섞이면 부분 승인하지 않고 400 INVALID_MEMBER_PAYLOAD', async () => {
        // 혼합 payload 를 조용히 필터하면 일부 멤버만 빠진 채 승인될 수 있으므로,
        // invalid 멤버가 하나라도 섞이면 전체 요청을 거절해야 한다.
        const db = buildDbMock({ ownedIds: ['obj-good', 'obj-bad1', 'obj-bad2'] });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [
                    { objectId: 'obj-good', affinity: 0.8, confidence: 0.7 },
                    { objectId: 'obj-bad1', affinity: 1.5, confidence: 0.5 }, // affinity > 1
                ],
                secondaryMembers: [
                    { objectId: 'obj-bad2', affinity: 0.5, confidence: Infinity }, // confidence = Infinity
                ],
            }),
        );

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.code).toBe('INVALID_MEMBER_PAYLOAD');
        expect(json.error.invalidPrimaryIndexes).toEqual([1]);
        expect(json.error.invalidSecondaryIndexes).toEqual([0]);
        expect(db.transaction).not.toHaveBeenCalled();
        expect(applyRollupChangesMock).not.toHaveBeenCalled();
    });

    it('T8: workspaceId/name 이 문자열이 아니거나 공백이면 400 BAD_REQUEST', async () => {
        const db = buildDbMock({ ownedIds: ['obj-a'] });
        getDbMock.mockResolvedValue(db);

        const invalidWorkspaceRes = await POST(
            makeRequest({
                workspaceId: { value: 'ws-1' },
                name: '주문',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );
        expect(invalidWorkspaceRes.status).toBe(400);
        expect((await invalidWorkspaceRes.json()).error.code).toBe('BAD_REQUEST');

        const blankNameRes = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '   ',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );
        expect(blankNameRes.status).toBe(400);
        expect((await blankNameRes.json()).error.code).toBe('BAD_REQUEST');
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it('T6: name 이 slug 정규화 후 빈 문자열이 되면 400 INVALID_NAME', async () => {
        // 이모지/특수문자만 있는 이름은 /domain/ 로 수렴해 서로 무관한 승인이 같은 도메인으로 섞임 → 차단
        const db = buildDbMock({ ownedIds: ['obj-a'] });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '!!!',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('INVALID_NAME');
        // workspace owner 조회나 rollup 발행까지 가지 않아야 함
        expect(db.transaction).not.toHaveBeenCalled();
        expect(applyRollupChangesMock).not.toHaveBeenCalled();
    });

    it('T5: 동시 승인 race — insert 가 0행이면 재조회로 raced-in 도메인을 reused 로 합류', async () => {
        const db = buildDbMock({
            ownedIds: ['obj-a'],
            // 첫 select 는 비어있고 insert 가 race 로 0행 → fallback 재조회에서 잡힘
            insertReturnsEmpty: true,
            raceFallbackDomainId: 'raced-domain-id',
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        // 우리가 INSERT 를 시도했으나 다른 트랜잭션이 먼저 만들어버렸을 때
        //  → 같은 도메인을 reuse 로 처리해 affinity 가 분기되지 않아야 함
        expect(json.data.reused).toBe(true);
        expect(json.data.domainId).toBe('raced-domain-id');
        // race fallback 이라도 affinity 발행은 정상적으로 일어나야 함
        expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
        const call = applyRollupChangesMock.mock.calls[0] as unknown as [
            unknown,
            string,
            Array<{ payload: { domainId: string } }>,
        ];
        expect(call[2][0]?.payload.domainId).toBe('raced-domain-id');
    });

    it('T4: 승인 성공 시 멤버 수만큼 DOMAIN_AFFINITY_CHANGED 이벤트 발행', async () => {
        const db = buildDbMock({
            ownedIds: ['obj-a', 'obj-b', 'obj-c'],
            insertedDomainId: 'd1',
        });
        getDbMock.mockResolvedValue(db);

        await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [
                    { objectId: 'obj-a', affinity: 0.9, confidence: 0.8 },
                    { objectId: 'obj-b', affinity: 0.7, confidence: 0.6 },
                ],
                secondaryMembers: [{ objectId: 'obj-c', affinity: 0.55, confidence: 0.4 }],
            }),
        );

        expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
        const call = applyRollupChangesMock.mock.calls[0] as unknown as [
            unknown,
            string,
            Array<{ type: string; payload: { objectId: string; domainId: string } }>,
        ];
        const [, wsId, events] = call;
        expect(wsId).toBe('ws-1');
        expect(events).toHaveLength(3);
        expect(events.map((e) => e.payload.objectId).sort()).toEqual(['obj-a', 'obj-b', 'obj-c']);
        for (const event of events) {
            expect(event.type).toBe('DOMAIN_AFFINITY_CHANGED');
            expect(event.payload.domainId).toBe('d1');
        }
    });

    it('T9: rollup 갱신 실패는 warning 과 함께 200 success 로 반환', async () => {
        const db = buildDbMock({
            ownedIds: ['obj-a'],
            insertedDomainId: 'fresh-domain-id',
        });
        getDbMock.mockResolvedValue(db);
        applyRollupChangesMock.mockRejectedValueOnce(new Error('rollup down'));

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.data).toMatchObject({
            domainId: 'fresh-domain-id',
            rollupApplied: false,
        });
        expect(json.warning).toMatchObject({
            code: 'ROLLUP_REFRESH_FAILED',
        });
    });

    it('T10: 같은 objectId 가 중복되면 400 DUPLICATE_MEMBER 반환', async () => {
        const db = buildDbMock({ ownedIds: ['obj-a', 'obj-b'] });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [
                    { objectId: 'obj-a', affinity: 0.8, confidence: 0.7 },
                ],
                secondaryMembers: [
                    { objectId: 'obj-a', affinity: 0.4, confidence: 0.3 },
                ],
            }),
        );

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.code).toBe('DUPLICATE_MEMBER');
        expect(json.error.duplicateObjectIds).toEqual(['obj-a']);
        expect(db.transaction).not.toHaveBeenCalled();
        expect(applyRollupChangesMock).not.toHaveBeenCalled();
    });

    it('T11: domain 타입 멤버가 포함되면 400 INVALID_MEMBER_TYPE 반환', async () => {
        const db = buildDbMock({
            ownedIds: [],
            ownedObjects: [{ id: 'dom-a', objectType: 'domain' }],
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [{ objectId: 'dom-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );

        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.code).toBe('INVALID_MEMBER_TYPE');
        expect(json.error.domainObjectIds).toEqual(['dom-a']);
        expect(db.transaction).not.toHaveBeenCalled();
        expect(applyRollupChangesMock).not.toHaveBeenCalled();
    });

    it('T-service-reject: service objectType 멤버는 400 INVALID_MEMBER_TYPE 으로 거절된다', async () => {
        const db = buildDbMock({
            ownedIds: ['svc-1'],
            ownedObjects: [{ id: 'svc-1', objectType: 'service' }],
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: 'Orders',
                primaryMembers: [{ objectId: 'svc-1', affinity: 0.8, confidence: 0.5 }],
                secondaryMembers: [],
            }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('INVALID_MEMBER_TYPE');
        expect(body.error.serviceObjectIds).toEqual(['svc-1']);
    });

    it('T-affected: S_old ∪ S_new 가 실제로 objectRelations DELETE 대상으로 전달된다', async () => {
        // Task 8: affectedServiceIds 응답 필드는 제거됐으므로,
        // S_old ∪ S_new 가 delete 호출 대상이 되었는지로 계약을 검증.
        const capturedDeletes: string[] = [];
        const db = buildDbMock({
            ownedIds: ['f-a1', 'f-c1'],
            ownedObjects: [
                { id: 'f-a1', objectType: 'function' },
                { id: 'f-c1', objectType: 'function' },
            ],
            existingDomainId: 'dom-D',
            existingAffinityObjectIds: ['f-a1', 'f-b1'],
            relevantChildren: [
                { id: 'f-a1', parentId: 'svcA' },
                { id: 'f-b1', parentId: 'svcB' },
                { id: 'f-c1', parentId: 'svcC' },
            ],
            serviceParents: ['svcA', 'svcB', 'svcC'],
            // implements 재계산을 위한 service 자식 mock (childTotal 은 모두 1 로 단순화)
            serviceChildren: {
                svcA: [{ id: 'f-a1', objectType: 'function' }],
                svcB: [{ id: 'f-b1', objectType: 'function' }],
                svcC: [{ id: 'f-c1', objectType: 'function' }],
            },
            primaryAffinityByChild: { 'f-a1': 'dom-D', 'f-b1': null, 'f-c1': 'dom-D' },
            captureObjectRelationDeletes: capturedDeletes,
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: 'D',
                primaryMembers: [
                    { objectId: 'f-a1', affinity: 0.8, confidence: 0.5 },
                    { objectId: 'f-c1', affinity: 0.8, confidence: 0.5 },
                ],
                secondaryMembers: [],
            }),
        );

        expect(res.status).toBe(200);
        expect(new Set(capturedDeletes)).toEqual(new Set(['svcA', 'svcB', 'svcC']));
    });

    it('T-impl-single: 단일 도메인 승인 시 영향받는 service 에 올바른 confidence 로 implements 행이 INSERT 된다', async () => {
        // svcA 의 자식 function 이 3개 (f1, f2, f3), 도메인 D 에 f1, f2 가 멤버
        // → svcA.implements(D).confidence = 2/3, childInDomain=2, childTotal=3
        const capturedInserts: unknown[] = [];
        const db = buildDbMock({
            members: [
                { id: 'f1', objectType: 'function' },
                { id: 'f2', objectType: 'function' },
            ],
            existingDomain: null,
            parentByMember: { 'f1': 'svcA', 'f2': 'svcA' },
            serviceChildren: {
                svcA: [
                    { id: 'f1', objectType: 'function' },
                    { id: 'f2', objectType: 'function' },
                    { id: 'f3', objectType: 'function' },
                ],
            },
            primaryAffinityByChild: { f1: 'dom-new', f2: 'dom-new', f3: null },
            captureObjectRelationInserts: capturedInserts,
        });
        getDbMock.mockResolvedValue(db);

        const { POST } = await import('@/app/api/domains/approve/route');
        await POST(
            new Request('http://x/api/domains/approve', {
                method: 'POST',
                body: JSON.stringify({
                    workspaceId: 'ws-1',
                    name: 'D',
                    primaryMembers: [
                        { objectId: 'f1', affinity: 0.8, confidence: 0.5 },
                        { objectId: 'f2', affinity: 0.8, confidence: 0.5 },
                    ],
                    secondaryMembers: [],
                }),
            }),
        );

        expect(capturedInserts).toContainEqual(
            expect.objectContaining({
                subjectObjectId: 'svcA',
                relationType: 'implements',
                source: 'DISCOVERY',
                isDerived: true,
                interactionKind: 'STATIC',
                direction: 'OUT',
                confidence: 2 / 3,
                metadata: expect.objectContaining({
                    childTotal: 3,
                    childInDomain: 2,
                    derivedFrom: 'child_membership_ratio',
                }),
            }),
        );
    });

    it('T-impl-stale: 재승인에서 빠진 멤버의 parent service 도 implements 가 재계산되어 stale 하지 않다', async () => {
        const capturedDeletes: string[] = [];
        const capturedInserts: unknown[] = [];
        const db = buildDbMock({
            members: [{ id: 'f-a1', objectType: 'function' }],
            existingDomain: { id: 'dom-D' },
            existingAffinityMemberIds: ['f-a1', 'f-b1'],
            parentByMember: { 'f-a1': 'svcA', 'f-b1': 'svcB' },
            serviceChildren: {
                svcA: [{ id: 'f-a1', objectType: 'function' }],
                svcB: [{ id: 'f-b1', objectType: 'function' }],
            },
            primaryAffinityByChild: { 'f-a1': 'dom-D', 'f-b1': null },
            captureObjectRelationDeletes: capturedDeletes,
            captureObjectRelationInserts: capturedInserts,
        });
        getDbMock.mockResolvedValue(db);

        const { POST } = await import('@/app/api/domains/approve/route');
        await POST(
            new Request('http://x/api/domains/approve', {
                method: 'POST',
                body: JSON.stringify({
                    workspaceId: 'ws-1',
                    name: 'D',
                    primaryMembers: [{ objectId: 'f-a1', affinity: 0.8, confidence: 0.5 }],
                    secondaryMembers: [],
                }),
            }),
        );

        expect(capturedDeletes).toContain('svcA');
        expect(capturedDeletes).toContain('svcB');
        expect(capturedInserts.filter((i) => (i as { subjectObjectId?: string }).subjectObjectId === 'svcA')).toHaveLength(1);
        expect(capturedInserts.filter((i) => (i as { subjectObjectId?: string }).subjectObjectId === 'svcB')).toHaveLength(0);
    });

    it('T-impl-storage: db_table 자식은 childTotal/childInDomain 에 포함되지 않는다', async () => {
        const capturedInserts: unknown[] = [];
        const db = buildDbMock({
            members: [{ id: 'f1', objectType: 'function' }],
            existingDomain: null,
            parentByMember: { 'f1': 'svcA' },
            serviceChildren: {
                svcA: [
                    { id: 'f1', objectType: 'function' },
                    { id: 'tbl-1', objectType: 'db_table' },
                    { id: 'tbl-2', objectType: 'db_table' },
                ],
            },
            primaryAffinityByChild: { f1: 'dom-new', 'tbl-1': null, 'tbl-2': null },
            captureObjectRelationInserts: capturedInserts,
        });
        getDbMock.mockResolvedValue(db);

        const { POST } = await import('@/app/api/domains/approve/route');
        await POST(
            new Request('http://x/api/domains/approve', {
                method: 'POST',
                body: JSON.stringify({
                    workspaceId: 'ws-1',
                    name: 'D',
                    primaryMembers: [{ objectId: 'f1', affinity: 0.8, confidence: 0.5 }],
                    secondaryMembers: [],
                }),
            }),
        );

        const svcAInsert = capturedInserts.find((i) => (i as { subjectObjectId?: string }).subjectObjectId === 'svcA');
        expect(svcAInsert).toMatchObject({
            confidence: 1,
            metadata: { childTotal: 1, childInDomain: 1 },
        });
    });

    it('T12: 재승인 시 누락된 기존 멤버 affinity 를 삭제하고 rollup 이벤트를 발행한다', async () => {
        const db = buildDbMock({
            ownedIds: ['obj-a'],
            existingDomainId: 'existing-domain-id',
            existingAffinityObjectIds: ['obj-a', 'obj-legacy'],
        });
        getDbMock.mockResolvedValue(db);

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '주문',
                primaryMembers: [{ objectId: 'obj-a', affinity: 0.8, confidence: 0.7 }],
            }),
        );

        expect(res.status).toBe(200);
        expect(db.deleteWhereConditions).toHaveLength(1);
        expect(
            hasPredicate(
                db.deleteWhereConditions[0],
                (node) => node.type === 'inArray'
                    && node.col === objectDomainAffinitiesTable.objectId
                    && Array.isArray(node.values)
                    && node.values.length === 1
                    && node.values[0] === 'obj-legacy',
            ),
        ).toBe(true);

        expect(applyRollupChangesMock).toHaveBeenCalledTimes(1);
        const call = (applyRollupChangesMock.mock.calls[0] ?? []) as unknown as [
            unknown,
            unknown,
            Array<{
                payload: { objectId: string; domainId: string };
            }>?,
        ];
        const events = (call[2] ?? []) as Array<{
            payload: { objectId: string; domainId: string };
        }>;
        expect(events.map((event) => event.payload.objectId).sort()).toEqual(['obj-a', 'obj-legacy']);
        expect(events.every((event) => event.payload.domainId === 'existing-domain-id')).toBe(true);
    });
});
