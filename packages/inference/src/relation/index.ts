/**
 * Relation 추론 엔진
 * 코드/설정에서 신호를 추출하여 relation_candidates 생성
 */
export { inferRelationsFromConfig } from './configBased';
export { inferRelationsFromCodeSignals } from './codeBased';
export { approveRelationCandidate } from './approveRelationCandidate';
export type { ApproveRelationCandidateResult } from './approveRelationCandidate';
