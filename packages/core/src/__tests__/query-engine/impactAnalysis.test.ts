import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { analyzeImpact } from '../../query-engine/impactAnalysis';
import type { QueryScope } from '@archi-navi/shared';

const scope: QueryScope = {
  level: 'SERVICE_TO_SERVICE',
  visibility: 'VISIBLE_ONLY',
};

describe('analyzeImpact', () => {
  it('targetObjectId가 없으면 빈 결과를 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    const result = await analyzeImpact(graph, {}, scope);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('direction=BOTH면 inbound/outbound edge를 모두 포함해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'svc-b', 'svc-c'].forEach((id) => graph.addNode(id));
    graph.addDirectedEdgeWithKey('e-ab', 'svc-a', 'svc-b', {
      relationType: 'call',
      edgeWeight: 2,
      confidence: 0.9,
      rollupId: 'r1',
      baseRelationIds: ['rel-1'],
    });
    graph.addDirectedEdgeWithKey('e-bc', 'svc-b', 'svc-c', {
      relationType: 'depend_on',
      edgeWeight: 1,
      confidence: 0.8,
      rollupId: 'r2',
      baseRelationIds: ['rel-2'],
    });

    const result = await analyzeImpact(
      graph,
      { targetObjectId: 'svc-b', direction: 'BOTH', maxDepth: 2 },
      scope,
    );

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['svc-a', 'svc-b', 'svc-c']);
    expect(result.edges.map((e) => e.subjectId).sort()).toEqual(['svc-a', 'svc-b']);
    expect(result.edges.map((e) => e.objectId).sort()).toEqual(['svc-b', 'svc-c']);
  });

  it('maxDepth를 넘는 노드는 탐색하지 않아야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'svc-b', 'svc-c'].forEach((id) => graph.addNode(id));
    graph.addDirectedEdgeWithKey('e-ab', 'svc-a', 'svc-b', { relationType: 'call' });
    graph.addDirectedEdgeWithKey('e-bc', 'svc-b', 'svc-c', { relationType: 'call' });

    const result = await analyzeImpact(
      graph,
      { targetObjectId: 'svc-a', direction: 'DOWNSTREAM', maxDepth: 1 },
      scope,
    );

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['svc-a', 'svc-b']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.subjectId).toBe('svc-a');
    expect(result.edges[0]?.objectId).toBe('svc-b');
  });
});

