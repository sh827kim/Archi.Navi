/**
 * 도메인 의미 프로파일(Domain Semantic Profile) 타입
 * 도메인이 "무엇을 책임지는가" 를 사람과 AI가 모두 이해할 수 있는 형태로 표현한다.
 * manifesto-ai 의 도메인 모델(state/action)과 1:1 매핑 가능한 구조를 따른다.
 */

/** 액션 트리거 종류 */
export type ActionTrigger = 'http' | 'message' | 'internal' | 'scheduled';

/** 도메인 이벤트 방향 */
export type DomainEventDirection = 'publish' | 'consume';

/** 의미 프로파일 상태 (DRAFT: LLM 직후, APPROVED: 사람이 검토 완료) */
export type DomainSemanticProfileStatus = 'DRAFT' | 'APPROVED';

/** 단일 evidence 참조 (file:line + 발췌) */
export interface DomainSemanticEvidence {
    /** profile 내부 식별자 (예: "ev-1") - state/action 등에서 evidenceIds 로 참조 */
    id: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    excerpt?: string;
    sourceObjectId?: string;
}

/** 도메인이 소유/관리하는 핵심 데이터 */
export interface DomainSemanticState {
    name: string;
    /** 원본 타입 (TypeScript/Java 표현) */
    type: string;
    /** 자연어 설명 */
    description: string;
    evidenceIds: string[];
}

/** 도메인이 외부에 노출하는 행위 */
export interface DomainSemanticAction {
    name: string;
    description: string;
    params: Array<{ name: string; type: string }>;
    trigger: ActionTrigger;
    evidenceIds: string[];
}

/** 도메인 비즈니스 규칙/불변조건 */
export interface DomainSemanticInvariant {
    description: string;
    /** 위반 시 발생하는 결과 (예외, 거부 응답 등) */
    failureMode: string | null;
    evidenceIds: string[];
}

/** 도메인 이벤트 (메시지 발행/수신) */
export interface DomainSemanticEvent {
    name: string;
    direction: DomainEventDirection;
    /** 토픽/큐/스트림 식별자 */
    channel: string;
    description: string;
    evidenceIds: string[];
}

/** 다른 도메인/객체와의 협력 관계 */
export interface DomainSemanticCollaborator {
    /** 협력 대상이 다른 도메인이면 도메인 id, 그 외(외부 시스템 등)는 null */
    targetDomainId: string | null;
    targetObjectId: string;
    targetName: string;
    relationType: string;
    reason: string;
    evidenceIds: string[];
}

/** 도메인 대표 시나리오 (사용 흐름) */
export interface DomainSemanticScenario {
    title: string;
    /** 자연어로 표현한 단계 (1~7개 권장) */
    steps: string[];
    /** 시작 진입점 객체 id */
    entryPointObjectId: string;
    evidenceIds: string[];
}

/** LLM 생성 + 신호 기반으로 합성된 도메인 의미 프로파일 */
export interface DomainSemanticProfile {
    schemaVersion: '1.0';
    workspaceId: string;
    domainId: string;
    domainName: string;
    /** 도메인의 책임/존재 이유 (자연어 1~3문장) */
    responsibility: string;
    state: DomainSemanticState[];
    actions: DomainSemanticAction[];
    invariants: DomainSemanticInvariant[];
    events: DomainSemanticEvent[];
    collaborators: DomainSemanticCollaborator[];
    scenarios: DomainSemanticScenario[];
    /** state/action/invariant/event/collaborator/scenario 가 참조하는 evidence 목록 */
    evidence: DomainSemanticEvidence[];
    status: DomainSemanticProfileStatus;
    /** ISO 8601 */
    generatedAt: string;
    /** 사용된 LLM 모델 식별자 (예: 'claude-opus-4-7') */
    llmModel: string;
}
