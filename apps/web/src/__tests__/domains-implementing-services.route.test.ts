// @vitest-environment node
/**
 * GET /api/domains/[id]/implementing-services 라우트 단위 테스트
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
    objectRelations: {
        workspaceId: 'object_relations.workspace_id',
        subjectObjectId: 'object_relations.subject_object_id',
        objectId: 'object_relations.object_id',
        relationType: 'object_relations.relation_type',
        confidence: 'object_relations.confidence',
        metadata: 'object_relations.metadata',
        source: 'object_relations.source',
    },
    objects: {
        id: 'objects.id',
        name: 'objects.name',
        displayName: 'objects.display_name',
    },
}));

vi.mock('drizzle-orm', () => ({
    and: (...args: unknown[]) => ({ op: 'and', args }),
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
    desc: (col: unknown) => ({ op: 'desc', col }),
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
        { raw: (str: string) => ({ op: 'raw', str }) },
    ),
}));

describe('GET /api/domains/[id]/implementing-services', () => {
    afterEach(() => {
        vi.resetModules();
        getDbMock.mockReset();
    });

    it('T1: workspaceId 쿼리 파라미터 누락 시 400', async () => {
        const { GET } = await import('@/app/api/domains/[id]/implementing-services/route');
        const res = await GET(
            new Request('http://x/api/domains/dom-1/implementing-services') as never,
            { params: Promise.resolve({ id: 'dom-1' }) },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('T2: 저장된 implements 행을 confidence 내림차순으로 반환 + displayName 우선', async () => {
        getDbMock.mockResolvedValue({
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({
                    innerJoin: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            orderBy: vi.fn().mockResolvedValue([
                                {
                                    serviceId: 'svcA',
                                    serviceName: 'orders_service',
                                    serviceDisplayName: 'OrdersService',
                                    confidence: 0.8,
                                    metadata: { childTotal: 5, childInDomain: 4 },
                                },
                                {
                                    serviceId: 'svcB',
                                    serviceName: 'billing_service',
                                    serviceDisplayName: null,
                                    confidence: 0.2,
                                    metadata: { childTotal: 10, childInDomain: 2 },
                                },
                            ]),
                        }),
                    }),
                }),
            }),
        });
        const { GET } = await import('@/app/api/domains/[id]/implementing-services/route');
        const res = await GET(
            new Request('http://x/api/domains/dom-1/implementing-services?workspaceId=ws-1') as never,
            { params: Promise.resolve({ id: 'dom-1' }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.data.implementingServices).toEqual([
            {
                serviceObjectId: 'svcA',
                serviceName: 'OrdersService',
                childInDomain: 4,
                childTotal: 5,
                confidence: 0.8,
            },
            {
                serviceObjectId: 'svcB',
                serviceName: 'billing_service',
                childInDomain: 2,
                childTotal: 10,
                confidence: 0.2,
            },
        ]);
    });

    it('T3: DB 오류 시 500', async () => {
        getDbMock.mockRejectedValue(new Error('db down'));
        const { GET } = await import('@/app/api/domains/[id]/implementing-services/route');
        const res = await GET(
            new Request('http://x/api/domains/dom-1/implementing-services?workspaceId=ws-1') as never,
            { params: Promise.resolve({ id: 'dom-1' }) },
        );
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error.code).toBe('INTERNAL_ERROR');
    });
});
