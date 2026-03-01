/**
 * DB 스키마 신호 추출 통합 테스트
 * PGlite 인메모리 DB로 FK/컬럼 패턴 추출 및 dbScore 계산 검증
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
    objects,
    workspaces,
    relationCandidates,
    relationCandidateEvidences,
    codeArtifacts,
    codeCallEdges,
    evidences,
} from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { extractDbSchemaSignals, computeDbScores, extractTablePrefix, matchDomainByPrefix } from '../../db/dbSchemaSignal.js';
import { runSeedBasedInference } from '../../domain/seedBased.js';
import { domainCandidates } from '@archi-navi/db';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
    const db = createPgliteClient();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000010';

/** 테스트용 워크스페이스 생성 */
async function setupWorkspace(db: TestDb) {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
}

/** db_table object 생성 헬퍼 */
async function createDbTable(
    db: TestDb,
    name: string,
    metadata: Record<string, unknown> = {},
): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'db_table',
        granularity: 'ATOMIC',
        name,
        path: `/${id}`,
        depth: 0,
        metadata,
    });
    return id;
}

/** service object 생성 헬퍼 */
async function createService(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** 도메인 object 생성 헬퍼 */
async function createDomain(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'domain',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

// ─── 내부 헬퍼 단위 테스트 ────────────────────────────────────────────────────

describe('extractTablePrefix', () => {
    it('언더스코어가 있으면 첫 번째 세그먼트를 반환해야 한다', () => {
        expect(extractTablePrefix('order_items')).toBe('order');
        expect(extractTablePrefix('payment_methods')).toBe('payment');
        expect(extractTablePrefix('user_profiles')).toBe('user');
    });

    it('언더스코어가 없으면 전체 이름을 반환해야 한다', () => {
        expect(extractTablePrefix('users')).toBe('users');
        expect(extractTablePrefix('orders')).toBe('orders');
    });
});

describe('matchDomainByPrefix', () => {
    const domains = [
        { id: 'domain-order', name: 'order' },
        { id: 'domain-payment', name: 'payment' },
        { id: 'domain-user', name: 'user' },
    ];

    it('정확 매칭이 있으면 해당 domainId를 반환해야 한다', () => {
        expect(matchDomainByPrefix('order', domains)).toBe('domain-order');
        expect(matchDomainByPrefix('ORDER', domains)).toBe('domain-order'); // 대소문자 무시
    });

    it('매칭 실패 시 null을 반환해야 한다', () => {
        expect(matchDomainByPrefix('inventory', domains)).toBeNull();
    });
});

// ─── extractDbSchemaSignals 통합 테스트 ──────────────────────────────────────

describe('extractDbSchemaSignals', () => {
    let db: TestDb;

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    it('db_table이 없으면 빈 결과를 반환해야 한다', async () => {
        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result).toEqual({ tableCount: 0, fkCandidateCount: 0, implicitFkCandidateCount: 0 });
    });

    it('FK 제약조건에서 relation_candidate를 생성해야 한다 (confidence 0.95)', async () => {
        const ordersId = await createDbTable(db, 'orders', { columns: [], fk_constraints: [] });
        await createDbTable(db, 'order_items', {
            columns: [],
            fk_constraints: [
                { column: 'order_id', references_table: 'orders', references_column: 'id' },
            ],
        });

        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result.tableCount).toBe(2);
        expect(result.fkCandidateCount).toBe(1);

        const candidates = await db
            .select()
            .from(relationCandidates)
            .where(eq(relationCandidates.workspaceId, workspaceId));
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.relationType).toBe('fk_reference');
        expect(candidates[0]!.confidence).toBeCloseTo(0.95);
        expect(candidates[0]!.objectId).toBe(ordersId);
        expect(candidates[0]!.status).toBe('PENDING');

        const candidateLinks = await db
            .select()
            .from(relationCandidateEvidences)
            .where(eq(relationCandidateEvidences.candidateId, candidates[0]!.id));
        expect(candidateLinks).toHaveLength(1);

        const evidenceRows = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));
        expect(evidenceRows).toHaveLength(1);
        expect(evidenceRows[0]!.evidenceType).toBe('SCHEMA');
        expect((evidenceRows[0]!.metadata as Record<string, unknown>)['kind']).toBe('db_schema_fk');
    });

    it('동일 FK를 두 번 실행해도 relation_candidate가 중복 생성되지 않아야 한다', async () => {
        await createDbTable(db, 'orders', { columns: [], fk_constraints: [] });
        await createDbTable(db, 'order_items', {
            columns: [],
            fk_constraints: [
                { column: 'order_id', references_table: 'orders', references_column: 'id' },
            ],
        });

        await extractDbSchemaSignals(db, { workspaceId });
        await extractDbSchemaSignals(db, { workspaceId }); // 두 번 실행

        const candidates = await db
            .select()
            .from(relationCandidates)
            .where(eq(relationCandidates.workspaceId, workspaceId));
        expect(candidates).toHaveLength(1); // 중복 없음

        const candidateLinks = await db
            .select()
            .from(relationCandidateEvidences)
            .where(eq(relationCandidateEvidences.workspaceId, workspaceId));
        expect(candidateLinks).toHaveLength(1); // candidate와 함께 1회만 생성

        const evidenceRows = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));
        expect(evidenceRows).toHaveLength(1); // 중복 생성되지 않음
    });

    it('컬럼명 *_id 패턴에서 implicit FK를 생성해야 한다 (confidence 0.5)', async () => {
        const ordersId = await createDbTable(db, 'orders', { columns: [], fk_constraints: [] });
        await createDbTable(db, 'order_items', {
            columns: [
                { name: 'id', type: 'bigint' },
                { name: 'order_id', type: 'bigint' },  // implicit FK → orders
            ],
            fk_constraints: [],
        });

        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result.implicitFkCandidateCount).toBe(1);

        const candidates = await db
            .select()
            .from(relationCandidates)
            .where(eq(relationCandidates.workspaceId, workspaceId));
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.confidence).toBeCloseTo(0.5);
        expect(candidates[0]!.objectId).toBe(ordersId);

        const evidenceRows = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));
        expect(evidenceRows).toHaveLength(1);
        expect((evidenceRows[0]!.metadata as Record<string, unknown>)['kind']).toBe('db_schema_implicit_fk');
    });

    it('컬럼명 *_no 패턴에서 implicit FK를 생성해야 한다', async () => {
        const itemsId = await createDbTable(db, 'items', { columns: [], fk_constraints: [] });
        await createDbTable(db, 'order_items', {
            columns: [{ name: 'item_no', type: 'bigint' }],
            fk_constraints: [],
        });

        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result.implicitFkCandidateCount).toBe(1);

        const candidates = await db.select().from(relationCandidates);
        expect(candidates[0]!.objectId).toBe(itemsId);
    });

    it('제외 패턴 컬럼(created_by, updated_by)은 implicit FK를 생성하지 않아야 한다', async () => {
        await createDbTable(db, 'orders', { columns: [], fk_constraints: [] });
        await createDbTable(db, 'order_items', {
            columns: [
                { name: 'created_by', type: 'varchar' },
                { name: 'updated_by', type: 'varchar' },
                { name: 'deleted_by', type: 'varchar' },
                { name: 'created_at', type: 'timestamp' },
                { name: 'updated_at', type: 'timestamp' },
                { name: 'deleted_at', type: 'timestamp' },
            ],
            fk_constraints: [],
        });

        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result.fkCandidateCount).toBe(0);
        expect(result.implicitFkCandidateCount).toBe(0);
    });

    it('FK + 컬럼패턴 혼합 시 FK 처리된 관계는 컬럼패턴에서 중복 생성하지 않아야 한다', async () => {
        await createDbTable(db, 'orders', { columns: [], fk_constraints: [] });
        await createDbTable(db, 'order_items', {
            columns: [{ name: 'order_id', type: 'bigint' }],   // FK와 동일 대상
            fk_constraints: [
                { column: 'order_id', references_table: 'orders', references_column: 'id' },
            ],
        });

        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result.fkCandidateCount).toBe(1);
        expect(result.implicitFkCandidateCount).toBe(0); // 중복 스킵

        const candidates = await db.select().from(relationCandidates);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.confidence).toBeCloseTo(0.95); // FK 신뢰도 유지
    });

    it('참조 대상 테이블이 존재하지 않으면 relation_candidate를 생성하지 않아야 한다', async () => {
        await createDbTable(db, 'order_items', {
            columns: [],
            fk_constraints: [
                { column: 'order_id', references_table: 'non_existent', references_column: 'id' },
            ],
        });

        const result = await extractDbSchemaSignals(db, { workspaceId });
        expect(result.fkCandidateCount).toBe(0);

        const candidates = await db.select().from(relationCandidates);
        expect(candidates).toHaveLength(0);
        const evidenceRows = await db.select().from(evidences);
        expect(evidenceRows).toHaveLength(0);
    });
});

