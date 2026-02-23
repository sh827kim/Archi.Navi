/**
 * Query Executor - QueryRequest를 받아 적절한 알고리즘으로 위임
 */
import type { DbClient } from '@archi-navi/db';
import type { QueryRequest, QueryResponse } from '@archi-navi/shared';
import { getOrBuildGraph } from '../graph-index/index';
import { findPaths } from './pathDiscovery';
import { analyzeImpact } from './impactAnalysis';
import { discoverUsage } from './usageDiscovery';
import { summarizeDomain } from './domainSummary';
import { DEFAULTS } from '@archi-navi/shared';

/**
 * 쿼리 실행 메인 진입점
 * queryType에 따라 적절한 알고리즘으로 라우팅
 */
export async function executeQuery(
  db: DbClient,
  request: QueryRequest,
): Promise<QueryResponse> {
  const startTime = Date.now();

  // 기본 generation_version은 호출자가 주입 (API 레이어에서 ACTIVE 조회 후 전달)
  const generationVersion = request.generationVersion ?? 0;

  let result: QueryResponse['result'];

  switch (request.queryType) {
    case 'PATH_DISCOVERY': {
      const graph = await getOrBuildGraph(db, request.workspaceId, generationVersion, request.scope.level);
      result = await findPaths(graph, request.params, request.scope);
      break;
    }

    case 'IMPACT_ANALYSIS': {
      const graph = await getOrBuildGraph(db, request.workspaceId, generationVersion, request.scope.level);
      result = await analyzeImpact(graph, request.params, request.scope);
      break;
    }

    case 'USAGE_DISCOVERY': {
      const graph = await getOrBuildGraph(db, request.workspaceId, generationVersion, request.scope.level);
      result = await discoverUsage(db, graph, request.workspaceId, request.params, request.scope);
      break;
    }

    case 'DOMAIN_SUMMARY':
      // DOMAIN_SUMMARY는 graph를 사용하지 않으므로 빌드 생략 (INT-C1)
      result = await summarizeDomain(db, request.workspaceId, generationVersion, request.params);
      break;

    default:
      result = { nodes: [], edges: [] };
  }

  return {
    queryType: request.queryType,
    result,
    meta: {
      generationVersion,
      computedAt: new Date().toISOString(),
      executionMs: Date.now() - startTime,
      truncated: false,
    },
  };
}
