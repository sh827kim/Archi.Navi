/**
 * Graph Index - Adjacency 캐시 빌더
 * DB에서 읽은 rollup 데이터를 graphology 그래프 인스턴스로 변환
 * generation_version이 변경되면 캐시를 무효화하고 재구성
 */
import Graph from 'graphology';
import type { DbClient } from '@archi-navi/db';
import type { RollupLevel } from '@archi-navi/shared';
import { getRollupEdges } from '../graph-store/index';

/** 캐시 키 구조 */
interface CacheKey {
  workspaceId: string;
  generationVersion: number;
  rollupLevel: RollupLevel;
}

/** 캐시 항목 */
interface CacheEntry {
  graph: Graph;
  builtAt: Date;
}

// generation_version별 그래프 캐시
const graphCache = new Map<string, CacheEntry>();

/** 캐시 키 문자열 생성 */
function makeCacheKey(key: CacheKey): string {
  return `${key.workspaceId}:${key.generationVersion}:${key.rollupLevel}`;
}

/**
 * Rollup 그래프 인스턴스 반환 (캐시 적용)
 * 동일한 generation_version에 대해 이미 구성된 그래프가 있으면 재사용
 */
export async function getOrBuildGraph(
  db: DbClient,
  workspaceId: string,
  generationVersion: number,
  rollupLevel: RollupLevel,
): Promise<Graph> {
  const key = makeCacheKey({ workspaceId, generationVersion, rollupLevel });

  // 캐시 히트
  const cached = graphCache.get(key);
  if (cached) return cached.graph;

  // 캐시 미스 - DB에서 rollup edge 조회 후 그래프 구성
  const edges = await getRollupEdges(db, workspaceId, generationVersion, rollupLevel);

  const graph = new Graph({ multi: false, type: 'directed' });

  for (const edge of edges) {
    // 노드 추가 (없으면 생성)
    if (!graph.hasNode(edge.subjectObjectId)) {
      graph.addNode(edge.subjectObjectId);
    }
    if (!graph.hasNode(edge.objectId)) {
      graph.addNode(edge.objectId);
    }

    // 엣지 추가
    const edgeKey = `${edge.subjectObjectId}->${edge.objectId}:${edge.relationType}`;
    if (!graph.hasEdge(edgeKey)) {
      graph.addEdgeWithKey(edgeKey, edge.subjectObjectId, edge.objectId, {
        rollupId: edge.id,
        relationType: edge.relationType,
        edgeWeight: edge.edgeWeight,
        confidence: edge.confidence ?? 0,
        baseRelationIds: edge.baseRelationIds ?? [],
      });
    }
  }

  graphCache.set(key, { graph, builtAt: new Date() });
  return graph;
}

/**
 * 특정 workspace의 모든 캐시 무효화
 * Rollup 재빌드 시 호출
 */
export function invalidateCache(workspaceId: string): void {
  for (const key of graphCache.keys()) {
    if (key.startsWith(workspaceId)) {
      graphCache.delete(key);
    }
  }
}
