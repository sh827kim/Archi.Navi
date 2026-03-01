/**
 * Evidence Assembler 단위 테스트 (Phase 2, 2-2)
 * assembleEvidenceChain, formatEvidenceChain 검증
 */
import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { assembleEvidenceChain, formatEvidenceChain } from '../../ai/evidence-assembler';
import type { EvidenceChain } from '../../ai/evidence-assembler';
import type { QueryResponse } from '@archi-navi/shared';

// ─── DB 모킹 ──────────────────────────────────────────────────────────────────

/** 테스트용 최소한의 DbClient Mock */
function createMockDb(evidenceRows: Array<{
    id: string;
    workspaceId: string;
    evidenceType: string;
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    excerpt: string | null;
    uri: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
}> = []) {
    // 관계-증거 맵핑 행
    const reRows = evidenceRows.map((ev) => ({
        workspaceId: 'ws-1',
        relationId: 'rel-1',
        evidenceId: ev.id,
    }));

    const selectMock = vi.fn();
    const db = {
        select: selectMock,
    };

    // Drizzle ORM 체이닝 스타일 모킹 (2-step 쿼리)
    // 1st select().from().where() → reRows  (relation_evidences 조회)
    // 2nd select().from().where() → evidenceRows  (evidences 조회)

    let callCount = 0;
    selectMock.mockImplementation(() => {
        callCount++;
        const chain = {
            from: vi.fn().mockReturnThis(),
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn(),
        };

        if (callCount === 1) {
            // relation_evidences 조회
            chain.where.mockResolvedValue(reRows);
        } else {
            // evidences 조회
            chain.where.mockResolvedValue(evidenceRows);
        }

        return chain;
    });

    return db as unknown as Parameters<typeof assembleEvidenceChain>[0];
}

function createFailingMockDb() {
    const selectMock = vi.fn().mockImplementation(() => {
        const chain = {
            from: vi.fn().mockReturnThis(),
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockRejectedValue(new Error('db failure')),
        };
        return chain;
    });

    return { select: selectMock } as unknown as Parameters<typeof assembleEvidenceChain>[0];
}

// ─── 테스트용 QueryResponse 팩토리 ───────────────────────────────────────────

function makeQueryResponse(overrides: Partial<QueryResponse['result']> = {}): QueryResponse {
    return {
        queryType: 'IMPACT_ANALYSIS',
        result: {
            nodes: [
                { id: 'order-service', type: 'service', name: 'order-service', displayName: '주문 서비스', depth: 0 },
                { id: 'payment-service', type: 'service', name: 'payment-service', displayName: '결제 서비스', depth: 1 },
                { id: 'inventory-service', type: 'service', name: 'inventory-service', displayName: '재고 서비스', depth: 2 },
            ],
            edges: [
                {
                    subjectId: 'order-service',
                    objectId: 'payment-service',
                    relationType: 'call',
                    level: 'SERVICE_TO_SERVICE',
                    edgeWeight: 7,
                    confidence: 0.91,
                    provenance: { rollupId: 'rollup-1', baseRelationIds: ['rel-1'] },
                },
                {
                    subjectId: 'order-service',
                    objectId: 'inventory-service',
                    relationType: 'call',
                    level: 'SERVICE_TO_SERVICE',
                    edgeWeight: 3,
                    confidence: 0.70,
                    provenance: { rollupId: 'rollup-2', baseRelationIds: [] },
                },
            ],
            ...overrides,
        },
        meta: {
            generationVersion: 1,
            computedAt: new Date().toISOString(),
            executionMs: 10,
            truncated: false,
        },
    };
}

// ─── assembleEvidenceChain 테스트 ─────────────────────────────────────────────

