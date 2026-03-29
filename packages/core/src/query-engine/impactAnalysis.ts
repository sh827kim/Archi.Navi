/**
 * IMPACT_ANALYSIS - bounded BFS/DFS 기반 영향도 분석
 * Upstream/Downstream 양방향 지원
 */
import Graph from 'graphology';
import type { QueryParams, QueryScope, QueryResponse } from '@archi-navi/shared';
import { DEFAULTS } from '@archi-navi/shared';

function buildNodeFromGraph(graph: Graph, id: string): QueryResponse['result']['nodes'][0] {
  const attrs = graph.hasNode(id) ? graph.getNodeAttributes(id) : {};
  const name = typeof attrs['name'] === 'string' ? attrs['name'] : id;
  const displayName = typeof attrs['displayName'] === 'string' ? attrs['displayName'] : undefined;
  const objectType = typeof attrs['objectType'] === 'string' ? attrs['objectType'] : 'service';

  return {
    id,
    type: objectType as QueryResponse['result']['nodes'][0]['type'],
    name,
    ...(displayName ? { displayName } : {}),
  };
}

/**
 * 특정 Object의 Upstream/Downstream 영향 범위 분석
 */
export async function analyzeImpact(
  graph: Graph,
  params: QueryParams,
  _scope: QueryScope,
): Promise<QueryResponse['result']> {
  const {
    targetObjectId,
    direction = 'DOWNSTREAM',
    maxDepth = DEFAULTS.MAX_HOPS,
  } = params;

  if (!targetObjectId) {
    return { nodes: [], edges: [] };
  }

  const visitedNodes = new Set<string>();
  const visitedEdges = new Set<string>();

  // BFS로 영향 범위 탐색
  const queue: { nodeId: string; depth: number }[] = [{ nodeId: targetObjectId, depth: 0 }];
  visitedNodes.add(targetObjectId);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;

    if (!graph.hasNode(current.nodeId)) continue;

    // 방향에 따라 탐색 방향 결정
    const neighbors =
      direction === 'UPSTREAM'
        ? graph.inNeighbors(current.nodeId) // 역방향 (나에게 의존하는 것)
        : direction === 'DOWNSTREAM'
          ? graph.outNeighbors(current.nodeId) // 순방향 (내가 의존하는 것)
          : [...graph.inNeighbors(current.nodeId), ...graph.outNeighbors(current.nodeId)];

    for (const neighbor of neighbors) {
      // edge 수집
      const edgeKey =
        direction === 'UPSTREAM'
          ? graph.edge(neighbor, current.nodeId)
          : direction === 'DOWNSTREAM'
            ? graph.edge(current.nodeId, neighbor)
            : graph.edge(neighbor, current.nodeId) ?? graph.edge(current.nodeId, neighbor);
      if (edgeKey) visitedEdges.add(edgeKey);

      if (!visitedNodes.has(neighbor)) {
        visitedNodes.add(neighbor);
        queue.push({ nodeId: neighbor, depth: current.depth + 1 });
      }
    }
  }

  return {
    nodes: [...visitedNodes].map((id) => buildNodeFromGraph(graph, id)),
    edges: [...visitedEdges].map((key) => {
      const source = graph.source(key);
      const target = graph.target(key);
      const attrs = graph.getEdgeAttributes(key);
      return {
        subjectId: source,
        objectId: target,
        relationType: ((attrs['relationType'] as string) ?? 'call') as 'call' | 'expose' | 'read' | 'write' | 'produce' | 'consume' | 'depend_on',
        level: 'SERVICE_TO_SERVICE' as const,
        edgeWeight: (attrs['edgeWeight'] as number) ?? 1,
        confidence: (attrs['confidence'] as number) ?? 0,
        provenance: {
          rollupId: (attrs['rollupId'] as string) ?? '',
          baseRelationIds: Array.isArray(attrs['baseRelationIds'])
            ? (attrs['baseRelationIds'] as string[])
            : [],
        },
      };
    }),
  };
}
