/**
 * Rollup 증분 리빌드 관련 타입 정의
 * 변경 이벤트(ChangeEvent)로 영향 범위를 식별하여 부분 재계산한다.
 */

/** 변경 이벤트 종류 */
export type ChangeEventType =
    | 'RELATION_APPROVED'
    | 'RELATION_DELETED'
    | 'OBJECT_PARENT_CHANGED'
    | 'EXPOSE_CHANGED'
    | 'DOMAIN_AFFINITY_CHANGED';

/** relation 변경 페이로드 */
export interface RelationChangePayload {
    relationType: string;
    subjectObjectId: string;
    objectId: string;
}

/** object parent 변경 페이로드 */
export interface ParentChangePayload {
    objectId: string;
    oldParentId: string | null;
    newParentId: string | null;
}

/** domain affinity 변경 페이로드 */
export interface AffinityChangePayload {
    objectId: string;
    domainId: string;
}

/** 변경 이벤트 (discriminated union) */
export type ChangeEvent =
    | { type: 'RELATION_APPROVED'; payload: RelationChangePayload }
    | { type: 'RELATION_DELETED'; payload: RelationChangePayload }
    | { type: 'OBJECT_PARENT_CHANGED'; payload: ParentChangePayload }
    | { type: 'EXPOSE_CHANGED'; payload: RelationChangePayload }
    | { type: 'DOMAIN_AFFINITY_CHANGED'; payload: AffinityChangePayload };

/** 재계산이 필요한 rollup level */
export type AffectedRollupLevel =
    | 'SERVICE_TO_SERVICE'
    | 'SERVICE_TO_DATABASE'
    | 'SERVICE_TO_BROKER'
    | 'DOMAIN_TO_DOMAIN';

/** 증분 영향 범위 분석 결과 */
export interface AffectedScope {
    /** 재계산 대상 level 집합 */
    levels: Set<AffectedRollupLevel>;
    /** S2S에서 영향받는 서비스 ID */
    s2sAffectedServiceIds: Set<string>;
    /** S2DB에서 영향받는 서비스 ID */
    s2dbAffectedServiceIds: Set<string>;
    /** S2B에서 영향받는 서비스 ID */
    s2bAffectedServiceIds: Set<string>;
}
