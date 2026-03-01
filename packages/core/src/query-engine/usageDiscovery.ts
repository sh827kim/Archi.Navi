/**
 * USAGE_DISCOVERY - 특정 Object의 사용 주체 탐색
 * 원자 객체(topic/db_table/api_endpoint)는 object_relations 직접 조회
 * 상위 객체(database/broker/service)는 rollup 우선 조회
 */
import Graph from 'graphology';
import { eq, and } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objectRelations } from '@archi-navi/db';
import type { QueryParams, QueryScope, QueryResponse } from '@archi-navi/shared';

/**
 * 특정 Object를 사용하는 주체 목록 반환
 */
export async function discoverUsage(
  db: DbClient,
  graph: Graph,
  workspaceId: string,
  params: QueryParams,
  _scope: QueryScope,
): Promise<QueryResponse['result']> {
  const { objectId } = params;

  if (!objectId) {
    return { nodes: [], edges: [] };
  }

  // Rollup 그래프에서 inbound 탐색 (누가 이 Object를 사용하는가)
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();

  if (graph.hasNode(objectId)) {
    const inEdges = graph.inEdges(objectId);
    for (const edgeKey of inEdges) {
      const source = graph.source(edgeKey);
      nodeSet.add(source);
      edgeSet.add(edgeKey);
    }
    nodeSet.add(objectId);
  }

  // 원자 객체의 경우 DB에서 직접 조회 보완
  const atomicRelations = await db
    .select()
    .from(objectRelations)
    .where(
      and(eq(objectRelations.workspaceId, workspaceId), eq(objectRelations.objectId, objectId)),
    );

  for (const rel of atomicRelations) {
    nodeSet.add(rel.subjectObjectId);
    nodeSet.add(rel.objectId);
  }

  return {
    nodes: [...nodeSet].map((id) => ({ id, type: 'service', name: id })),
    edges: [
      // Rollup edges
      ...[...edgeSet].map((key) => {
        const source = graph.source(key);
        const target = graph.target(key);
        const attrs = graph.getEdgeAttributes(key);
        return {
          subjectId: source,
          objectId: target,
          relationType: ((attrs['relationType'] as string) ?? 'call') as QueryResponse['result']['edges'][0]['relationType'],
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
      // Atomic relation edges
      ...atomicRelations.map((rel: typeof atomicRelations[0]) => ({
        subjectId: rel.subjectObjectId,
        objectId: rel.objectId,
        relationType: rel.relationType as QueryResponse['result']['edges'][0]['relationType'],
        level: 'SERVICE_TO_SERVICE' as const,
        edgeWeight: 1,
        confidence: rel.confidence ?? 0,
        provenance: { rollupId: '', baseRelationIds: [rel.id] },
      })),
    ],
  };
}