// ─── computeDbScores 통합 테스트 ─────────────────────────────────────────────

describe('computeDbScores', () => {
    let db: TestDb;
    const orderDomain = { id: generateId(), name: 'order' };
    const paymentDomain = { id: generateId(), name: 'payment' };
    const domains = [orderDomain, paymentDomain];

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    /** service → artifact → call_edge + evidence 생성 헬퍼 */
    async function createDbSignal(
        serviceId: string,
        tableName: string,
        kind: 'db_read' | 'db_write' | 'db_mapping',
    ) {
        const artifactId = generateId();
        await db.insert(codeArtifacts).values({
            id: artifactId,
            workspaceId,
            language: 'java',
            filePath: `/service/${tableName}.java`,
            ownerObjectId: serviceId,
            sha256: generateId(),
        });

        const evidenceId = generateId();
        await db.insert(evidences).values({
            id: evidenceId,
            workspaceId,
            evidenceType: 'FILE',
            filePath: `/service/${tableName}.java`,
            lineStart: 10,
            lineEnd: 10,
            excerpt: `FROM ${tableName}`,
            metadata: { kind, confidence: 0.8, language: 'java' },
        });

        await db.insert(codeCallEdges).values({
            id: generateId(),
            workspaceId,
            callerArtifactId: artifactId,
            calleeSymbol: tableName,
            weight: 1,
            evidenceId,
        });
    }

    it('code_artifacts가 없으면 빈 결과를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const result = await computeDbScores(db, serviceId, domains, workspaceId);
        expect(result).toEqual({});
    });

    it('db_read calleeSymbol order_items → prefix order → order 도메인 score를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        await createDbSignal(serviceId, 'order_items', 'db_read');

        const result = await computeDbScores(db, serviceId, domains, workspaceId);
        expect(result[orderDomain.id]).toBeGreaterThan(0);
        expect(result[paymentDomain.id]).toBeUndefined();
    });

    it('db_write calleeSymbol payment_history → prefix payment → payment 도메인 score를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'payment-service');
        await createDbSignal(serviceId, 'payment_history', 'db_write');

        const result = await computeDbScores(db, serviceId, domains, workspaceId);
        expect(result[paymentDomain.id]).toBeGreaterThan(0);
        expect(result[orderDomain.id]).toBeUndefined();
    });

    it('db_mapping calleeSymbol orders → order 도메인 score를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        await createDbSignal(serviceId, 'orders', 'db_mapping');

        const result = await computeDbScores(db, serviceId, domains, workspaceId);
        // 'orders' prefix = 'orders' → 부분 매칭으로 order 도메인과 매칭
        expect(result[orderDomain.id]).toBeGreaterThan(0);
    });

    it('prefix 매칭 실패 시 해당 도메인 score가 없어야 한다', async () => {
        const serviceId = await createService(db, 'inventory-service');
        await createDbSignal(serviceId, 'inventory_items', 'db_read'); // prefix=inventory, 매칭 안됨

        const result = await computeDbScores(db, serviceId, domains, workspaceId);
        expect(result[orderDomain.id]).toBeUndefined();
        expect(result[paymentDomain.id]).toBeUndefined();
    });

    it('여러 테이블 접근 시 도메인별 score가 합산 후 정규화되어야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        await createDbSignal(serviceId, 'order_items', 'db_read');
        await createDbSignal(serviceId, 'order_payments', 'db_write');
        await createDbSignal(serviceId, 'orders', 'db_mapping');

        const result = await computeDbScores(db, serviceId, domains, workspaceId);
        // 정규화 후 0~1 범위, 최대 score를 가진 도메인은 1.0
        expect(result[orderDomain.id]).toBeGreaterThan(0);
        expect(result[orderDomain.id]).toBeLessThanOrEqual(1);
    });
});

