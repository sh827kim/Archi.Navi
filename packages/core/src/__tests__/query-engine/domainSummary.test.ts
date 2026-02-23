/**
 * DOMAIN_SUMMARY 단위 테스트 (Phase 2, 2-4)
 * summarizeDomain 검증 — 결정론적 집계 로직
 */
import { describe, it, expect, vi } from 'vitest';
import { summarizeDomain } from '../../query-engine/domainSummary';
import type { DomainSummaryData } from '../../query-engine/domainSummary';

// ─── Mock DB 헬퍼 ─────────────────────────────────────────────────────────────

function makeChain(rows: unknown[]) {
    return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(rows),
    };
}

/** domainId 없는 케이스용 Mock (objects 1회 조회) */
function createMockDbAllDomains(domainRows: unknown[]) {
    const selectMock = vi.fn().mockReturnValueOnce(makeChain(domainRows));
    return { select: selectMock } as unknown as Parameters<typeof summarizeDomain>[0];
}

/** domainId + 멤버 있는 케이스 (6회 조회) */
function createMockDbWithMembers({
    domainRow,
    affinityRows = [],
    memberRows = [],
    candidateRows = [],
    relationRows = [],
    rollupRows = [],
}: {
    domainRow: unknown;
    affinityRows?: unknown[];
    memberRows?: unknown[];
    candidateRows?: unknown[];
    relationRows?: unknown[];
    rollupRows?: unknown[];
}) {
    const selectMock = vi.fn()
        .mockReturnValueOnce(makeChain([domainRow]))    // 1. objects (domain)
        .mockReturnValueOnce(makeChain(affinityRows))   // 2. object_domain_affinities
        .mockReturnValueOnce(makeChain(memberRows))     // 3. objects (members)
        .mockReturnValueOnce(makeChain(candidateRows))  // 4. domain_candidates
        .mockReturnValueOnce(makeChain(relationRows))   // 5. object_relations
        .mockReturnValueOnce(makeChain(rollupRows));    // 6. object_rollups

    return { select: selectMock } as unknown as Parameters<typeof summarizeDomain>[0];
}

/** domainId + 멤버 없는 케이스 (4회 조회 — 3,5번 건너뜀) */
function createMockDbNoMembers({
    domainRow,
    candidateRows = [],
    rollupRows = [],
}: {
    domainRow: unknown;
    candidateRows?: unknown[];
    rollupRows?: unknown[];
}) {
    const selectMock = vi.fn()
        .mockReturnValueOnce(makeChain([domainRow]))    // 1. objects (domain)
        .mockReturnValueOnce(makeChain([]))             // 2. object_domain_affinities (empty)
        .mockReturnValueOnce(makeChain(candidateRows))  // 3. domain_candidates
        .mockReturnValueOnce(makeChain(rollupRows));    // 4. object_rollups

    return { select: selectMock } as unknown as Parameters<typeof summarizeDomain>[0];
}

// ─── 테스트 픽스처 ─────────────────────────────────────────────────────────────

const DOMAIN_ROW = {
    id: 'domain-1',
    workspaceId: 'ws-1',
    objectType: 'domain',
    name: 'order-domain',
    displayName: '주문 도메인',
    parentId: null,
    path: '/order-domain',
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    urn: null,
    category: null,
    granularity: 'COMPOUND',
    description: null,
    validFrom: null,
    validTo: null,
};

const AFFINITY_ROWS = [
    { workspaceId: 'ws-1', objectId: 'svc-order', domainId: 'domain-1', affinity: 0.95, confidence: 0.9, source: 'APPROVED_INFERENCE', generationVersion: 1, createdAt: new Date(), updatedAt: new Date(), id: 'aff-1' },
    { workspaceId: 'ws-1', objectId: 'svc-payment', domainId: 'domain-1', affinity: 0.72, confidence: 0.8, source: 'APPROVED_INFERENCE', generationVersion: 1, createdAt: new Date(), updatedAt: new Date(), id: 'aff-2' },
    { workspaceId: 'ws-1', objectId: 'svc-inventory', domainId: 'domain-1', affinity: 0.60, confidence: 0.7, source: 'DISCOVERY', generationVersion: 1, createdAt: new Date(), updatedAt: new Date(), id: 'aff-3' },
];

const MEMBER_ROWS = [
    { id: 'svc-order', workspaceId: 'ws-1', objectType: 'service', name: 'order-service', displayName: '주문 서비스', parentId: null, path: '/order-service', depth: 0, visibility: 'VISIBLE', metadata: {}, createdAt: new Date(), updatedAt: new Date(), urn: null, category: 'COMPUTE', granularity: 'ATOMIC', description: null, validFrom: null, validTo: null },
    { id: 'svc-payment', workspaceId: 'ws-1', objectType: 'service', name: 'payment-service', displayName: '결제 서비스', parentId: null, path: '/payment-service', depth: 0, visibility: 'VISIBLE', metadata: {}, createdAt: new Date(), updatedAt: new Date(), urn: null, category: 'COMPUTE', granularity: 'ATOMIC', description: null, validFrom: null, validTo: null },
    { id: 'svc-inventory', workspaceId: 'ws-1', objectType: 'service', name: 'inventory-service', displayName: '재고 서비스', parentId: null, path: '/inventory-service', depth: 0, visibility: 'VISIBLE', metadata: {}, createdAt: new Date(), updatedAt: new Date(), urn: null, category: 'COMPUTE', granularity: 'ATOMIC', description: null, validFrom: null, validTo: null },
];

