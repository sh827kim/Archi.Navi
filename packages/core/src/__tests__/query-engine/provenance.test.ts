import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { findPaths } from '../../query-engine/pathDiscovery';
import { analyzeImpact } from '../../query-engine/impactAnalysis';
import type { QueryScope } from '@archi-navi/shared';

const scope: QueryScope = {
  level: 'SERVICE_TO_SERVICE',
  visibility: 'VISIBLE_ONLY',
};

function buildGraph() {
  const graph = new Graph({ multi: false, type: 'directed' });
  graph.addNode('svc-a');
  graph.addNode('svc-b');
  graph.addEdgeWithKey('e1', 'svc-a', 'svc-b', {
    rollupId: 'rollup-1',
    relationType: 'call',
    edgeWeight: 2,
    confidence: 0.88,
    baseRelationIds: ['rel-1', 'rel-2'],
  });
  return graph;
}

describe('Query provenance', () => {
  it('PATH_DISCOVERY는 그래프 edge의 baseRelationIds를 응답에 반영해야 한다', async () => {
    const graph = buildGraph();

    const result = await findPaths(
      graph,
      { fromObjectId: 'svc-a', toObjectId: 'svc-b', maxHops: 3, topK: 3 },
      scope,
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.provenance.rollupId).toBe('rollup-1');
    expect(result.edges[0]?.provenance.baseRelationIds).toEqual(['rel-1', 'rel-2']);
  });

  it('IMPACT_ANALYSIS는 그래프 edge의 baseRelationIds를 응답에 반영해야 한다', async () => {
    const graph = buildGraph();

    const result = await analyzeImpact(
      graph,
      { targetObjectId: 'svc-a', direction: 'DOWNSTREAM', maxDepth: 2 },
      scope,
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.provenance.rollupId).toBe('rollup-1');
    expect(result.edges[0]?.provenance.baseRelationIds).toEqual(['rel-1', 'rel-2']);
  });
});