// ─── seedBased.ts 통합: dbScore 반영 확인 ────────────────────────────────────

describe('seedBased dbScore 통합', () => {
    let db: TestDb;

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    it('db_table 없을 때 runSeedBasedInference가 정상 동작해야 한다', async () => {
        await createDomain(db, 'order');
        await createService(db, 'order-service');

        // db_table 없어도 에러 없이 candidateCount 반환
        const result = await runSeedBasedInference(db, { workspaceId });
        expect(result.candidateCount).toBeGreaterThanOrEqual(0);
    });

    it('dbScore가 domain_candidates의 signals.db에 저장되어야 한다', async () => {

        const domainId = await createDomain(db, 'order');
        const serviceId = await createService(db, 'other-service'); // 이름 매칭 없는 서비스

        // db 신호 생성 (order_items → order 도메인 매칭)
        const artifactId = generateId();
        await db.insert(codeArtifacts).values({
            id: artifactId,
            workspaceId,
            language: 'java',
            filePath: '/src/Repo.java',
            ownerObjectId: serviceId,
            sha256: generateId(),
        });
        const evidenceId = generateId();
        await db.insert(evidences).values({
            id: evidenceId,
            workspaceId,
            evidenceType: 'FILE',
            filePath: '/src/Repo.java',
            lineStart: 5,
            lineEnd: 5,
            excerpt: 'FROM order_items',
            metadata: { kind: 'db_read', confidence: 0.8, language: 'java' },
        });
        await db.insert(codeCallEdges).values({
            id: generateId(),
            workspaceId,
            callerArtifactId: artifactId,
            calleeSymbol: 'order_items',
            weight: 1,
            evidenceId,
        });

        await runSeedBasedInference(db, { workspaceId });

        const candidates = await db
            .select()
            .from(domainCandidates)
            .where(eq(domainCandidates.workspaceId, workspaceId));

        expect(candidates.length).toBeGreaterThanOrEqual(1);
        const candidate = candidates[0]!;
        // signals.db가 저장되어 있어야 함
        const signals = candidate.signals as Record<string, unknown>;
        expect(signals['db']).toBeDefined();
    });
});