const CANDIDATE_ROWS = [
    { id: 'cand-1', workspaceId: 'ws-1', objectId: 'svc-order', primaryDomainId: 'domain-1', purity: 0.92, affinityMap: {}, secondaryDomainIds: [], signals: {}, status: 'APPROVED', runId: null, reviewedAt: null, reviewedBy: null, createdAt: new Date() },
    { id: 'cand-2', workspaceId: 'ws-1', objectId: 'svc-payment', primaryDomainId: 'domain-1', purity: 0.78, affinityMap: {}, secondaryDomainIds: [], signals: {}, status: 'APPROVED', runId: null, reviewedAt: null, reviewedBy: null, createdAt: new Date() },
];

const RELATION_ROWS = [
    { id: 'rel-1', workspaceId: 'ws-1', relationType: 'call', subjectObjectId: 'svc-order', objectId: 'svc-payment', isDerived: false, confidence: 0.9, status: 'APPROVED', source: 'INFERRED', metadata: {}, interactionKind: null, direction: null, validFrom: null, validTo: null, createdAt: new Date() },
    { id: 'rel-2', workspaceId: 'ws-1', relationType: 'call', subjectObjectId: 'svc-payment', objectId: 'svc-inventory', isDerived: false, confidence: 0.8, status: 'APPROVED', source: 'INFERRED', metadata: {}, interactionKind: null, direction: null, validFrom: null, validTo: null, createdAt: new Date() },
    // 외부 관계 (inventory → external)는 필터에서 제외됨
    { id: 'rel-3', workspaceId: 'ws-1', relationType: 'call', subjectObjectId: 'svc-inventory', objectId: 'svc-external', isDerived: false, confidence: 0.7, status: 'APPROVED', source: 'INFERRED', metadata: {}, interactionKind: null, direction: null, validFrom: null, validTo: null, createdAt: new Date() },
];

const ROLLUP_ROWS = [
    { id: 'rollup-1', workspaceId: 'ws-1', rollupLevel: 'DOMAIN_TO_DOMAIN', relationType: 'call', subjectObjectId: 'domain-1', objectId: 'domain-2', edgeWeight: 5, confidence: 0.88, generationVersion: 1, createdAt: new Date() },
];

// ─── summarizeDomain 테스트 ────────────────────────────────────────────────────

describe('summarizeDomain — 도메인 없이 호출 시 (전체 목록)', () => {
    it('domainId 미제공 시 도메인 목록을 반환해야 한다', async () => {
        const db = createMockDbAllDomains([DOMAIN_ROW]);
        const result = await summarizeDomain(db, 'ws-1', 1, {});

        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
        expect(result.summary).toHaveProperty('type', 'DOMAIN_LIST');
    });

    it('domainId 미제공, 도메인 없으면 빈 결과를 반환해야 한다', async () => {
        const db = createMockDbAllDomains([]);
        const result = await summarizeDomain(db, 'ws-1', 1, {});

        expect(result.nodes).toHaveLength(0);
        const summary = result.summary as Record<string, unknown>;
        expect(summary['domainCount']).toBe(0);
    });

    it('도메인 목록에 도메인 id와 name이 포함되어야 한다', async () => {
        const db = createMockDbAllDomains([DOMAIN_ROW]);
        const result = await summarizeDomain(db, 'ws-1', 1, {});

        const summary = result.summary as Record<string, unknown>;
        const domains = summary['domains'] as Array<Record<string, unknown>>;
        expect(domains[0]).toMatchObject({ id: 'domain-1', name: 'order-domain' });
    });
});

