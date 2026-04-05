/**
 * Relation 추론 엔진
 * 코드/설정에서 신호를 추출하여 relation_candidates 생성
 */
export { inferRelationsFromCodeSignals } from './codeBased';
export { crossValidatePendingRelationCandidates } from './crossSignalValidation';
export {
  DEFAULT_CROSS_VALIDATION_CONFIG,
} from './crossSignalValidation';
export type {
  CrossValidationConfig,
  CrossValidationSource,
  CrossValidationSummary,
} from './crossSignalValidation';
export { approveRelationCandidate } from './approveRelationCandidate';
export type { ApproveRelationCandidateResult } from './approveRelationCandidate';
