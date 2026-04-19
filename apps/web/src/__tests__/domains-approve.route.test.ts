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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getDbMock,
    applyRollupChangesMock,
    createDomainAffinityChangedEventMock,
    objectsTable,
    objectDomainAffinitiesTable,
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
    },
    objectDomainAffinitiesTable: {
        workspaceId: 'object_domain_affinities.workspace_id',
        objectId: 'object_domain_affinities.object_id',
        domainId: 'object_domain_affinities.domain_id',
    },
}));

vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
    objects: objectsTable,
    objectDomainAffinities: objectDomainAffinitiesTable,
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
    ownedIds: string[];
    existingDomainId?: string;
    insertedDomainId?: string;
    /** insert 가 partial unique index 충돌로 0행을 돌려주는 race 시뮬레이션 */
    insertReturnsEmpty?: boolean;
    /** race fallback 시 두 번째 tx.select 가 돌려줄 domainId */
    raceFallbackDomainId?: string;
}) {
    const insertSpy = vi.fn();

    // tx.select 호출 시퀀스를 미리 큐로 정의해두고 차례대로 소비.
    const selectQueue: Array<Array<{ id: string }>> = [];
    selectQueue.push(opts.existingDomainId ? [{ id: opts.existingDomainId }] : []);
    if (opts.insertReturnsEmpty) {
        // insert 후 fallback 재조회용
        selectQueue.push(opts.raceFallbackDomainId ? [{ id: opts.raceFallbackDomainId }] : []);
    }

    const txInsertChain = (table: unknown) => {
        const isObjectsTable = table === objectsTable;
        return {
            values: () => ({
                // 신규 코드의 도메인 insert 체인: values().onConflictDoNothing().returning()
                onConflictDoNothing: () => ({
                    returning: async () =>
                        isObjectsTable && opts.insertReturnsEmpty
                            ? []
                            : [{ id: opts.insertedDomainId ?? 'new-domain' }],
                }),
                // 기존 affinity upsert 체인: values().onConflictDoUpdate()
                onConflictDoUpdate: async () => undefined,
            }),
        };
    };

    const tx = {
        select: vi.fn(() => ({
            from: () => ({
                where: () => ({
                    limit: async () => selectQueue.shift() ?? [],
                }),
            }),
        })),
        insert: vi.fn((table: unknown) => {
            insertSpy(table);
            return txInsertChain(table);
        }),
    };

    const db = {
        select: vi.fn(() => ({
            from: () => ({
                where: async () => opts.ownedIds.map((id) => ({ id })),
            }),
        })),
        transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
        insertSpy,
    };

    return db;
}

describe('POST /api/domains/approve', () => {
    afterEach(() => {
        vi.clearAllMocks();
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
});
