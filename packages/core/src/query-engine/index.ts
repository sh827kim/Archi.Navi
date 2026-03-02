/**
 * Query Engine - BFS/DFS 기반 결정론적 그래프 질의
 * 동일 입력 → 동일 출력 보장
 */
export { executeQuery } from './executor';
export { findPaths } from './pathDiscovery';
export { analyzeImpact } from './impactAnalysis';
export { discoverUsage } from './usageDiscovery';
export { summarizeDomain } from './domainSummary';
export type { DomainSummaryData } from './domainSummary';
export { queryContributors } from './contributors';
export type {
  ContributorQueryInput,
  ContributorQueryResult,
  ContributorGroupBy,
  ContributorScopeMode,
} from './contributors';