describe('assembleEvidenceChain', () => {
    it('QueryResponse의 엣지를 EvidenceItem으로 변환해야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        expect(chain.queryType).toBe('IMPACT_ANALYSIS');
        expect(chain.items.length).toBeGreaterThanOrEqual(1);
        expect(chain.items.every((item) => item.score >= 0)).toBe(true);
    });

    it('엣지가 없으면 빈 체인을 반환해야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse({ nodes: [], edges: [] });
        const chain = await assembleEvidenceChain(db, response);

        expect(chain.items).toHaveLength(0);
        expect(chain.totalCount).toBe(0);
        expect(chain.truncated).toBe(false);
    });

    it('score = confidence × edgeWeight / (hop + 1) 공식이 적용되어야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        // order → payment: hop=0, confidence=0.91, weight=7
        // score = 0.91 × 7 / (0 + 1) = 6.37
        const paymentItem = chain.items.find(
            (i) => i.targetId === 'payment-service' || i.targetName === '결제 서비스',
        );
        if (paymentItem) {
            expect(paymentItem.score).toBeCloseTo(0.91 * 7 / 1, 2);
        }
    });

    it('score 내림차순으로 정렬되어야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        for (let i = 1; i < chain.items.length; i++) {
            expect(chain.items[i - 1]!.score).toBeGreaterThanOrEqual(chain.items[i]!.score);
        }
    });

    it('maxCount 옵션으로 최대 항목 수를 제한할 수 있어야 한다', async () => {
        const db = createMockDb();
        // 많은 엣지 생성
        const manyEdges = Array.from({ length: 15 }, (_, i) => ({
            subjectId: 'order-service',
            objectId: `service-${i}`,
            relationType: 'call' as const,
            level: 'SERVICE_TO_SERVICE' as const,
            edgeWeight: i + 1,
            confidence: 0.8,
            provenance: { rollupId: `rollup-${i}`, baseRelationIds: [] },
        }));
        const manyNodes = [
            { id: 'order-service', type: 'service' as const, name: 'order-service', depth: 0 },
            ...Array.from({ length: 15 }, (_, i) => ({
                id: `service-${i}`,
                type: 'service' as const,
                name: `service-${i}`,
                depth: 1,
            })),
        ];
        const response = makeQueryResponse({ edges: manyEdges, nodes: manyNodes });
        const chain = await assembleEvidenceChain(db, response, { maxCount: 5 });

        expect(chain.items.length).toBeLessThanOrEqual(5);
        expect(chain.truncated).toBe(true);
        expect(chain.totalCount).toBeGreaterThan(5);
    });

    it('기본 maxCount는 10이어야 한다', async () => {
        const db = createMockDb();
        const manyEdges = Array.from({ length: 12 }, (_, i) => ({
            subjectId: 'order-service',
            objectId: `service-${i}`,
            relationType: 'call' as const,
            level: 'SERVICE_TO_SERVICE' as const,
            edgeWeight: 1,
            confidence: 0.8,
            provenance: { rollupId: `rollup-${i}`, baseRelationIds: [] },
        }));
        const manyNodes = [
            { id: 'order-service', type: 'service' as const, name: 'order-service', depth: 0 },
            ...Array.from({ length: 12 }, (_, i) => ({
                id: `service-${i}`,
                type: 'service' as const,
                name: `service-${i}`,
                depth: 1,
            })),
        ];
        const response = makeQueryResponse({ edges: manyEdges, nodes: manyNodes });
        const chain = await assembleEvidenceChain(db, response);

        expect(chain.items.length).toBeLessThanOrEqual(10);
        expect(chain.truncated).toBe(true);
    });

    it('minConfidence 옵션으로 낮은 신뢰도 항목을 제외해야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        // inventory-service 엣지는 confidence=0.70 → minConfidence=0.80이면 제외
        const chain = await assembleEvidenceChain(db, response, { minConfidence: 0.80 });

        expect(chain.items.every((item) => item.confidence >= 0.80)).toBe(true);
    });

    it('DB에서 조회한 evidence 파일 경로/라인/excerpt를 포함해야 한다', async () => {
        const evidenceRow = {
            id: 'ev-1',
            workspaceId: 'ws-1',
            evidenceType: 'FILE',
            filePath: 'src/OrderController.java',
            lineStart: 120,
            lineEnd: 145,
            excerpt: 'restTemplate.getForObject("http://payment-service/pay", String.class)',
            uri: null,
            metadata: {},
            createdAt: new Date(),
        };
        const db = createMockDb([evidenceRow]);
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        // rel-1을 baseRelationId로 가진 엣지 (payment-service) 항목 찾기
        const codeItem = chain.items.find(
            (i) => i.filePath === 'src/OrderController.java',
        );
        expect(codeItem).toBeDefined();
        expect(codeItem?.type).toBe('code');
        expect(codeItem?.lineStart).toBe(120);
        expect(codeItem?.lineEnd).toBe(145);
        expect(codeItem?.excerpt).toContain('restTemplate');
    });

    it('EvidenceItem의 sourceName/targetName이 nodes의 displayName을 사용해야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        const item = chain.items[0];
        expect(item).toBeDefined();
        // displayName이 있으면 displayName 사용
        expect(item?.sourceName === '주문 서비스' || item?.sourceName === 'order-service').toBe(true);
    });

    it('provenance.baseRelationIds가 비어있으면 rollup 타입 EvidenceItem을 생성해야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        // inventory-service 엣지는 baseRelationIds: [] → rollup 타입
        const rollupItem = chain.items.find(
            (i) => i.targetId === 'inventory-service',
        );
        if (rollupItem) {
            expect(rollupItem.type).toBe('rollup');
        }
    });

    it('totalCount와 truncated가 올바르게 설정되어야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        expect(chain.totalCount).toBeGreaterThanOrEqual(chain.items.length);
        expect(chain.truncated).toBe(chain.totalCount > chain.items.length);
    });

    it('PATH_DISCOVERY의 paths 정보를 사용해 hop을 계산해야 한다', async () => {
        const db = createMockDb();
        const response = makeQueryResponse({
            nodes: [
                { id: 'order-service', type: 'service', name: 'order-service' },
                { id: 'payment-service', type: 'service', name: 'payment-service' },
                { id: 'inventory-service', type: 'service', name: 'inventory-service' },
            ],
            edges: [
                {
                    subjectId: 'order-service',
                    objectId: 'payment-service',
                    relationType: 'call',
                    level: 'SERVICE_TO_SERVICE',
                    edgeWeight: 1,
                    confidence: 0.9,
                    provenance: { rollupId: 'r1', baseRelationIds: [] },
                },
                {
                    subjectId: 'payment-service',
                    objectId: 'inventory-service',
                    relationType: 'call',
                    level: 'SERVICE_TO_SERVICE',
                    edgeWeight: 1,
                    confidence: 0.8,
                    provenance: { rollupId: 'r2', baseRelationIds: [] },
                },
            ],
            paths: [
                { pathId: 'p1', nodeIds: ['order-service', 'payment-service', 'inventory-service'], score: 0.99 },
            ],
        });
        response.queryType = 'PATH_DISCOVERY';

        const chain = await assembleEvidenceChain(db, response);
        const hop0 = chain.items.find((i) => i.targetId === 'payment-service');
        const hop1 = chain.items.find((i) => i.targetId === 'inventory-service');
        expect(hop0?.hop).toBe(0);
        expect(hop1?.hop).toBe(1);
    });

    it('DB 조회 실패 시에도 롤업 evidence만으로 결과를 반환해야 한다', async () => {
        const db = createFailingMockDb();
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        expect(chain.items.length).toBeGreaterThan(0);
        expect(chain.items.every((item) => item.type === 'rollup')).toBe(true);
    });

    it('CONFIG/DB_SCHEMA evidenceType이 각각 config/db 타입으로 매핑되어야 한다', async () => {
        const evidenceRow = {
            id: 'ev-1',
            workspaceId: 'ws-1',
            evidenceType: 'CONFIG',
            filePath: null,
            lineStart: null,
            lineEnd: null,
            excerpt: 'spring.datasource.url=jdbc:mysql://db-host:3306/order_db',
            uri: 'jdbc:mysql://db-host:3306/order_db',
            metadata: {},
            createdAt: new Date(),
        };
        const db = createMockDb([evidenceRow]);
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        const configItem = chain.items.find((i) => i.type === 'config');
        expect(configItem).toBeDefined();
        expect(configItem?.uri).toContain('jdbc:mysql://');
    });

    it('DB_SCHEMA evidenceType은 db 타입으로 매핑되어야 한다', async () => {
        const evidenceRow = {
            id: 'ev-1',
            workspaceId: 'ws-1',
            evidenceType: 'DB_SCHEMA',
            filePath: null,
            lineStart: null,
            lineEnd: null,
            excerpt: 'FK: orders.customer_id -> customers.id',
            uri: null,
            metadata: {},
            createdAt: new Date(),
        };
        const db = createMockDb([evidenceRow]);
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        const dbItem = chain.items.find((i) => i.type === 'db');
        expect(dbItem).toBeDefined();
    });

    it('알 수 없는 evidenceType은 rollup 타입으로 매핑되어야 한다', async () => {
        const evidenceRow = {
            id: 'ev-unknown',
            workspaceId: 'ws-1',
            evidenceType: 'UNKNOWN_KIND',
            filePath: null,
            lineStart: null,
            lineEnd: null,
            excerpt: null,
            uri: null,
            metadata: {},
            createdAt: new Date(),
        };
        const db = createMockDb([evidenceRow]);
        const response = makeQueryResponse();
        const chain = await assembleEvidenceChain(db, response);

        const mapped = chain.items.find((i) => i.sourceId === 'order-service' && i.targetId === 'payment-service');
        expect(mapped?.type).toBe('rollup');
    });
});

