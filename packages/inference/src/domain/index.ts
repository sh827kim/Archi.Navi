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

// 도메인 발견 (Phase 1) — 결정적 클러스터링 + LLM 검토
export {
    AFFINITY_THRESHOLD,
    runStructuralClustering,
    tokenizeName,
} from './discovery/structuralClustering';
export type {
    StructuralClusterCandidate,
    StructuralClusteringResult,
} from './discovery/structuralClustering';
export { computeRelationCohesion } from './discovery/relationCohesion';
export type {
    RelationCohesionInput,
    RelationCohesionResult,
} from './discovery/relationCohesion';
export { reviewDomainCandidate } from './discovery/llmReviewer';
export type {
    DomainReviewerInputs,
    GenerateDomainReviewFn,
} from './discovery/llmReviewer';
export {
    runDomainDiscovery,
    SECONDARY_AFFINITY_THRESHOLD,
} from './discovery/runDomainDiscovery';
export type {
    RunDomainDiscoveryArgs,
    RunDomainDiscoveryResult,
} from './discovery/runDomainDiscovery';
export type {
    ApprovalMember,
    CandidateMemberScore,
    DiscoveryCodeArtifactInput,
    DiscoveryInputs,
    DiscoveryIntentInput,
    DiscoveryObjectInput,
    DiscoveryRelationInput,
    DomainCandidate,
    DomainCandidateApprovalPayload,
    LlmCandidateReview,
} from './discovery/types';

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
