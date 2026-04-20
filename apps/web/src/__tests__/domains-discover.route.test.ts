// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getDbMock,
    runDomainDiscoveryMock,
    getInferenceModelMock,
    createGenerateDomainReviewFnMock,
    objectsTable,
    interactionIntentsTable,
    objectRelationsTable,
    codeArtifactsTable,
} = vi.hoisted(() => ({
    getDbMock: vi.fn(),
    runDomainDiscoveryMock: vi.fn(),
    getInferenceModelMock: vi.fn(() => null),
    createGenerateDomainReviewFnMock: vi.fn(),
    objectsTable: {
        id: 'objects.id',
        workspaceId: 'objects.workspace_id',
        objectType: 'objects.object_type',
        name: 'objects.name',
        displayName: 'objects.display_name',
        path: 'objects.path',
        parentId: 'objects.parent_id',  // computeImplementingServices 에서 서비스 계층 추적용
    },
    interactionIntentsTable: {
        workspaceId: 'interaction_intents.workspace_id',
        status: 'interaction_intents.status',
        sourceServiceId: 'interaction_intents.source_service_id',
        sourceFunctionId: 'interaction_intents.source_function_id',
        intentType: 'interaction_intents.intent_type',
        externalPathHint: 'interaction_intents.external_path_hint',
        externalRoutePattern: 'interaction_intents.external_route_pattern',
        messageTopicHints: 'interaction_intents.message_topic_hints',
    },
    objectRelationsTable: {
        workspaceId: 'object_relations.workspace_id',
        status: 'object_relations.status',
        subjectObjectId: 'object_relations.subject_object_id',
        objectId: 'object_relations.object_id',
        relationType: 'object_relations.relation_type',
    },
    codeArtifactsTable: {
        workspaceId: 'code_artifacts.workspace_id',
        ownerObjectId: 'code_artifacts.owner_object_id',
        packageName: 'code_artifacts.package_name',
        filePath: 'code_artifacts.file_path',
    },
}));

vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
    objects: objectsTable,
    interactionIntents: interactionIntentsTable,
    objectRelations: objectRelationsTable,
    codeArtifacts: codeArtifactsTable,
}));

vi.mock('drizzle-orm', () => ({
    and: (...args: unknown[]) => ({ type: 'and', args }),
    eq: (col: unknown, value: unknown) => ({ type: 'eq', col, value }),
    inArray: (col: unknown, values: unknown[]) => ({ type: 'inArray', col, values }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        type: 'sql',
        strings: Array.from(strings),
        values,
    }),
}));

vi.mock('@archi-navi/inference', async (importOriginal) => {
    // computeImplementingServices 는 순수 함수이므로 실제 구현을 유지하고,
    // runDomainDiscovery 만 mock 으로 교체한다.
    const actual = await importOriginal<typeof import('@archi-navi/inference')>();
    return {
        ...actual,
        runDomainDiscovery: runDomainDiscoveryMock,
    };
});

vi.mock('@/lib/inference-llm', () => ({
    getInferenceModel: getInferenceModelMock,
    createGenerateDomainReviewFn: createGenerateDomainReviewFnMock,
}));

import { POST } from '@/app/api/domains/discover/route';

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/domains/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function buildDbMock(selectResults: unknown[]) {
    const queue = [...selectResults];
    return {
        select: vi.fn(() => ({
            from: () => ({
                where: async () => queue.shift() ?? [],
            }),
        })),
    };
}

