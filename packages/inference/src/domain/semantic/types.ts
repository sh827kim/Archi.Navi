/**
 * 도메인 의미 추출 신호 수집기의 입출력 타입 (DB 접근과 분리된 순수 데이터)
 */
import type { DomainSemanticEvidence } from '@archi-navi/shared';

/** 도메인 멤버 객체 (service / function 등) */
export interface CollectorMemberInput {
    id: string;
    name: string;
    displayName: string | null;
    objectType: string;
    description: string | null;
}

/** interaction_intents 한 행을 단순화한 입력 */
export interface CollectorIntentInput {
    id: string;
    /** intent 의 발신 객체(보통 service 또는 function) — 도메인 멤버여야 함 */
    sourceObjectId: string;
    sourceFunctionId: string | null;
    sourceFilePath: string | null;
    intentType: string; // 'http_call' | 'http_gateway_route' | 'db_access' | 'message_publish' | 'message_consume'
    methodHint: string | null;
    externalPathHint: string | null;
    externalRoutePattern: string | null;
    dbTableHints: string[];
    dbSchemaHint: string | null;
    messageTopicHints: string[];
    messageQueueHints: string[];
    messageBrokerKind: string | null;
    /** 첨부할 evidence 한 묶음 (intent 의 evidence_ids 목록을 통해 join 한 결과) */
    evidences: Array<{ filePath: string | null; lineStart: number | null; lineEnd: number | null; excerpt: string | null }>;
}

/** object_relations 한 행 단순화 */
export interface CollectorRelationInput {
    id: string;
    subjectObjectId: string;
    objectId: string;
    relationType: string;
}

/** 다른 객체의 식별 정보 (relations 의 상대편 lookup 용) */
export interface CollectorOtherObject {
    id: string;
    name: string;
    displayName: string | null;
    objectType: string;
    /** 해당 객체가 속한 도메인 id (없으면 null) */
    domainId: string | null;
}

export interface CollectorInputs {
    domainId: string;
    domainName: string;
    members: CollectorMemberInput[];
    intents: CollectorIntentInput[];
    relations: CollectorRelationInput[];
    /** 멤버 + 외부 객체를 포함하는 lookup */
    objectsById: Record<string, CollectorOtherObject>;
}

/** 액션 후보 (LLM 정제 전 raw 신호) */
export interface ActionCandidate {
    /** 표시용 이름 (예: "POST /orders", "consume order.created") */
    name: string;
    trigger: 'http' | 'message';
    method?: string;
    path?: string;
    channel?: string;
    sourceObjectId: string;
    /** 1+ evidence id 참조 */
    evidenceIds: string[];
}

/** 이벤트 후보 */
export interface EventCandidate {
    name: string;
    direction: 'publish' | 'consume';
    channel: string;
    sourceObjectId: string;
    evidenceIds: string[];
}

/** 협력 도메인/객체 후보 */
export interface CollaboratorCandidate {
    targetObjectId: string;
    targetName: string;
    /** 협력 대상이 다른 도메인이면 해당 도메인 id, 그 외에는 null */
    targetDomainId: string | null;
    relationType: string;
    /** 신호의 출처 한 줄 설명 (예: "service A relation:call → service B") */
    reason: string;
    evidenceIds: string[];
}

/** 외부 DB 테이블 접근 후보 */
export interface DbAccessCandidate {
    table: string;
    schema: string | null;
    sourceObjectId: string;
    evidenceIds: string[];
}

/** 신호 수집 결과 (LLM 합성기에 그대로 전달) */
export interface CollectedSemanticSignals {
    domainId: string;
    domainName: string;
    members: CollectorMemberInput[];
    actions: ActionCandidate[];
    events: EventCandidate[];
    collaborators: CollaboratorCandidate[];
    dbAccesses: DbAccessCandidate[];
    /** 모든 후보가 참조 가능한 통합 evidence 목록 */
    evidence: DomainSemanticEvidence[];
}
