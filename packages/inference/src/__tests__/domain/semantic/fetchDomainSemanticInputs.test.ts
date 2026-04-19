import { describe, expect, it, vi } from 'vitest';

const {
    objectsTable,
    objectDomainAffinitiesTable,
    interactionIntentsTable,
    evidencesTable,
    objectRelationsTable,
} = vi.hoisted(() => ({
    objectsTable: {
        id: 'objects.id',
        workspaceId: 'objects.workspace_id',
        objectType: 'objects.object_type',
        name: 'objects.name',
        displayName: 'objects.display_name',
        description: 'objects.description',
    },
    objectDomainAffinitiesTable: {
        workspaceId: 'object_domain_affinities.workspace_id',
        objectId: 'object_domain_affinities.object_id',
        domainId: 'object_domain_affinities.domain_id',
        affinity: 'object_domain_affinities.affinity',
    },
    interactionIntentsTable: {
        id: 'interaction_intents.id',
        workspaceId: 'interaction_intents.workspace_id',
        sourceServiceId: 'interaction_intents.source_service_id',
        sourceFunctionId: 'interaction_intents.source_function_id',
        sourceFilePath: 'interaction_intents.source_file_path',
        intentType: 'interaction_intents.intent_type',
        methodHint: 'interaction_intents.method_hint',
        externalPathHint: 'interaction_intents.external_path_hint',
        externalRoutePattern: 'interaction_intents.external_route_pattern',
        dbTableHints: 'interaction_intents.db_table_hints',
        dbSchemaHint: 'interaction_intents.db_schema_hint',
        messageTopicHints: 'interaction_intents.message_topic_hints',
        messageQueueHints: 'interaction_intents.message_queue_hints',
        messageBrokerKind: 'interaction_intents.message_broker_kind',
        evidenceIds: 'interaction_intents.evidence_ids',
    },
    evidencesTable: {
        id: 'evidences.id',
        workspaceId: 'evidences.workspace_id',
        filePath: 'evidences.file_path',
        lineStart: 'evidences.line_start',
        lineEnd: 'evidences.line_end',
        excerpt: 'evidences.excerpt',
    },
    objectRelationsTable: {
        id: 'object_relations.id',
        workspaceId: 'object_relations.workspace_id',
        subjectObjectId: 'object_relations.subject_object_id',
        objectId: 'object_relations.object_id',
        relationType: 'object_relations.relation_type',
    },
}));

vi.mock('@archi-navi/db', () => ({
    objects: objectsTable,
    objectDomainAffinities: objectDomainAffinitiesTable,
    interactionIntents: interactionIntentsTable,
    evidences: evidencesTable,
    objectRelations: objectRelationsTable,
}));

type Expr =
    | { type: 'eq'; col: unknown; value: unknown }
    | { type: 'inArray'; col: unknown; values: unknown[] }
    | { type: 'and' | 'or'; args: Expr[] };

vi.mock('drizzle-orm', () => ({
    and: (...args: Expr[]) => ({ type: 'and', args }),
    eq: (col: unknown, value: unknown) => ({ type: 'eq', col, value }),
    inArray: (col: unknown, values: unknown[]) => ({ type: 'inArray', col, values }),
    or: (...args: Expr[]) => ({ type: 'or', args }),
}));

import { fetchDomainSemanticInputs } from '@/domain/semantic/fetchDomainSemanticInputs';

function collectInArrayValues(expr: Expr | undefined, col: unknown): unknown[] {
    if (!expr) return [];
    if (expr.type === 'inArray' && expr.col === col) {
        return expr.values;
    }
    if (expr.type === 'and' || expr.type === 'or') {
        return expr.args.flatMap((arg) => collectInArrayValues(arg, col));
    }
    return [];
}

function buildDbMock() {
    const domainRows = [{ id: 'dom-1', name: '주문', displayName: '주문' }];
    const memberLinks = [{ objectId: 'fn-create-order' }];
    const memberRows = [
        {
            id: 'fn-create-order',
            name: 'OrderService.createOrder',
            displayName: 'createOrder',
            objectType: 'function',
            description: '주문 생성 함수',
        },
    ];
    const intentRows = [
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
            evidenceIds: ['ev-1'],
        },
    ];
    const evidenceRows = [
        {
            id: 'ev-1',
            filePath: 'src/order/OrderService.java',
            lineStart: 42,
            lineEnd: 48,
            excerpt: '@PostMapping("/orders") Order createOrder(...)',
        },
    ];

    const db = {
        select: vi.fn((fields: Record<string, unknown>) => ({
            from: (table: unknown) => ({
                where: (expr: Expr) => {
                    if (table === objectsTable && 'description' in fields) {
                        return Promise.resolve(memberRows);
                    }
                    if (table === objectsTable && 'name' in fields && 'displayName' in fields) {
                        return {
                            limit: async () => domainRows,
                        };
                    }
                    if (table === objectDomainAffinitiesTable && !('domainId' in fields)) {
                        return Promise.resolve(memberLinks);
                    }
                    if (table === interactionIntentsTable) {
                        const serviceIds = new Set(
                            collectInArrayValues(expr, interactionIntentsTable.sourceServiceId)
                                .filter((value): value is string => typeof value === 'string'),
                        );
                        const functionIds = new Set(
                            collectInArrayValues(expr, interactionIntentsTable.sourceFunctionId)
                                .filter((value): value is string => typeof value === 'string'),
                        );
                        return Promise.resolve(
                            intentRows.filter((row) =>
                                serviceIds.has(row.sourceServiceId)
                                || (row.sourceFunctionId != null && functionIds.has(row.sourceFunctionId)),
                            ),
                        );
                    }
                    if (table === evidencesTable) {
                        return Promise.resolve(evidenceRows);
                    }
                    if (table === objectRelationsTable) {
                        return Promise.resolve([]);
                    }
                    if (table === objectDomainAffinitiesTable && 'domainId' in fields) {
                        return Promise.resolve([]);
                    }
                    if (table === objectsTable) {
                        return Promise.resolve([]);
                    }
                    throw new Error('unexpected query');
                },
            }),
        })),
    };

    return db;
}

describe('fetchDomainSemanticInputs', () => {
    it('function 멤버만 승인된 도메인도 sourceFunctionId 기준 intent/evidence를 수집해야 한다', async () => {
        const db = buildDbMock();

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
    });
});
