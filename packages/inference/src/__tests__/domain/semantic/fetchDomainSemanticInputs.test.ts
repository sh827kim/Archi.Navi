import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    andMock,
    eqMock,
    inArrayMock,
    orMock,
    objectsTable,
    objectDomainAffinitiesTable,
    interactionIntentsTable,
    evidencesTable,
    objectRelationsTable,
} = vi.hoisted(() => ({
    andMock: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
    eqMock: vi.fn((col: unknown, value: unknown) => ({ type: 'eq', col, value })),
    inArrayMock: vi.fn((col: unknown, values: unknown[]) => ({ type: 'inArray', col, values })),
    orMock: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
    objectsTable: {
        id: 'objects.id',
        workspaceId: 'objects.workspace_id',
        objectType: 'objects.object_type',
        name: 'objects.name',
        displayName: 'objects.display_name',
        description: 'objects.description',
    },
    objectDomainAffinitiesTable: {
        workspaceId: 'oda.workspace_id',
        objectId: 'oda.object_id',
        domainId: 'oda.domain_id',
        affinity: 'oda.affinity',
    },
    interactionIntentsTable: {
        workspaceId: 'ii.workspace_id',
        status: 'ii.status',
        sourceServiceId: 'ii.source_service_id',
        sourceFunctionId: 'ii.source_function_id',
        sourceFilePath: 'ii.source_file_path',
        intentType: 'ii.intent_type',
        methodHint: 'ii.method_hint',
        externalPathHint: 'ii.external_path_hint',
        externalRoutePattern: 'ii.external_route_pattern',
        dbTableHints: 'ii.db_table_hints',
        dbSchemaHint: 'ii.db_schema_hint',
        messageTopicHints: 'ii.message_topic_hints',
        messageQueueHints: 'ii.message_queue_hints',
        messageBrokerKind: 'ii.message_broker_kind',
        evidenceIds: 'ii.evidence_ids',
        id: 'ii.id',
    },
    evidencesTable: {
        workspaceId: 'ev.workspace_id',
        id: 'ev.id',
        filePath: 'ev.file_path',
        lineStart: 'ev.line_start',
        lineEnd: 'ev.line_end',
        excerpt: 'ev.excerpt',
    },
    objectRelationsTable: {
        workspaceId: 'rel.workspace_id',
        status: 'rel.status',
        id: 'rel.id',
        subjectObjectId: 'rel.subject_object_id',
        objectId: 'rel.object_id',
        relationType: 'rel.relation_type',
    },
}));

vi.mock('drizzle-orm', () => ({
    and: andMock,
    eq: eqMock,
    inArray: inArrayMock,
    or: orMock,
}));

vi.mock('@archi-navi/db', () => ({
    objects: objectsTable,
    objectDomainAffinities: objectDomainAffinitiesTable,
    interactionIntents: interactionIntentsTable,
    evidences: evidencesTable,
    objectRelations: objectRelationsTable,
}));

import {
    DomainNotFoundError,
    fetchDomainSemanticInputs,
} from '@/domain/semantic/fetchDomainSemanticInputs';

const EVIDENCE_ID_1 = '00000000-0000-4000-8000-000000000001';
const EVIDENCE_ID_2 = '00000000-0000-4000-8000-000000000002';