describe('POST /api/domains/discover', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('malformed JSON 또는 non-object body 는 400 BAD_REQUEST', async () => {
        const malformedRes = await POST(
            new Request('http://localhost/api/domains/discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{',
            }),
        );
        expect(malformedRes.status).toBe(400);
        expect((await malformedRes.json()).error.code).toBe('BAD_REQUEST');

        const nullRes = await POST(
            new Request('http://localhost/api/domains/discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'null',
            }),
        );
        expect(nullRes.status).toBe(400);
        expect((await nullRes.json()).error.code).toBe('BAD_REQUEST');

        expect(getDbMock).not.toHaveBeenCalled();
        expect(runDomainDiscoveryMock).not.toHaveBeenCalled();
    });

    it('workspaceId 가 문자열이 아니거나 공백이면 400 BAD_REQUEST', async () => {
        const invalidTypeRes = await POST(makeRequest({ workspaceId: { value: 'ws-1' } }));
        expect(invalidTypeRes.status).toBe(400);
        expect((await invalidTypeRes.json()).error.code).toBe('BAD_REQUEST');

        const blankRes = await POST(makeRequest({ workspaceId: '   ' }));
        expect(blankRes.status).toBe(400);
        expect((await blankRes.json()).error.code).toBe('BAD_REQUEST');

        expect(getDbMock).not.toHaveBeenCalled();
        expect(runDomainDiscoveryMock).not.toHaveBeenCalled();
    });

    it('공백이 섞인 workspaceId 는 trim 후 discovery 입력으로 전달', async () => {
        const db = buildDbMock([
            [{ count: 1 }],       // precondition 통과
            [
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: 'OrderService',
                    path: '/orders',
                    parentId: null,
                },
                {
                    id: 'dom-order',
                    objectType: 'domain',
                    name: 'Orders',
                    displayName: 'Orders',
                    path: '/domain/orders',
                    parentId: null,
                },
                {
                    id: 'fn-create',
                    objectType: 'function',
                    name: 'OrderService.createOrder',
                    displayName: 'createOrder',
                    path: '/orders/create',
                    parentId: null,
                },
            ],
            [],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({
            candidates: [{ id: 'cand-orders', slug: 'orders', members: [] }],
        });

        const res = await POST(makeRequest({ workspaceId: '  ws-1  ' }));

        expect(res.status).toBe(200);
        expect(runDomainDiscoveryMock).toHaveBeenCalledTimes(1);
        // service/domain 은 필터링되고 function 만 통과해야 한다
        expect(runDomainDiscoveryMock.mock.calls[0]?.[0]).toMatchObject({
            inputs: {
                workspaceId: 'ws-1',
                objects: [
                    {
                        id: 'fn-create',
                        objectType: 'function',
                        name: 'OrderService.createOrder',
                        displayName: 'createOrder',
                        path: '/orders/create',
                    },
                ],
                intents: [],
                relations: [],
                codeArtifacts: [],
            },
        });

        await expect(res.json()).resolves.toMatchObject({
            success: true,
            data: {
                llmReviewed: false,
                candidates: [{ id: 'cand-orders', slug: 'orders' }],
            },
        });
    });

    it('intent 는 sourceFunctionId 가 있으면 function 기준으로 attribution 한다', async () => {
        const db = buildDbMock([
            [{ count: 1 }],       // precondition 통과
            [
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: 'OrderService',
                    path: '/orders',
                    parentId: null,
                },
                {
                    id: 'fn-create-order',
                    objectType: 'function',
                    name: 'OrderService.createOrder',
                    displayName: 'createOrder',
                    path: '/orders/create',
                    parentId: null,
                },
            ],
            [
                {
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: 'fn-create-order',
                    intentType: 'http_gateway_route',
                    externalPathHint: '/orders',
                    externalRoutePattern: '/orders/**',
                    messageTopicHints: [],
                },
                {
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: null,
                    intentType: 'message_publish',
                    externalPathHint: null,
                    externalRoutePattern: null,
                    messageTopicHints: ['orders.created'],
                },
            ],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({ candidates: [] });

        const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

        expect(res.status).toBe(200);
        expect(runDomainDiscoveryMock).toHaveBeenCalledTimes(1);
        expect(runDomainDiscoveryMock.mock.calls[0]?.[0]).toMatchObject({
            inputs: {
                workspaceId: 'ws-1',
                intents: [
                    {
                        sourceObjectId: 'fn-create-order',
                        intentType: 'http_gateway_route',
                        externalPathHint: '/orders',
                        externalRoutePattern: '/orders/**',
                        messageTopicHints: [],
                    },
                    {
                        sourceObjectId: 'svc-order',
                        intentType: 'message_publish',
                        externalPathHint: null,
                        externalRoutePattern: null,
                        messageTopicHints: ['orders.created'],
                    },
                ],
            },
        });
    });

    it('T-pre: workspace 에 service 외 객체가 없으면 400 PREREQUISITE_NOT_MET', async () => {
        const db = buildDbMock([[{ count: 0 }]]);
        getDbMock.mockResolvedValue(db);

        const res = await POST(makeRequest({ workspaceId: 'ws-empty' }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('PREREQUISITE_NOT_MET');
        expect(body.error.hint?.route).toBe('/inference-runs');
        expect(runDomainDiscoveryMock).not.toHaveBeenCalled();
    });

    it('T-filter: objectType="service" 객체는 멤버 후보 풀에서 제외된다', async () => {
        const db = buildDbMock([
            [{ count: 2 }], // precondition 통과
            [
                { id: 'svc-1', objectType: 'service', name: 'Svc', displayName: null, path: '/svc', parentId: null },
                { id: 'fn-1', objectType: 'function', name: 'fn', displayName: null, path: '/svc/fn', parentId: null },
            ],
            [],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({ candidates: [] });

        const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

        expect(res.status).toBe(200);
        expect(runDomainDiscoveryMock).toHaveBeenCalledTimes(1);
        const callArgs = runDomainDiscoveryMock.mock.calls[0]?.[0] as {
            inputs: { objects: Array<{ id: string }> };
        };
        expect(callArgs.inputs.objects.map((o) => o.id)).toEqual(['fn-1']);
    });

    it('T-impl: candidate 마다 implementingServices 가 멤버의 parent service 로부터 집계된다', async () => {
        const db = buildDbMock([
            [{ count: 4 }], // precondition 통과
            [
                { id: 'svc-A', objectType: 'service', name: 'OrdersService', displayName: null, path: '/a', parentId: null },
                { id: 'f1', objectType: 'function', name: 'create', displayName: null, path: '/a/f1', parentId: 'svc-A' },
                { id: 'f2', objectType: 'function', name: 'update', displayName: null, path: '/a/f2', parentId: 'svc-A' },
                { id: 'f3', objectType: 'function', name: 'archive', displayName: null, path: '/a/f3', parentId: 'svc-A' },
                { id: 'db-x', objectType: 'db_table', name: 'orders', displayName: null, path: '/a/tbl', parentId: 'svc-A' },
            ],
            [],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({
            candidates: [
                {
                    id: 'orders',
                    autoName: 'Orders',
                    signals: { topPathPrefix: null, topRoutePrefix: null, topTopicPrefix: null },
                    members: [
                        { objectId: 'f1', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.5, relationCohesion: 0.3 },
                        { objectId: 'f2', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.5, relationCohesion: 0.3 },
                        { objectId: 'db-x', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.5, relationCohesion: 0.3 },
                    ],
                    review: null,
                },
            ],
        });

        const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.candidates[0].implementingServices).toEqual([
            {
                serviceObjectId: 'svc-A',
                serviceName: 'OrdersService',
                childInDomain: 2, // f1, f2 (db-x 는 코드 자식 아님)
                childTotal: 3,    // f1, f2, f3 (db-x 제외)
                confidence: 2 / 3,
            },
        ]);
    });

    it('T-impl-secondary-exclude: secondary 멤버는 implementingServices 집계에서 제외된다', async () => {
        // fn1 → svcOrders(자식 1개), fn2 → svcPayments(자식 1개)
        // 후보 A(path=/orders): fn1 primary(0.75), fn2 secondary(0.5)
        // 후보 B(path=/payments): fn2 primary(0.8), fn1 secondary(0.5)
        // → A 의 implementingServices 는 svcOrders 만(fn2 제외), B 는 svcPayments 만(fn1 제외)
        const db = buildDbMock([
            [{ count: 2 }], // precondition 통과
            [
                { id: 'svcOrders',   objectType: 'service',  name: 'OrdersService',   displayName: null, path: '/orders',        parentId: null },
                { id: 'svcPayments', objectType: 'service',  name: 'PaymentsService', displayName: null, path: '/payments',      parentId: null },
                { id: 'fn1',         objectType: 'function', name: 'createOrder',     displayName: null, path: '/orders/fn1',    parentId: 'svcOrders' },
                { id: 'fn2',         objectType: 'function', name: 'processPayment',  displayName: null, path: '/payments/fn2',  parentId: 'svcPayments' },
            ],
            [],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        // runDomainDiscovery 를 고정값으로 교체 — primary/secondary 섞인 members 시뮬레이션
        runDomainDiscoveryMock.mockResolvedValue({
            candidates: [
                {
                    id: 'orders',
                    autoName: 'Orders',
                    signals: { topPathPrefix: '/orders', topRoutePrefix: null, topTopicPrefix: null },
                    members: [
                        { objectId: 'fn1', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.75, relationCohesion: 0 },
                        // fn2 는 secondary (affinity ≥ 0.5 기준 포함됐지만 primary 는 payments)
                        { objectId: 'fn2', pathPrefixMatch: 0, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 0, affinity: 0.5,  relationCohesion: 0 },
                    ],
                    review: null,
                },
                {
                    id: 'payments',
                    autoName: 'Payments',
                    signals: { topPathPrefix: '/payments', topRoutePrefix: null, topTopicPrefix: null },
                    members: [
                        { objectId: 'fn2', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.8,  relationCohesion: 0 },
                        // fn1 는 secondary
                        { objectId: 'fn1', pathPrefixMatch: 0, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 0, affinity: 0.5,  relationCohesion: 0 },
                    ],
                    review: null,
                },
            ],
        });

        const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

        expect(res.status).toBe(200);
        const body = await res.json();
        const candidates = body.data.candidates as Array<{
            id: string;
            implementingServices: Array<{ serviceObjectId: string; serviceName: string; childInDomain: number; childTotal: number; confidence: number }>;
        }>;
        const candOrders   = candidates.find((c) => c.id === 'orders');
        const candPayments = candidates.find((c) => c.id === 'payments');

        // 후보 A: svcOrders 만 포함 (fn1 primary), svcPayments 는 포함되지 않아야 함
        expect(candOrders).toBeDefined();
        expect(candOrders!.implementingServices).toEqual([
            { serviceObjectId: 'svcOrders', serviceName: 'OrdersService', childInDomain: 1, childTotal: 1, confidence: 1 },
        ]);

        // 후보 B: svcPayments 만 포함 (fn2 primary), svcOrders 는 포함되지 않아야 함
        expect(candPayments).toBeDefined();
        expect(candPayments!.implementingServices).toEqual([
            { serviceObjectId: 'svcPayments', serviceName: 'PaymentsService', childInDomain: 1, childTotal: 1, confidence: 1 },
        ]);
    });

    it('mixed messageTopicHints 는 string 요소만 남겨 discovery 입력으로 전달한다', async () => {
        const db = buildDbMock([
            [{ count: 1 }],       // precondition 통과
            [
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: 'OrderService',
                    path: '/orders',
                    parentId: null,
                },
            ],
            [
                {
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: null,
                    intentType: 'message_publish',
                    externalPathHint: null,
                    externalRoutePattern: null,
                    messageTopicHints: ['orders.created', null, 123, 'orders.updated'],
                },
            ],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({ candidates: [] });

        const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

        expect(res.status).toBe(200);
        expect(runDomainDiscoveryMock).toHaveBeenCalledTimes(1);
        expect(runDomainDiscoveryMock.mock.calls[0]?.[0]).toMatchObject({
            inputs: {
                intents: [
                    {
                        sourceObjectId: 'svc-order',
                        intentType: 'message_publish',
                        messageTopicHints: ['orders.created', 'orders.updated'],
                    },
                ],
            },
        });
    });
});
