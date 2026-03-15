/**
 * Rollup Builder 테스트용 데이터 팩토리
 * 서비스, 엔드포인트, 테이블, 토픽 등 오브젝트와 관계를 생성한다.
 */
import { randomUUID } from 'crypto';

const WS_ID = '00000000-0000-0000-0000-000000000001';

/** UUID 팩토리 (테스트 가독성용 짧은 접미사) */
export function id(suffix: string): string {
    return `00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
}

/** 기본 워크스페이스 ID */
export const WORKSPACE_ID = WS_ID;

/** object 팩토리 */
export function makeObject(overrides: {
    id: string;
    objectType: string;
    name: string;
    parentId?: string | null;
}) {
    return {
        id: overrides.id,
        workspaceId: WS_ID,
        objectType: overrides.objectType,
        category: overrides.objectType === 'service' ? 'COMPUTE'
            : overrides.objectType === 'api_endpoint' ? 'COMPUTE'
            : overrides.objectType === 'database' || overrides.objectType === 'db_table' ? 'STORAGE'
            : overrides.objectType === 'message_broker' || overrides.objectType === 'topic' ? 'CHANNEL'
            : 'META',
        granularity: ['service', 'database', 'message_broker'].includes(overrides.objectType) ? 'COMPOUND' : 'ATOMIC',
        name: overrides.name,
        displayName: overrides.name,
        description: null,
        urn: null,
        parentId: overrides.parentId ?? null,
        path: overrides.name,
        depth: 0,
        visibility: 'VISIBLE' as const,
        metadata: {},
        validFrom: null,
        validTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

/** relation 팩토리 */
export function makeRelation(overrides: {
    id?: string;
    relationType: string;
    subjectObjectId: string;
    objectId: string;
    confidence?: number | null;
    isDerived?: boolean;
}) {
    return {
        id: overrides.id ?? randomUUID(),
        workspaceId: WS_ID,
        relationType: overrides.relationType,
        subjectObjectId: overrides.subjectObjectId,
        objectId: overrides.objectId,
        interactionKind: null,
        direction: null,
        isDerived: overrides.isDerived ?? false,
        confidence: overrides.confidence ?? null,
        status: 'APPROVED' as const,
        metadata: {},
        source: 'MANUAL' as const,
        validFrom: null,
        validTo: null,
        createdAt: new Date(),
    };
}

/** affinity 팩토리 */
export function makeAffinity(overrides: {
    objectId: string;
    domainId: string;
    affinity: number;
}) {
    return {
        id: randomUUID(),
        workspaceId: WS_ID,
        objectId: overrides.objectId,
        domainId: overrides.domainId,
        affinity: overrides.affinity,
        confidence: null,
        source: 'MANUAL' as const,
        generationVersion: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

/** rollup 팩토리 */
export function makeRollup(overrides: {
    rollupLevel: string;
    relationType: string;
    subjectObjectId: string;
    objectId: string;
    edgeWeight: number;
    confidence?: number | null;
    generationVersion: number;
}) {
    return {
        id: randomUUID(),
        workspaceId: WS_ID,
        rollupLevel: overrides.rollupLevel,
        relationType: overrides.relationType,
        subjectObjectId: overrides.subjectObjectId,
        objectId: overrides.objectId,
        edgeWeight: overrides.edgeWeight,
        confidence: overrides.confidence ?? null,
        generationVersion: overrides.generationVersion,
        createdAt: new Date(),
    };
}

/** generation 팩토리 */
export function makeGeneration(overrides: {
    generationVersion: number;
    status: 'BUILDING' | 'ACTIVE' | 'ARCHIVED';
}) {
    return {
        workspaceId: WS_ID,
        generationVersion: overrides.generationVersion,
        builtAt: new Date(),
        status: overrides.status,
        meta: {},
    };
}

/**
 * 표준 테스트 시나리오: 2개 서비스 + 2개 엔드포인트 + 1개 DB + 1개 테이블 + 1개 브로커 + 1개 토픽
 *
 * svcA --call--> epB1 (svcB --expose--> epB1)
 * svcA --call--> epB2 (svcB --expose--> epB2)
 * svcA --read--> tableX (tableX.parent = dbX)
 * svcB --write--> tableX
 * svcA --produce--> topicP (topicP.parent = brokerM)
 * svcB --consume--> topicP
 */
export function createStandardScenario() {
    // 서비스
    const svcA = makeObject({ id: id('svc-a'), objectType: 'service', name: 'order-service' });
    const svcB = makeObject({ id: id('svc-b'), objectType: 'service', name: 'payment-service' });

    // 엔드포인트
    const epB1 = makeObject({ id: id('ep-b1'), objectType: 'api_endpoint', name: 'POST /api/payment', parentId: svcB.id });
    const epB2 = makeObject({ id: id('ep-b2'), objectType: 'api_endpoint', name: 'GET /api/payment/status', parentId: svcB.id });

    // DB & 테이블
    const dbX = makeObject({ id: id('db-x'), objectType: 'database', name: 'payment-db' });
    const tableX = makeObject({ id: id('tbl-x'), objectType: 'db_table', name: 'orders', parentId: dbX.id });

    // 브로커 & 토픽
    const brokerM = makeObject({ id: id('brk-m'), objectType: 'message_broker', name: 'kafka-main' });
    const topicP = makeObject({ id: id('topic-p'), objectType: 'topic', name: 'order-events', parentId: brokerM.id });

    // 도메인
    const domOrder = makeObject({ id: id('dom-ord'), objectType: 'domain', name: 'Order' });
    const domPayment = makeObject({ id: id('dom-pay'), objectType: 'domain', name: 'Payment' });

    const objects = [svcA, svcB, epB1, epB2, dbX, tableX, brokerM, topicP, domOrder, domPayment];

    // 관계
    const relations = [
        // svcA --call--> epB1, epB2
        makeRelation({ id: id('rel-call1'), relationType: 'call', subjectObjectId: svcA.id, objectId: epB1.id, confidence: 0.9 }),
        makeRelation({ id: id('rel-call2'), relationType: 'call', subjectObjectId: svcA.id, objectId: epB2.id, confidence: 0.8 }),
        // svcB --expose--> epB1, epB2
        makeRelation({ id: id('rel-exp1'), relationType: 'expose', subjectObjectId: svcB.id, objectId: epB1.id }),
        makeRelation({ id: id('rel-exp2'), relationType: 'expose', subjectObjectId: svcB.id, objectId: epB2.id }),
        // svcA --read--> tableX
        makeRelation({ id: id('rel-read'), relationType: 'read', subjectObjectId: svcA.id, objectId: tableX.id, confidence: 0.7 }),
        // svcB --write--> tableX
        makeRelation({ id: id('rel-write'), relationType: 'write', subjectObjectId: svcB.id, objectId: tableX.id, confidence: 0.6 }),
        // svcA --produce--> topicP
        makeRelation({ id: id('rel-prod'), relationType: 'produce', subjectObjectId: svcA.id, objectId: topicP.id, confidence: 0.85 }),
        // svcB --consume--> topicP
        makeRelation({ id: id('rel-cons'), relationType: 'consume', subjectObjectId: svcB.id, objectId: topicP.id, confidence: 0.75 }),
    ];

    // 도메인 어피니티
    const affinities = [
        makeAffinity({ objectId: svcA.id, domainId: domOrder.id, affinity: 0.8 }),
        makeAffinity({ objectId: svcA.id, domainId: domPayment.id, affinity: 0.3 }),
        makeAffinity({ objectId: svcB.id, domainId: domPayment.id, affinity: 0.9 }),
        makeAffinity({ objectId: svcB.id, domainId: domOrder.id, affinity: 0.2 }),
    ];

    // call 관계를 innerJoin 결과 형식으로 변환 (S2S rollup에서 사용)
    const objMap = new Map(objects.map((o) => [o.id, o]));
    const callJoined = relations
        .filter((r) => r.relationType === 'call')
        .map((r) => ({
            relation: r,
            targetParentId: objMap.get(r.objectId)?.parentId ?? null,
            targetGranularity: objMap.get(r.objectId)?.granularity ?? 'ATOMIC',
        }));

    return {
        objects,
        relations,
        affinities,
        callJoined,
        svcA, svcB, epB1, epB2, dbX, tableX, brokerM, topicP, domOrder, domPayment,
    };
}