// ─── formatEvidenceChain 테스트 ───────────────────────────────────────────────

describe('formatEvidenceChain', () => {
    function makeChain(items: EvidenceChain['items'], totalCount?: number): EvidenceChain {
        return {
            items,
            totalCount: totalCount ?? items.length,
            truncated: totalCount !== undefined && totalCount > items.length,
            queryType: 'IMPACT_ANALYSIS',
        };
    }

    it('빈 체인은 빈 문자열을 반환해야 한다', () => {
        const result = formatEvidenceChain(makeChain([]));
        expect(result).toBe('');
    });

    it('헤더에 queryType과 총 개수가 포함되어야 한다', () => {
        const chain = makeChain([
            {
                type: 'rollup',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                score: 6.37,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('IMPACT_ANALYSIS');
        expect(result).toContain('1개의 관계 증거');
    });

    it('파일 경로와 라인 번호가 포함되어야 한다', () => {
        const chain = makeChain([
            {
                type: 'code',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                filePath: 'src/OrderController.java',
                lineStart: 120,
                lineEnd: 145,
                score: 6.37,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('src/OrderController.java');
        expect(result).toContain('120-145');
    });

    it('excerpt가 120자 초과이면 잘려야 한다', () => {
        const longExcerpt = 'x'.repeat(200);
        const chain = makeChain([
            {
                type: 'code',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                excerpt: longExcerpt,
                score: 6.37,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('...');
        // excerpt 부분이 120자 + '...' 이내인지 확인
        const excerptMatch = result.match(/발췌: (.+)/);
        expect(excerptMatch?.[1]?.length).toBeLessThanOrEqual(124); // 120 + '...'
    });

    it('truncated인 경우 "상위 N개 표시" 문구가 포함되어야 한다', () => {
        const chain = makeChain(
            [
                {
                    type: 'rollup',
                    sourceId: 'a',
                    sourceName: 'order-service',
                    targetId: 'b',
                    targetName: 'payment-service',
                    relationType: 'call',
                    confidence: 0.91,
                    edgeWeight: 7,
                    hop: 0,
                    score: 6.37,
                },
            ],
            15, // totalCount > items.length → truncated
        );
        const result = formatEvidenceChain(chain);
        expect(result).toContain('상위');
        expect(result).toContain('15개');
    });

    it('confidence가 0.91이면 "0.91"로 포맷되어야 한다', () => {
        const chain = makeChain([
            {
                type: 'rollup',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                score: 6.37,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('0.91');
        expect(result).toContain('7');
    });

    it('hop > 0인 경우 홉 거리가 표시되어야 한다', () => {
        const chain = makeChain([
            {
                type: 'rollup',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 2,
                score: 2.12,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('홉 거리: 2');
    });

    it('hop = 0이면 홉 거리가 표시되지 않아야 한다', () => {
        const chain = makeChain([
            {
                type: 'rollup',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                score: 6.37,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).not.toContain('홉 거리');
    });

    it('복수 항목이 번호 매겨져야 한다', () => {
        const chain = makeChain([
            {
                type: 'rollup',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'payment-service',
                relationType: 'call',
                confidence: 0.91,
                edgeWeight: 7,
                hop: 0,
                score: 6.37,
            },
            {
                type: 'rollup',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'c',
                targetName: 'inventory-service',
                relationType: 'call',
                confidence: 0.75,
                edgeWeight: 3,
                hop: 1,
                score: 1.125,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('1. ');
        expect(result).toContain('2. ');
    });

    it('URI가 있는 항목은 URI 라인을 출력해야 한다', () => {
        const chain = makeChain([
            {
                type: 'config',
                sourceId: 'a',
                sourceName: 'order-service',
                targetId: 'b',
                targetName: 'mysql-db',
                relationType: 'read',
                confidence: 0.8,
                edgeWeight: 2,
                hop: 0,
                uri: 'jdbc:mysql://db-host:3306/order_db',
                score: 1.6,
            },
        ]);
        const result = formatEvidenceChain(chain);
        expect(result).toContain('URI: jdbc:mysql://db-host:3306/order_db');
    });
});
