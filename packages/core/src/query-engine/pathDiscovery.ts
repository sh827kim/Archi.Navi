/**
 * PATH_DISCOVERY - BFS 기반 최단 경로 탐색
 * 설계 문서의 결정론적 path score 공식 구현
 */
import Graph from 'graphology';
import type { QueryParams, QueryScope, QueryResponse } from '@archi-navi/shared';
import { DEFAULTS, calculatePathScore } from '@archi-navi/shared';

/**
 * BFS로 fromObjectId → toObjectId 최단 경로를 최대 topK개 탐색
 */
export async function findPaths(
  graph: Graph,
  params: QueryParams,
  _scope: QueryScope,
): Promise<QueryResponse['result']> {
  const { fromObjectId, toObjectId, maxHops = DEFAULTS.MAX_HOPS, topK = DEFAULTS.TOP_K_PATHS } =
    params;

  if (!fromObjectId || !toObjectId) {
    return { nodes: [], edges: [], paths: [] };
  }

  // BFS로 모든 경로 탐색 (maxHops 제한)
  const foundPaths: string[][] = [];
  const queue: { nodeId: string; path: string[]; visited: Set<string> }[] = [
    { nodeId: fromObjectId, path: [fromObjectId], visited: new Set([fromObjectId]) },
  ];

  while (queue.length > 0 && foundPaths.length < topK * 10) {
    const current = queue.shift();
    if (!current) break;

    const { nodeId, path, visited } = current;

    // 목적지 도달
    if (nodeId === toObjectId) {
      foundPaths.push(path);
      continue;
    }

    // 깊이 제한 초과
    if (path.length > maxHops) continue;

    // 인접 노드 탐색
    if (!graph.hasNode(nodeId)) continue;
    const neighbors = graph.outNeighbors(nodeId);

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        queue.push({
          nodeId: neighbor,
          path: [...path, neighbor],
          visited: new Set([...visited, neighbor]),
        });
      }
    }
  }

  if (foundPaths.length === 0) {
    return { nodes: [], edges: [], paths: [] };
  }

  // 경로별 score 계산 후 Top-K 선택
  const scoredPaths = foundPaths
    .map((nodeIds, idx) => {
      const edges = getEdgesForPath(graph, nodeIds);
      const avgConfidence =
        edges.reduce((sum, e) => sum + (e.confidence as number), 0) / edges.length;
      const minEdgeWeight = Math.min(...edges.map((e) => e.edgeWeight as number));
      const score = calculatePathScore(avgConfidence, minEdgeWeight, nodeIds.length - 1);
      return { pathId: `p${idx + 1}`, nodeIds, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // 결과 노드/엣지 수집
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();

  for (const path of scoredPaths) {
    path.nodeIds.forEach((id) => nodeSet.add(id));
    getEdgeKeysForPath(graph, path.nodeIds).forEach((k) => edgeSet.add(k));
  }

  return {
    nodes: [...nodeSet].map((id) => ({ id, type: 'service', name: id })),
    edges: [...edgeSet].map((key) => buildEdgeFromKey(graph, key)),
    paths: scoredPaths,
  };
}

/** 경로의 edge 속성 목록 반환 */
function getEdgesForPath(graph: Graph, nodeIds: string[]): Record<string, unknown>[] {
  const edges: Record<string, unknown>[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const source = nodeIds[i] as string;
    const target = nodeIds[i + 1] as string;
    if (graph.hasEdge(source, target)) {
      edges.push(graph.getEdgeAttributes(source, target));
    }
  }
  return edges;
}

/** 경로의 edge 키 목록 반환 */
function getEdgeKeysForPath(graph: Graph, nodeIds: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const source = nodeIds[i] as string;
    const target = nodeIds[i + 1] as string;
    const edgeKey = graph.edge(source, target);
    if (edgeKey) keys.push(edgeKey);
  }
  return keys;
}

/** edge 키로부터 QueryEdge 생성 */
function buildEdgeFromKey(graph: Graph, edgeKey: string): QueryResponse['result']['edges'][0] {
  const source = graph.source(edgeKey);
  const target = graph.target(edgeKey);
  const attrs = graph.getEdgeAttributes(edgeKey);
  return {
    subjectId: source,
    objectId: target,
    relationType: ((attrs['relationType'] as string) ?? 'call') as 'call' | 'expose' | 'read' | 'write' | 'produce' | 'consume' | 'depend_on',
    level: 'SERVICE_TO_SERVICE',
    edgeWeight: (attrs['edgeWeight'] as number) ?? 1,
    confidence: (attrs['confidence'] as number) ?? 0,
    provenance: {
      rollupId: (attrs['rollupId'] as string) ?? '',
      baseRelationIds: Array.isArray(attrs['baseRelationIds'])
        ? (attrs['baseRelationIds'] as string[])
        : [],
    },
  };
}