describe('summarizeDomain — 특정 도메인 요약', () => {
    it('존재하지 않는 domainId면 error를 포함한 빈 결과를 반환해야 한다', async () => {
        const db = createMockDbNoMembers({ domainRow: undefined });
        const selectMock = vi.fn().mockReturnValueOnce(makeChain([]));
        const emptyDb = { select: selectMock } as unknown as Parameters<typeof summarizeDomain>[0];

        const result = await summarizeDomain(emptyDb, 'ws-1', 1, { domainId: 'unknown' });
        const summary = result.summary as Record<string, unknown>;
        expect(summary['error']).toBeDefined();
    });

    it('멤버가 없는 도메인도 기본 요약을 반환해야 한다', async () => {
        const db = createMockDbNoMembers({ domainRow: DOMAIN_ROW });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.domainId).toBe('domain-1');
        expect(summary.memberCount).toBe(0);
        expect(summary.relationDensity).toBe(0);
    });

    it('멤버 수를 올바르게 계산해야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS,
            memberRows: MEMBER_ROWS,
            candidateRows: CANDIDATE_ROWS,
            relationRows: RELATION_ROWS,
            rollupRows: ROLLUP_ROWS,
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.memberCount).toBe(3);
    });

    it('Object type별 카운트가 올바르게 집계되어야 한다', async () => {
        const mixedMemberRows = [
            ...MEMBER_ROWS,
            { ...MEMBER_ROWS[0]!, id: 'tbl-1', objectType: 'db_table', name: 'orders_table' },
        ];
        const mixedAffinityRows = [
            ...AFFINITY_ROWS,
            { ...AFFINITY_ROWS[0]!, id: 'aff-4', objectId: 'tbl-1' },
        ];
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: mixedAffinityRows,
            memberRows: mixedMemberRows,
            candidateRows: [],
            relationRows: [],
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.membersByType['service']).toBe(3);
        expect(summary.membersByType['db_table']).toBe(1);
    });

    it('승인된 도메인 후보의 평균 purity를 계산해야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS,
            memberRows: MEMBER_ROWS,
            candidateRows: CANDIDATE_ROWS, // purity: 0.92, 0.78
            relationRows: [],
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        // avg(0.92, 0.78) = 0.85
        expect(summary.avgPurity).toBeCloseTo(0.85, 2);
    });

    it('도메인 후보가 없으면 avgPurity가 null이어야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS,
            memberRows: MEMBER_ROWS,
            candidateRows: [],
            relationRows: [],
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.avgPurity).toBeNull();
    });

    it('평균 affinity를 올바르게 계산해야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS, // 0.95, 0.72, 0.60
            memberRows: MEMBER_ROWS,
            candidateRows: [],
            relationRows: [],
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        // avg(0.95, 0.72, 0.60) ≈ 0.7567
        expect(summary.avgAffinity).toBeCloseTo((0.95 + 0.72 + 0.60) / 3, 3);
    });

    it('상위 멤버를 affinity 내림차순으로 최대 5개 반환해야 한다', async () => {
        // 6개 멤버로 테스트 (5개로 잘려야 함)
        const manyAffinities = Array.from({ length: 6 }, (_, i) => ({
            ...AFFINITY_ROWS[0]!,
            id: `aff-${i}`,
            objectId: `svc-${i}`,
            affinity: 1.0 - i * 0.1,
        }));
        const manyMembers = Array.from({ length: 6 }, (_, i) => ({
            ...MEMBER_ROWS[0]!,
            id: `svc-${i}`,
            name: `service-${i}`,
        }));
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: manyAffinities,
            memberRows: manyMembers,
            candidateRows: [],
            relationRows: [],
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.topMembers.length).toBeLessThanOrEqual(5);
        // 첫 번째 멤버의 affinity가 가장 높아야 함
        expect(summary.topMembers[0]!.affinity).toBeGreaterThanOrEqual(summary.topMembers[1]!.affinity);
    });

    it('intra-domain 관계만 밀도 계산에 포함되어야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS, // 3 members
            memberRows: MEMBER_ROWS,
            candidateRows: [],
            relationRows: RELATION_ROWS, // rel-1: order→payment, rel-2: payment→inventory, rel-3: inventory→external(제외)
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        // max_possible = 3 * (3-1) = 6, intra = 2
        expect(summary.relationDensity).toBeCloseTo(2 / 6, 3);
    });

    it('외부 의존 도메인이 externalDependencies에 포함되어야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS,
            memberRows: MEMBER_ROWS,
            candidateRows: [],
            relationRows: [],
            rollupRows: ROLLUP_ROWS,
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.externalDependencies).toHaveLength(1);
        expect(summary.externalDependencies[0]).toMatchObject({
            domainId: 'domain-2',
            relationType: 'call',
            edgeWeight: 5,
        });
    });

    it('result.nodes에 멤버 Objects가 포함되어야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS,
            memberRows: MEMBER_ROWS,
            candidateRows: [],
            relationRows: [],
            rollupRows: [],
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        expect(result.nodes).toHaveLength(3);
        expect(result.nodes.map((n) => n.id)).toContain('svc-order');
    });

    it('result.edges에 외부 DOMAIN_TO_DOMAIN 엣지가 포함되어야 한다', async () => {
        const db = createMockDbWithMembers({
            domainRow: DOMAIN_ROW,
            affinityRows: AFFINITY_ROWS,
            memberRows: MEMBER_ROWS,
            candidateRows: [],
            relationRows: [],
            rollupRows: ROLLUP_ROWS,
        });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        expect(result.edges).toHaveLength(1);
        expect(result.edges[0]).toMatchObject({
            subjectId: 'domain-1',
            objectId: 'domain-2',
            level: 'DOMAIN_TO_DOMAIN',
        });
    });

    it('domainName은 displayName을 우선 사용해야 한다', async () => {
        const db = createMockDbNoMembers({ domainRow: DOMAIN_ROW });
        const result = await summarizeDomain(db, 'ws-1', 1, { domainId: 'domain-1' });

        const summary = result.summary as unknown as DomainSummaryData;
        expect(summary.domainName).toBe('주문 도메인'); // displayName 우선
    });
});
