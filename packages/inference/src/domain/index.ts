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
export { extractLabelCandidates } from './labelExtractor';
export type { LabelCandidate } from './labelExtractor';
