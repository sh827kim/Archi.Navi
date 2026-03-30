/**
 * Query Executor - QueryRequest를 받아 적절한 알고리즘으로 위임
 */
import type Graph from 'graphology';
import type { DbClient } from '@archi-navi/db';
import type { QueryRequest, QueryResponse } from '@archi-navi/shared';
import { getOrBuildGraph } from '../graph-index/index';
import { findPaths } from './pathDiscovery';
import { analyzeImpact } from './impactAnalysis';
import { discoverUsage } from './usageDiscovery';
import { summarizeDomain } from './domainSummary';
import { DEFAULTS } from '@archi-navi/shared';
import { getActiveGeneration } from '../rollup/generationManager';

export interface QueryExecutionPreparation {
  generationVersion: number;
  graph: Graph | null;
}

export function requiresRollupGraph(queryType: QueryRequest['queryType']): boolean {
  return queryType === 'PATH_DISCOVERY'
    || queryType === 'IMPACT_ANALYSIS'
    || queryType === 'USAGE_DISCOVERY';
}

export async function prepareQueryExecution(
  db: DbClient,
  request: QueryRequest,
): Promise<QueryExecutionPreparation> {
  const generationVersion =
    request.generationVersion ??
    (await getActiveGeneration(db, request.workspaceId)) ??
    0;

  if (!requiresRollupGraph(request.queryType)) {
    return { generationVersion, graph: null };
  }

  const graph = await getOrBuildGraph(
    db,
    request.workspaceId,
    generationVersion,
    request.scope.level,
  );

  return { generationVersion, graph };
}

export async function executePreparedQuery(
  db: DbClient,
  request: QueryRequest,
  prepared: QueryExecutionPreparation,
): Promise<QueryResponse['result']> {
  const requireGraph = (): Graph => {
    if (!prepared.graph) {
      throw new Error(`Query type ${request.queryType} requires a rollup graph`);
    }
    return prepared.graph;
  };

  switch (request.queryType) {
    case 'PATH_DISCOVERY':
      return findPaths(requireGraph(), request.params, request.scope);

    case 'IMPACT_ANALYSIS':
      return analyzeImpact(requireGraph(), request.params, request.scope);

    case 'USAGE_DISCOVERY':
      return discoverUsage(
        db,
        requireGraph(),
        request.workspaceId,
        request.params,
        request.scope,
      );

    case 'DOMAIN_SUMMARY':
      return summarizeDomain(db, request.workspaceId, prepared.generationVersion, request.params);

    default:
      return { nodes: [], edges: [] };
  }
}

/**
 * 쿼리 실행 메인 진입점
 * queryType에 따라 적절한 알고리즘으로 라우팅
 */
export async function executeQuery(
  db: DbClient,
  request: QueryRequest,
): Promise<QueryResponse> {
  const startTime = Date.now();
  const prepared = await prepareQueryExecution(db, request);
  const result = await executePreparedQuery(db, request, prepared);

  return {
    queryType: request.queryType,
    result,
    meta: {
      generationVersion: prepared.generationVersion,
      computedAt: new Date().toISOString(),
      executionMs: Date.now() - startTime,
      truncated: false,
    },
  };
}
