/**
 * Message 시그널 추출 통합 테스트
 * PGlite 인메모리 DB로 토픽 네이밍 패턴 분석 및 msgScore 계산 검증
 *
 * 설계 참조: docs/03-inference-engine.md §3.3 Message Signals
 * 로드맵: 2-5 Message 시그널 추출
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
    objects,
    workspaces,
    objectRelations,
    relationCandidates,
    domainCandidates,
} from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { extractTopicPrefix, computeMsgScores } from '@/domain/msgSignal';
import { runSeedBasedInference } from '@/domain/seedBased';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
    const db = createPgliteClient();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000030';

async function setupWorkspace(db: TestDb) {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
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

/** domain object 생성 헬퍼 */
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

/** topic object 생성 헬퍼 */
async function createTopic(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'topic',
        granularity: 'ATOMIC',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** 승인된 produce 관계 생성 헬퍼 */
async function createApprovedRelation(
    db: TestDb,
    serviceId: string,
    topicId: string,
    relationType: 'produce' | 'consume',
) {
    await db.insert(objectRelations).values({
        id: generateId(),
        workspaceId,
        relationType,
        subjectObjectId: serviceId,
        objectId: topicId,
        status: 'APPROVED',
        source: 'INFERRED',
        isDerived: false,
    });
}

/** 대기 중인 produce 후보 생성 헬퍼 */
async function createPendingRelation(
    db: TestDb,
    serviceId: string,
    topicId: string,
    relationType: 'produce' | 'consume',
) {
    await db.insert(relationCandidates).values({
        id: generateId(),
        workspaceId,
        relationType,
        subjectObjectId: serviceId,
        objectId: topicId,
        confidence: 0.85,
        status: 'PENDING',
        metadata: {},
    });
}

// ─── extractTopicPrefix 단위 테스트 ──────────────────────────────────────────

describe('extractTopicPrefix', () => {
    it('점(.) 구분자: order.created → order를 반환해야 한다', () => {
        expect(extractTopicPrefix('order.created')).toBe('order');
        expect(extractTopicPrefix('payment.completed')).toBe('payment');
        expect(extractTopicPrefix('user.registered')).toBe('user');
    });

    it('하이픈(-) 구분자: order-created → order를 반환해야 한다', () => {
        expect(extractTopicPrefix('order-created')).toBe('order');
        expect(extractTopicPrefix('payment-failed')).toBe('payment');
    });

    it('언더스코어(_) 구분자: order_created → order를 반환해야 한다', () => {
        expect(extractTopicPrefix('order_created')).toBe('order');
        expect(extractTopicPrefix('inventory_updated')).toBe('inventory');
    });

    it('구분자 우선순위: 점 > 하이픈 > 언더스코어', () => {
        // 점이 있으면 점을 기준으로
        expect(extractTopicPrefix('order.item-created')).toBe('order');
    });

    it('구분자 없으면 전체 이름을 반환해야 한다', () => {
        expect(extractTopicPrefix('orders')).toBe('orders');
        expect(extractTopicPrefix('payments')).toBe('payments');
    });

    it('중첩 구분자: 첫 번째 구분자 기준으로만 분리', () => {
        expect(extractTopicPrefix('order.item.created')).toBe('order');
        expect(extractTopicPrefix('payment.retry.failed')).toBe('payment');
    });
});

// ─── computeMsgScores 통합 테스트 ────────────────────────────────────────────

describe('computeMsgScores', () => {
    let db: TestDb;
    const orderDomain = { id: generateId(), name: 'order' };
    const paymentDomain = { id: generateId(), name: 'payment' };
    const domains = [orderDomain, paymentDomain];

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    it('T1: produce/consume 관계가 없으면 빈 결과를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        expect(result).toEqual({});
    });

    it('T2: 승인된 produce 관계 — 토픽 prefix 매칭 시 도메인 score를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const topicId = await createTopic(db, 'order.created');
        await createApprovedRelation(db, serviceId, topicId, 'produce');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        expect(result[orderDomain.id]).toBeGreaterThan(0);
        expect(result[paymentDomain.id]).toBeUndefined();
    });

    it('T3: 대기 중인 consume 후보 — 토픽 prefix 매칭 시 도메인 score를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'notification-service');
        const topicId = await createTopic(db, 'payment.completed');
        await createPendingRelation(db, serviceId, topicId, 'consume');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        expect(result[paymentDomain.id]).toBeGreaterThan(0);
        expect(result[orderDomain.id]).toBeUndefined();
    });

    it('T4: 여러 토픽 접근 시 도메인별 score가 합산되어야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const topic1 = await createTopic(db, 'order.created');
        const topic2 = await createTopic(db, 'order.updated');
        const topic3 = await createTopic(db, 'payment.completed');
        await createApprovedRelation(db, serviceId, topic1, 'produce');
        await createApprovedRelation(db, serviceId, topic2, 'produce');
        await createApprovedRelation(db, serviceId, topic3, 'consume');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        // order 토픽 2개 = score 2
        expect(result[orderDomain.id]).toBe(2);
        // payment 토픽 1개 = score 1
        expect(result[paymentDomain.id]).toBe(1);
    });

    it('T5: produce + consume 양방향 참여 시 결합도 가산점(+0.5)이 부여되어야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const produceTopic = await createTopic(db, 'order.created');
        const consumeTopic = await createTopic(db, 'order.payment-confirmed');
        await createApprovedRelation(db, serviceId, produceTopic, 'produce');
        await createApprovedRelation(db, serviceId, consumeTopic, 'consume');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        // 토픽 2개(+1 each) + coupling 가산점(+0.5) = 2.5
        expect(result[orderDomain.id]).toBeCloseTo(2.5, 5);
    });

    it('T6: 단방향(produce만)이면 결합도 가산점이 없어야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const topicId = await createTopic(db, 'order.created');
        await createApprovedRelation(db, serviceId, topicId, 'produce');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        // 토픽 1개(+1), 단방향이므로 가산점 없음
        expect(result[orderDomain.id]).toBeCloseTo(1.0, 5);
    });

    it('T7: 토픽 prefix가 도메인과 매칭되지 않으면 score가 없어야 한다', async () => {
        const serviceId = await createService(db, 'inventory-service');
        const topicId = await createTopic(db, 'inventory.updated'); // inventory는 도메인 목록에 없음
        await createApprovedRelation(db, serviceId, topicId, 'produce');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        expect(Object.keys(result)).toHaveLength(0);
    });

    it('T8: 승인된 관계 + 대기 중인 후보를 모두 포함해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const approvedTopic = await createTopic(db, 'order.created');
        const pendingTopic = await createTopic(db, 'order.cancelled');
        await createApprovedRelation(db, serviceId, approvedTopic, 'produce');
        await createPendingRelation(db, serviceId, pendingTopic, 'consume');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        // approved(1) + pending(1) + coupling bonus(0.5) = 2.5
        expect(result[orderDomain.id]).toBeCloseTo(2.5, 5);
    });

    it('T9: 도메인 목록이 비어있으면 빈 결과를 반환해야 한다', async () => {
        const serviceId = await createService(db, 'order-service');
        const topicId = await createTopic(db, 'order.created');
        await createApprovedRelation(db, serviceId, topicId, 'produce');

        const result = await computeMsgScores(db, serviceId, [], workspaceId);
        expect(result).toEqual({});
    });

    it('T10: 하이픈 구분자 토픽도 도메인 매칭이 동작해야 한다', async () => {
        const serviceId = await createService(db, 'payment-service');
        const topicId = await createTopic(db, 'payment-completed');
        await createApprovedRelation(db, serviceId, topicId, 'produce');

        const result = await computeMsgScores(db, serviceId, domains, workspaceId);
        expect(result[paymentDomain.id]).toBeGreaterThan(0);
    });
});

