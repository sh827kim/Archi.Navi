// @vitest-environment node

/**
 * POST /api/domains/approve 단위 테스트
 * 검증 항목:
 *  - T1: 다른 워크스페이스 객체가 멤버에 끼면 403 + foreignObjectIds
 *  - T2: 같은 (workspace, /domain/<slug>) 가 이미 있으면 재사용 (reused: true)
 *  - T3: 신규 도메인 생성 흐름은 reused: false
 *  - T4: 승인 성공 시 멤버 수만큼 DOMAIN_AFFINITY_CHANGED 이벤트가 발행됨
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
    workspaceId: string;
    name: string;
    primaryMembers: Array<{ objectId: string; affinity: number; confidence: number }>;
    secondaryMembers?: Array<{ objectId: string; affinity: number; confidence: number }>;
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
 */
function buildDbMock(opts: {
    ownedIds: string[];
    existingDomainId?: string;
    insertedDomainId?: string;
}) {
    let selectCallIndex = 0;
    const insertSpy = vi.fn();

    const txInsertChain = () => ({
        values: () => ({
            returning: async () => [{ id: opts.insertedDomainId ?? 'new-domain' }],
            onConflictDoUpdate: async () => undefined,
        }),
    });

    const tx = {
        select: vi.fn(() => ({
            from: () => ({
                where: () => ({
                    limit: async () => (opts.existingDomainId ? [{ id: opts.existingDomainId }] : []),
                }),
            }),
        })),
        insert: vi.fn((table: unknown) => {
            insertSpy(table);
            return txInsertChain();
        }),
    };

    const db = {
        select: vi.fn(() => ({
            from: () => ({
                where: async () => {
                    selectCallIndex += 1;
                    return opts.ownedIds.map((id) => ({ id }));
                },
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
});
