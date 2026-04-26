// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getDbMock,
    andMock,
    eqMock,
    inArrayMock,
    objectsTable,
} = vi.hoisted(() => ({
    getDbMock: vi.fn(),
    andMock: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
    eqMock: vi.fn((col: unknown, value: unknown) => ({ type: 'eq', col, value })),
    inArrayMock: vi.fn((col: unknown, values: unknown[]) => ({ type: 'inArray', col, values })),
    objectsTable: {
        id: 'objects.id',
        workspaceId: 'objects.workspace_id',
        objectType: 'objects.object_type',
    },
}));

vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
    objects: objectsTable,
}));

vi.mock('drizzle-orm', () => ({
    and: andMock,
    eq: eqMock,
    inArray: inArrayMock,
}));

import { POST } from '@/app/api/domains/candidates/merge/route';

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/domains/candidates/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function buildDbMock(ownedRows: unknown[]) {
    return {
        select: vi.fn(() => ({
            from: () => ({
                where: async () => ownedRows,
            }),
        })),
    };
}

function member(objectId: string, overrides: Record<string, unknown> = {}) {
    return {
        objectId,
        pathPrefixMatch: 0,
        routePrefixMatch: 0,
        topicPrefixMatch: 0,
        nameTokenJaccard: 0,
        codeFamilyMatch: 0,
        tableFamilyMatch: 0,
        seedSources: [`name:${objectId}`],
        affinity: 0.5,
        relationCohesion: 0.2,
        ...overrides,
    };
}

function candidate(id: string, members: unknown[]) {
    return {
        id,
        autoName: id,
        signals: {
            topPathPrefix: id,
            topRoutePrefix: `/${id}`,
            topTopicPrefix: null,
            topCodeFamily: null,
            topTableFamily: null,
            seedSourceSummary: [{ source: 'route', value: `/${id}` }],
        },
        members,
        implementingServices: [],
    };
}

describe('POST /api/domains/candidates/merge', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('후보 2개 미만이면 400 BAD_REQUEST', async () => {
        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '장바구니',
                candidates: [candidate('cart', [member('fn-cart')])],
            }),
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('BAD_REQUEST');
        expect(getDbMock).not.toHaveBeenCalled();
    });

    it('중복 멤버는 max score 와 seed union 으로 병합한다', async () => {
        getDbMock.mockResolvedValue(
            buildDbMock([
                { id: 'fn-cart', objectType: 'function' },
                { id: 'fn-query', objectType: 'api_endpoint' },
            ]),
        );

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '장바구니',
                candidates: [
                    candidate('cart', [
                        member('fn-cart', {
                            routePrefixMatch: 1,
                            seedSources: ['route:/cart'],
                            affinity: 0.6,
                            relationCohesion: 0.1,
                        }),
                    ]),
                    candidate('cart-query', [
                        member('fn-cart', {
                            codeFamilyMatch: 1,
                            seedSources: ['code:cart'],
                            affinity: 0.8,
                            relationCohesion: 0.7,
                        }),
                        member('fn-query', {
                            routePrefixMatch: 1,
                            seedSources: ['route:/cart-query'],
                            affinity: 0.55,
                        }),
                    ]),
                ],
            }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.candidate).toMatchObject({
            id: 'merged-cart-cart-query',
            autoName: '장바구니',
            origin: 'manual_merge',
        });
        expect(body.data.candidate.members).toEqual([
            expect.objectContaining({
                objectId: 'fn-cart',
                routePrefixMatch: 1,
                codeFamilyMatch: 1,
                affinity: 0.8,
                relationCohesion: 0.7,
                seedSources: ['route:/cart', 'code:cart'],
            }),
            expect.objectContaining({
                objectId: 'fn-query',
                affinity: 0.55,
            }),
        ]);
        expect(inArrayMock).toHaveBeenCalledWith(objectsTable.id, ['fn-cart', 'fn-query']);
    });

    it('워크스페이스에 없는 멤버가 있으면 403 FORBIDDEN_MEMBER', async () => {
        getDbMock.mockResolvedValue(
            buildDbMock([{ id: 'fn-cart', objectType: 'function' }]),
        );

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '장바구니',
                candidates: [
                    candidate('cart', [member('fn-cart')]),
                    candidate('cart-query', [member('fn-foreign')]),
                ],
            }),
        );

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toMatchObject({
            code: 'FORBIDDEN_MEMBER',
            foreignObjectIds: ['fn-foreign'],
        });
    });

    it('service/domain 멤버는 400 INVALID_MEMBER_TYPE', async () => {
        getDbMock.mockResolvedValue(
            buildDbMock([
                { id: 'fn-cart', objectType: 'function' },
                { id: 'svc-cart', objectType: 'service' },
            ]),
        );

        const res = await POST(
            makeRequest({
                workspaceId: 'ws-1',
                name: '장바구니',
                candidates: [
                    candidate('cart', [member('fn-cart')]),
                    candidate('cart-query', [member('svc-cart')]),
                ],
            }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatchObject({
            code: 'INVALID_MEMBER_TYPE',
            invalidMemberTypes: [{ objectId: 'svc-cart', objectType: 'service' }],
        });
    });
});