// ─── seedBased 통합: msgScore 반영 확인 ──────────────────────────────────────

describe('seedBased msgScore 통합', () => {
    let db: TestDb;

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    it('T11: 토픽 관계가 있을 때 signals.msg가 domain_candidates에 저장되어야 한다', async () => {
        const domainId = await createDomain(db, 'order');
        // 이름 매칭이 없는 서비스 (code 신호 없음)
        const serviceId = await createService(db, 'notification-service');
        const topicId = await createTopic(db, 'order.created');
        await createApprovedRelation(db, serviceId, topicId, 'consume');

        await runSeedBasedInference(db, { workspaceId });

        const candidates = await db
            .select()
            .from(domainCandidates)
            .where(eq(domainCandidates.workspaceId, workspaceId));

        expect(candidates.length).toBeGreaterThanOrEqual(1);
        const candidate = candidates.find((c) => c.objectId === serviceId);
        expect(candidate).toBeDefined();

        // signals.msg가 저장되어 있어야 함
        const signals = candidate!.signals as Record<string, unknown>;
        expect(signals['msg']).toBeDefined();

        // order 도메인에 msg score가 있어야 함
        const msgMap = signals['msg'] as Record<string, number>;
        expect(msgMap[domainId]).toBeGreaterThan(0);
    });

    it('T12: msg 신호만으로 domain_candidates가 생성되어야 한다', async () => {
        await createDomain(db, 'payment');
        const serviceId = await createService(db, 'analytics-service'); // 이름 매칭 없음
        const topicId = await createTopic(db, 'payment.completed');
        await createApprovedRelation(db, serviceId, topicId, 'consume');

        const result = await runSeedBasedInference(db, { workspaceId });
        // msg 신호만으로도 candidateCount가 1 이상
        expect(result.candidateCount).toBeGreaterThanOrEqual(1);
    });
});
