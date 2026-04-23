/**
 * Phase 1 도메인 발견 (LLM 검토 단계 포함) 의 입출력 타입.
 * DB 접근과 분리된 순수 데이터 — 단위 테스트가 fixture 만으로 동작하도록 한다.
 */

/** 발견 입력 — 워크스페이스의 모든 객체 + 신호 + 관계 */
export interface DiscoveryInputs {
    workspaceId: string;
    objects: DiscoveryObjectInput[];
    intents: DiscoveryIntentInput[];
    relations: DiscoveryRelationInput[];
    /** 워크스페이스의 모든 codeArtifact (ownerObjectId 기준 lookup 용) */
    codeArtifacts: DiscoveryCodeArtifactInput[];
}

/** 객체 한 행 단순화 (도메인 멤버 후보) */
export interface DiscoveryObjectInput {
    id: string;
    objectType: string;
    name: string;
    displayName: string | null;
    /** materialized path (예: "/payments/order-service") */
    path: string;
    /** service 의 직접 자식을 따라 service-scope intent 를 상속할 때 사용 */
    parentId?: string | null;
    /**
     * false 면 path/name/intent 신호 추출에는 참여하지만 최종 후보 members 에는 포함되지 않는다.
     * service 객체를 signal-only 로 유지할 때 사용한다.
     */
    memberEligible?: boolean;
    /** 스캐너/ETL 에서 저장한 부가 메타데이터(className/filePath/endpoint 등) */
    metadata?: Record<string, unknown> | null;
}

/** interaction_intents 한 행 단순화 — 외부/내부 경로/토픽 prefix 신호 추출에 사용 */
export interface DiscoveryIntentInput {
    sourceObjectId: string;
    intentType: string;
    externalPathHint: string | null;
    externalRoutePattern: string | null;
    /** 메시지 채널/토픽 (1+ 가능) */
    messageTopicHints: string[];
}

/** object_relations 한 행 — 관계 응집도 계산에 사용 */
export interface DiscoveryRelationInput {
    subjectObjectId: string;
    objectId: string;
    relationType: string;
}

/** code_artifacts 단순화 — 패키지/파일 경로 신호 보강용 (선택) */
export interface DiscoveryCodeArtifactInput {
    ownerObjectId: string | null;
    packageName: string | null;
    filePath: string;
}

/** 결정적 신호 + 관계 응집도 (한 객체 ↔ 한 후보 사이 점수) */
export interface CandidateMemberScore {
    objectId: string;
    /** 후보 path prefix 와 일치하면 1, 아니면 0 */
    pathPrefixMatch: 0 | 1;
    /** 객체 intent 의 externalPath/route 가 후보 route prefix 와 일치하면 1, 아니면 0 */
    routePrefixMatch: 0 | 1;
    /** 객체 intent 의 messageTopic 이 후보 topic prefix 와 일치하면 1, 아니면 0 */
    topicPrefixMatch: 0 | 1;
    /** 객체 이름 토큰 ↔ 후보 이름 토큰 Jaccard 유사도 (0~1) */
    nameTokenJaccard: number;
    /** class/controller/mapper/file family 매칭 */
    codeFamilyMatch: 0 | 1;
    /** db table/resource family 매칭 */
    tableFamilyMatch: 0 | 1;
    /** 후보 매칭 + 객체 전체 근거(route/class/table/name/path) */
    seedSources: string[];
    /** affinity = (path + route + topic + name + code + table) / 4 capped */
    affinity: number;
    /** 객체의 outgoing/incoming 관계 중 후보 멤버로 향하는 비율 (0~1) */
    relationCohesion: number;
}

export type LlmSplitSelectorKind =
    | 'route_prefix'
    | 'class_name'
    | 'file_path'
    | 'table_name'
    | 'seed_source'
    | 'object_name';

export interface LlmSplitSelector {
    kind: LlmSplitSelectorKind;
    value: string;
}

/** 한 후보 도메인 그룹 — 결정적 클러스터링 산출 + LLM 검토 후 풍부화 */
export interface DomainCandidate {
    /** 후보 식별자 (자동 생성, slug 형태) */
    id: string;
    /** 자동 라벨 (path/route/topic prefix 중 하나에서 도출한 한글/영문) */
    autoName: string;
    /** 강한 신호 — UI 카드의 칩으로 표시 */
    signals: {
        topPathPrefix: string | null;
        topRoutePrefix: string | null;
        topTopicPrefix: string | null;
        topCodeFamily: string | null;
        topTableFamily: string | null;
        seedSourceSummary: Array<{ source: string; value: string }>;
    };
    /** affinity ≥ 0.25 인 멤버들 */
    members: CandidateMemberScore[];
    /** LLM 검토 결과 (검토 전이면 null) */
    review: LlmCandidateReview | null;
    origin?: 'structural' | 'llm_split';
    parentCandidateId?: string | null;
    splitReason?: string | null;
    splitEvidenceHints?: string[];
}

/** LLM 검토 응답 (zod 스키마와 동일) */
export interface LlmCandidateReview {
    coherent: boolean;
    suggestedName: string;
    responsibilityHint: string;
    mergeWithCandidateId: string | null;
    splitSuggestions: Array<{
        suggestedName: string;
        responsibilityHint: string;
        reason: string;
        confidence: number;
        memberSelectors: LlmSplitSelector[];
        evidenceHints: string[];
    }>;
}

/** 사용자 승인 시 클라이언트가 서버로 보내는 최소 직렬화 형태 */
export interface DomainCandidateApprovalPayload {
    /** 사용자가 인라인 편집한 최종 도메인 이름 */
    name: string;
    /** primary 멤버 (affinity 가장 높은 후보의 멤버, affinity ≥ 0.25) */
    primaryMembers: ApprovalMember[];
    /** secondary 멤버 (affinity ≥ 0.5 인 보조 후보 매핑) */
    secondaryMembers: ApprovalMember[];
}

export interface ApprovalMember {
    objectId: string;
    affinity: number;
    confidence: number;
}