function makeThenableResult<T>(rows: T[]) {
    return {
        limit: async () => rows,
        then: (resolve: (value: T[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
    };
}

function buildDbMock(queryResults: unknown[][]) {
    const queue = [...queryResults];
    const whereConditions: unknown[] = [];

    return {
        whereConditions,
        select: vi.fn(() => ({
            from: () => ({
                where: (condition: unknown) => {
                    whereConditions.push(condition);
                    return makeThenableResult(queue.shift() ?? []);
                },
            }),
        })),
    };
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

describe('fetchDomainSemanticInputs', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('function 멤버만 승인된 도메인도 sourceFunctionId 기준 intent/evidence를 수집해야 한다', async () => {
        const db = buildDbMock([
            [{ id: 'dom-1', name: '주문', displayName: '주문' }],
            [{ objectId: 'fn-create-order' }],
            [{ objectId: 'fn-create-order', domainId: 'dom-1', affinity: 0.95 }],
            [
                {
                    id: 'fn-create-order',
                    name: 'OrderService.createOrder',
                    displayName: 'createOrder',
                    objectType: 'function',
                    description: '주문 생성 함수',
                },
            ],
            [
                {
                    id: 'intent-1',
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: 'fn-create-order',
                    sourceFilePath: 'src/order/OrderService.java',
                    intentType: 'http_call',
                    methodHint: 'POST',
                    externalPathHint: '/orders',
                    externalRoutePattern: null,
                    dbTableHints: [],
                    dbSchemaHint: null,
                    messageTopicHints: [],
                    messageQueueHints: [],
                    messageBrokerKind: null,
                    evidenceIds: [EVIDENCE_ID_1],
                },
            ],
            [
                {
                    id: EVIDENCE_ID_1,
                    filePath: 'src/order/OrderService.java',
                    lineStart: 42,
                    lineEnd: 48,
                    excerpt: '@PostMapping("/orders") Order createOrder(...)',
                },
            ],
            [],
        ]);

        const inputs = await fetchDomainSemanticInputs(db as never, {
            workspaceId: 'ws-1',
            domainId: 'dom-1',
        });

        expect(inputs.members).toHaveLength(1);
        expect(inputs.members[0]?.id).toBe('fn-create-order');
        expect(inputs.intents).toHaveLength(1);
        expect(inputs.intents[0]).toMatchObject({
            id: 'intent-1',
            sourceObjectId: 'fn-create-order',
            sourceFunctionId: 'fn-create-order',
            intentType: 'http_call',
            methodHint: 'POST',
            externalPathHint: '/orders',
        });
        expect(inputs.intents[0]?.evidences).toEqual([
            {
                filePath: 'src/order/OrderService.java',
                lineStart: 42,
                lineEnd: 48,
                excerpt: '@PostMapping("/orders") Order createOrder(...)',
            },
        ]);

        const hasFunctionSourceFilter = db.whereConditions.some((condition) =>
            hasPredicate(
                condition,
                (node) => node.type === 'inArray'
                    && node.col === interactionIntentsTable.sourceFunctionId
                    && Array.isArray(node.values)
                    && node.values.includes('fn-create-order'),
            ),
        );
        expect(hasFunctionSourceFilter).toBe(true);

        const hasClosedAtomicIntentFilter = db.whereConditions.some((condition) =>
            hasPredicate(
                condition,
                (node) => node.type === 'eq'
                    && node.col === interactionIntentsTable.status
                    && node.value === 'CLOSED_ATOMIC',
            ),
        );
        expect(hasClosedAtomicIntentFilter).toBe(true);
    });

    it('config/manual anchor evidenceId 는 무시하고 uuid evidence 만 조회해야 한다', async () => {
        const db = buildDbMock([
            [{ id: 'dom-1', name: '주문', displayName: '주문' }],
            [{ objectId: 'svc-order' }],
            [{ objectId: 'svc-order', domainId: 'dom-1', affinity: 0.95 }],
            [
                {
                    id: 'svc-order',
                    name: 'order-service',
                    displayName: 'Order Service',
                    objectType: 'service',
                    description: '주문 서비스',
                },
            ],
            [
                {
                    id: 'intent-1',
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: null,
                    sourceFilePath: 'src/order/application.yml',
                    intentType: 'http_gateway_route',
                    methodHint: 'GET',
                    externalPathHint: '/articles',
                    externalRoutePattern: null,
                    dbTableHints: [],
                    dbSchemaHint: null,
                    messageTopicHints: [],
                    messageQueueHints: [],
                    messageBrokerKind: null,
                    evidenceIds: ['config:src/main/resources/application.yml#articles', EVIDENCE_ID_2, 'manual:test'],
                },
            ],
            [
                {
                    id: EVIDENCE_ID_2,
                    filePath: 'src/main/resources/application.yml',
                    lineStart: 12,
                    lineEnd: 18,
                    excerpt: 'articles: /api/articles',
                },
            ],
            [],
        ]);

        const inputs = await fetchDomainSemanticInputs(db as never, {
            workspaceId: 'ws-1',
            domainId: 'dom-1',
        });

        expect(inputs.intents).toHaveLength(1);
        expect(inputs.intents[0]?.evidences).toEqual([
            {
                filePath: 'src/main/resources/application.yml',
                lineStart: 12,
                lineEnd: 18,
                excerpt: 'articles: /api/articles',
            },
        ]);

        const evidenceQueryFilter = db.whereConditions.find((condition) =>
            hasPredicate(
                condition,
                (node) => node.type === 'inArray' && node.col === evidencesTable.id,
            ),
        );
        expect(evidenceQueryFilter).toBeDefined();
        expect(
            hasPredicate(
                evidenceQueryFilter,
                (node) => node.type === 'inArray'
                    && node.col === evidencesTable.id
                    && Array.isArray(node.values)
                    && node.values.length === 1
                    && node.values[0] === EVIDENCE_ID_2,
            ),
        ).toBe(true);
    });

    it('동일 affinity tie 는 domainId 순으로 결정해 대표 도메인을 안정적으로 고른다', async () => {
        const db = buildDbMock([
            [{ id: 'dom-a', name: '주문', displayName: '주문' }],
            [{ objectId: 'svc-order' }],
            [
                { objectId: 'svc-order', domainId: 'dom-z', affinity: 0.8 },
                { objectId: 'svc-order', domainId: 'dom-a', affinity: 0.8 },
            ],
            [
                {
                    id: 'svc-order',
                    name: 'order-service',
                    displayName: 'Order Service',
                    objectType: 'service',
                    description: '주문 서비스',
                },
            ],
            [],
            [],
        ]);

        const result = await fetchDomainSemanticInputs(db as never, {
            workspaceId: 'ws-1',
            domainId: 'dom-a',
        });

        expect(result.members.map((member) => member.id)).toEqual(['svc-order']);
    });

    it('대표 도메인이 아닌 weak secondary 멤버는 제외하고 relation 은 APPROVED 만 조회한다', async () => {
        const db = buildDbMock([
            [{ id: 'dom-order', name: 'order-domain', displayName: 'Order Domain' }],
            [{ objectId: 'svc-order' }, { objectId: 'svc-payment' }],
            [
                { objectId: 'svc-order', domainId: 'dom-order', affinity: 0.92 },
                { objectId: 'svc-payment', domainId: 'dom-order', affinity: 0.2 },
                { objectId: 'svc-payment', domainId: 'dom-payment', affinity: 0.88 },
            ],
            [
                {
                    id: 'svc-order',
                    name: 'order-service',
                    displayName: 'Order Service',
                    objectType: 'service',
                    description: 'order member',
                },
            ],
            [
                {
                    id: 'intent-1',
                    sourceServiceId: 'svc-order',
                    sourceFunctionId: null,
                    sourceFilePath: 'src/order/OrderController.java',
                    intentType: 'http_gateway_route',
                    methodHint: 'POST',
                    externalPathHint: '/orders',
                    externalRoutePattern: null,
                    dbTableHints: [],
                    dbSchemaHint: null,
                    messageTopicHints: [],
                    messageQueueHints: [],
                    messageBrokerKind: null,
                    evidenceIds: [EVIDENCE_ID_1],
                },
            ],
            [
                {
                    id: EVIDENCE_ID_1,
                    filePath: 'src/order/OrderController.java',
                    lineStart: 10,
                    lineEnd: 18,
                    excerpt: '@PostMapping("/orders")',
                },
            ],
            [
                {
                    id: 'rel-1',
                    subjectObjectId: 'svc-order',
                    objectId: 'svc-shipping',
                    relationType: 'call',
                },
            ],
            [
                {
                    id: 'svc-shipping',
                    name: 'shipping-service',
                    displayName: 'Shipping Service',
                    objectType: 'service',
                },
            ],
            [
                {
                    objectId: 'svc-shipping',
                    domainId: 'dom-shipping',
                    affinity: 0.83,
                },
            ],
        ]);

        const result = await fetchDomainSemanticInputs(db as never, {
            workspaceId: 'ws-1',
            domainId: 'dom-order',
        });

        expect(result.domainId).toBe('dom-order');
        expect(result.members.map((member) => member.id)).toEqual(['svc-order']);
        expect(result.intents.map((intent) => intent.sourceObjectId)).toEqual(['svc-order']);
        expect(result.relations).toEqual([
            {
                id: 'rel-1',
                subjectObjectId: 'svc-order',
                objectId: 'svc-shipping',
                relationType: 'call',
            },
        ]);
        expect(result.objectsById['svc-shipping']?.domainId).toBe('dom-shipping');

        const hasApprovedRelationFilter = db.whereConditions.some((condition) =>
            hasPredicate(
                condition,
                (node) => node.type === 'eq'
                    && node.col === objectRelationsTable.status
                    && node.value === 'APPROVED',
            ),
        );
        expect(hasApprovedRelationFilter).toBe(true);

        const memberObjectFilter = db.whereConditions.find((condition) =>
            hasPredicate(
                condition,
                (node) => node.type === 'inArray'
                    && node.col === objectsTable.id
                    && Array.isArray(node.values)
                    && node.values.length === 1
                    && node.values[0] === 'svc-order',
            ),
        );
        expect(memberObjectFilter).toBeDefined();
    });

    it('domain 객체가 없으면 DomainNotFoundError 를 던진다', async () => {
        const db = buildDbMock([[]]);

        await expect(
            fetchDomainSemanticInputs(db as never, {
                workspaceId: 'ws-1',
                domainId: 'dom-missing',
            }),
        ).rejects.toBeInstanceOf(DomainNotFoundError);
    });
});
