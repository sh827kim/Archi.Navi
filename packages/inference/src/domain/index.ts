/**
 * Domain 추론 엔진
 * Track A: Seed 기반 Affinity 계산
 * Track B: Seed-less Discovery (Louvain/Leiden)
 * 승인/거부 처리
 */
export { runSeedBasedInference } from './seedBased';
export { runDiscovery } from './discovery';
export { approveDomainCandidate } from './approveDomainCandidate';
export type { ApproveDomainCandidateResult } from './approveDomainCandidate';
export {
  DEFAULT_DOMAIN_FEEDBACK_CONFIG,
  accumulateDomainCandidateFeedback,
  applyDomainFeedbackToSeedCandidate,
  computeDomainFeedbackAdjustment,
  deriveDomainFeedbackDescriptor,
  getPurityBucket,
  normalizeDomainFeedbackAdjustments,
  normalizeDomainFeedbackConfig,
} from './feedbackLoop';
export type {
  DomainFeedbackConfig,
  DomainFeedbackDescriptor,
  DomainFeedbackMetadata,
  DomainFeedbackPurityBucket,
  DomainFeedbackStats,
  DomainFeedbackTrack,
} from './feedbackLoop';
export { extractLabelCandidates } from './labelExtractor';
export type { LabelCandidate } from './labelExtractor';

// 도메인 의미 추출 엔진 (Phase 2)
export { collectDomainSemanticSignals } from './semantic/semanticSignalCollector';
export { extractScenarioCandidates } from './semantic/scenarioExtractor';
export type { ScenarioCandidate, ScenarioExtractorOptions } from './semantic/scenarioExtractor';
export {
    composeDomainSemanticProfile,
} from './semantic/semanticComposer';
export type {
    GenerateSemanticProfileFn,
    SemanticComposerInputs,
    SemanticLlmDraft,
} from './semantic/semanticComposer';
export {
    DomainNotFoundError,
    fetchDomainSemanticInputs,
} from './semantic/fetchDomainSemanticInputs';
export type { FetchDomainSemanticInputsArgs } from './semantic/fetchDomainSemanticInputs';
export {
    extractDomainSemanticProfile,
    getDomainSemanticProfile,
} from './semantic/extractDomainSemanticProfile';
export type {
    ExtractDomainSemanticProfileArgs,
    ExtractDomainSemanticProfileResult,
} from './semantic/extractDomainSemanticProfile';
export type {
    CollectedSemanticSignals,
    CollectorInputs,
    CollectorIntentInput,
    CollectorMemberInput,
    CollectorOtherObject,
    CollectorRelationInput,
    ActionCandidate,
    CollaboratorCandidate,
    DbAccessCandidate,
    EventCandidate,
} from './semantic/types';
