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
}));

vi.mock('@archi-navi/inference', () => ({
    runDomainDiscovery: runDomainDiscoveryMock,
}));

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
            [
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: 'OrderService',
                    path: '/orders',
                },
                {
                    id: 'dom-order',
                    objectType: 'domain',
                    name: 'Orders',
                    displayName: 'Orders',
                    path: '/domain/orders',
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
            [
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: 'OrderService',
                    path: '/orders',
                },
                {
                    id: 'fn-create-order',
                    objectType: 'function',
                    name: 'OrderService.createOrder',
                    displayName: 'createOrder',
                    path: '/orders/create',
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

    it('mixed messageTopicHints 는 string 요소만 남겨 discovery 입력으로 전달한다', async () => {
        const db = buildDbMock([
            [
                {
                    id: 'svc-order',
                    objectType: 'service',
                    name: 'OrderService',
                    displayName: 'OrderService',
                    path: '/orders',
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
