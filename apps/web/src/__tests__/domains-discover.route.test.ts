// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getDbMock,
    runDomainDiscoveryMock,
    getInferenceModelMock,
    createGenerateDomainReviewFnMock,
    andMock,
    eqMock,
    inArrayMock,
    sqlMock,
    objectsTable,
    interactionIntentsTable,
    objectRelationsTable,
    codeArtifactsTable,
} = vi.hoisted(() => ({
    getDbMock: vi.fn(),
    runDomainDiscoveryMock: vi.fn(),
    getInferenceModelMock: vi.fn(() => null),
    createGenerateDomainReviewFnMock: vi.fn(),
    andMock: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
    eqMock: vi.fn((col: unknown, value: unknown) => ({ type: 'eq', col, value })),
    inArrayMock: vi.fn((col: unknown, values: unknown[]) => ({ type: 'inArray', col, values })),
    sqlMock: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
        type: 'sql',
        strings: Array.from(strings),
        values,
    })),
    objectsTable: {
        id: 'objects.id',
        workspaceId: 'objects.workspace_id',
        objectType: 'objects.object_type',
        name: 'objects.name',
        displayName: 'objects.display_name',
        path: 'objects.path',
        parentId: 'objects.parent_id',  // computeImplementingServices 에서 서비스 계층 추적용
        metadata: 'objects.metadata',
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
    and: andMock,
    eq: eqMock,
    inArray: inArrayMock,
    sql: sqlMock,
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
import { OBJECT_TYPES } from '@archi-navi/shared';

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
                    metadata: null,
                },
                {
                    id: 'dom-order',
                    objectType: 'domain',
                    name: 'Orders',
                    displayName: 'Orders',
                    path: '/domain/orders',
                    parentId: null,
                    metadata: null,
                },
                {
                    id: 'fn-create',
                    objectType: 'function',
                    name: 'OrderService.createOrder',
                    displayName: 'createOrder',
                    path: '/orders/create',
                    parentId: null,
                    metadata: null,
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
        // domain 은 제외되고, service 는 signal-only 로 유지되어야 한다
        expect(runDomainDiscoveryMock.mock.calls[0]?.[0]).toMatchObject({
            inputs: {
                workspaceId: 'ws-1',
                objects: [
                    {
                        id: 'svc-order',
                        objectType: 'service',
                        name: 'OrderService',
                        displayName: 'OrderService',
                        path: '/orders',
                        parentId: null,
                        memberEligible: false,
                    },
                    {
                        id: 'fn-create',
                        objectType: 'function',
                        name: 'OrderService.createOrder',
                        displayName: 'createOrder',
                        path: '/orders/create',
                        parentId: null,
                        memberEligible: true,
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
                    metadata: null,
                },
                {
                    id: 'fn-create-order',
                    objectType: 'function',
                    name: 'OrderService.createOrder',
                    displayName: 'createOrder',
                    path: '/orders/create',
                    parentId: null,
                    metadata: null,
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

    it('api_endpoint 객체는 inbound_endpoint intent 로 변환되어 route 신호에 포함된다', async () => {
        const db = buildDbMock([
            [{ count: 1 }],
            [
                {
                    id: 'ep-cart-checkout',
                    objectType: 'api_endpoint',
                    name: 'POST /cart/checkout',
                    displayName: null,
                    path: '/monolith/api/cart-checkout',
                    parentId: 'svc-monolith',
                    metadata: { method: 'POST', path: '/cart/checkout' },
                },
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
        expect(runDomainDiscoveryMock.mock.calls[0]?.[0]).toMatchObject({
            inputs: {
                intents: [
                    {
                        sourceObjectId: 'ep-cart-checkout',
                        intentType: 'inbound_endpoint',
                        externalPathHint: '/cart/checkout',
                        externalRoutePattern: '/cart/checkout',
                        messageTopicHints: [],
                    },
                ],
            },
        });
    });

    it('selectedServiceIds 가 있으면 선택한 물리 서비스에서 나온 신호만 discovery 입력으로 전달한다', async () => {
        const db = buildDbMock([
            [{ count: 1 }],
            [{ id: 'svc-cart' }],
            [
                {
                    id: 'svc-cart',
                    objectType: 'service',
                    name: 'CartService',
                    displayName: null,
                    path: '/cart',
                    parentId: null,
                    metadata: null,
                },
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: null,
                    path: '/order',
                    parentId: null,
                    metadata: null,
                },
                {
                    id: 'fn-cart',
                    objectType: 'function',
                    name: 'CartService.add',
                    displayName: null,
                    path: '/cart/fn',
                    parentId: 'svc-cart',
                    metadata: null,
                },
                {
                    id: 'fn-order',
                    objectType: 'function',
                    name: 'OrderService.create',
                    displayName: null,
                    path: '/order/fn',
                    parentId: 'svc-order',
                    metadata: null,
                },
                {
                    id: 'ep-cart',
                    objectType: 'api_endpoint',
                    name: 'POST /cart',
                    displayName: null,
                    path: '/cart/api',
                    parentId: 'svc-cart',
                    metadata: { path: '/cart' },
                },
                {
                    id: 'db-cart',
                    objectType: 'db_table',
                    name: 'cart',
                    displayName: null,
                    path: '/db/cart',
                    parentId: null,
                    metadata: null,
                },
            ],
            [
                {
                    sourceServiceId: 'svc-cart',
                    sourceFunctionId: 'fn-cart',
                    intentType: 'db_access',
                    externalPathHint: null,
                    externalRoutePattern: null,
                    messageTopicHints: [],
                },
                {
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: 'fn-order',
                    intentType: 'http_call',
                    externalPathHint: '/orders',
                    externalRoutePattern: null,
                    messageTopicHints: [],
                },
            ],
            [
                { subjectObjectId: 'fn-cart', objectId: 'db-cart', relationType: 'read' },
                { subjectObjectId: 'fn-order', objectId: 'db-cart', relationType: 'write' },
                { subjectObjectId: 'fn-order', objectId: 'ep-cart', relationType: 'call' },
            ],
            [
                { ownerObjectId: 'fn-cart', packageName: 'demo.cart', filePath: 'CartService.java' },
                { ownerObjectId: 'fn-order', packageName: 'demo.order', filePath: 'OrderService.java' },
            ],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({ candidates: [] });

        const res = await POST(makeRequest({ workspaceId: 'ws-1', selectedServiceIds: ['svc-cart'] }));

        expect(res.status).toBe(200);
        const inputs = runDomainDiscoveryMock.mock.calls[0]?.[0].inputs;
        expect(inputs.objects.map((o: { id: string }) => o.id)).toEqual([
            'svc-cart',
            'fn-cart',
            'ep-cart',
            'db-cart',
        ]);
        expect(inputs.intents).toEqual([
            expect.objectContaining({ sourceObjectId: 'fn-cart', intentType: 'db_access' }),
            expect.objectContaining({
                sourceObjectId: 'ep-cart',
                intentType: 'inbound_endpoint',
                externalPathHint: '/cart',
            }),
        ]);
        expect(inputs.relations).toEqual([
            { subjectObjectId: 'fn-cart', objectId: 'db-cart', relationType: 'read' },
        ]);
        expect(inputs.codeArtifacts).toEqual([
            { ownerObjectId: 'fn-cart', packageName: 'demo.cart', filePath: 'CartService.java' },
        ]);
    });

    it('selectedServiceIds 에 service 가 아닌 id 가 있으면 400 INVALID_SERVICE_SCOPE', async () => {
        const db = buildDbMock([
            [{ count: 1 }],
            [],
        ]);
        getDbMock.mockResolvedValue(db);

        const res = await POST(makeRequest({ workspaceId: 'ws-1', selectedServiceIds: ['fn-cart'] }));

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatchObject({
            code: 'INVALID_SERVICE_SCOPE',
            invalidServiceIds: ['fn-cart'],
        });
        expect(runDomainDiscoveryMock).not.toHaveBeenCalled();
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

    it('T-pre-types: precondition 은 canonical object type 에서 service/domain 만 제외한다', async () => {
        const db = buildDbMock([
            [{ count: 1 }],
            [
                {
                    id: 'view-1',
                    objectType: 'db_view',
                    name: 'orders_view',
                    displayName: 'orders_view',
                    path: '/db/orders_view',
                    parentId: null,
                    metadata: null,
                },
            ],
            [],
            [],
            [],
        ]);
        getDbMock.mockResolvedValue(db);
        runDomainDiscoveryMock.mockResolvedValue({ candidates: [] });

        const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

        expect(res.status).toBe(200);
        expect(inArrayMock).toHaveBeenCalledWith(
            objectsTable.objectType,
            OBJECT_TYPES.filter((objectType) => objectType !== 'service' && objectType !== 'domain'),
        );
        expect(runDomainDiscoveryMock).toHaveBeenCalledTimes(1);
    });

    it('T-filter: objectType="service" 객체는 discovery 입력에 signal-only 로 남는다', async () => {
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
            inputs: { objects: Array<{ id: string; memberEligible?: boolean }> };
        };
        expect(callArgs.inputs.objects).toEqual([
            { id: 'svc-1', objectType: 'service', name: 'Svc', displayName: null, path: '/svc', parentId: null, memberEligible: false },
            { id: 'fn-1', objectType: 'function', name: 'fn', displayName: null, path: '/svc/fn', parentId: null, memberEligible: true },
        ]);
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
                    metadata: null,
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
