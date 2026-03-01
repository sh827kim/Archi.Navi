import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import { findPaths } from '../../query-engine/pathDiscovery';
import type { QueryScope } from '@archi-navi/shared';

const scope: QueryScope = {
  level: 'SERVICE_TO_SERVICE',
  visibility: 'VISIBLE_ONLY',
};

describe('findPaths', () => {
  it('from/to가 없으면 빈 결과를 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    const result = await findPaths(graph, {}, scope);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.paths).toEqual([]);
  });

  it('경로가 없으면 빈 결과를 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    graph.addNode('svc-a');
    graph.addNode('svc-b');
    graph.addNode('svc-c');
    graph.addDirectedEdgeWithKey('e1', 'svc-a', 'svc-b', { confidence: 0.8, edgeWeight: 1 });

    const result = await findPaths(
      graph,
      { fromObjectId: 'svc-a', toObjectId: 'svc-c', maxHops: 3, topK: 3 },
      scope,
    );

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.paths).toEqual([]);
  });

  it('score 기준으로 정렬 후 topK만 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'svc-b', 'svc-c', 'svc-d'].forEach((id) => graph.addNode(id));

    // high-score path: a -> b -> d
    graph.addDirectedEdgeWithKey('e-ab', 'svc-a', 'svc-b', {
      relationType: 'call',
      edgeWeight: 5,
      confidence: 0.9,
      rollupId: 'r-high-1',
      baseRelationIds: ['rel-high-1'],
    });
    graph.addDirectedEdgeWithKey('e-bd', 'svc-b', 'svc-d', {
      relationType: 'depend_on',
      edgeWeight: 5,
      confidence: 0.9,
      rollupId: 'r-high-2',
      baseRelationIds: ['rel-high-2'],
    });

    // low-score path: a -> c -> d
    graph.addDirectedEdgeWithKey('e-ac', 'svc-a', 'svc-c', {
      relationType: 'call',
      edgeWeight: 1,
      confidence: 0.6,
      rollupId: 'r-low-1',
      baseRelationIds: ['rel-low-1'],
    });
    graph.addDirectedEdgeWithKey('e-cd', 'svc-c', 'svc-d', {
      relationType: 'call',
      edgeWeight: 1,
      confidence: 0.6,
      rollupId: 'r-low-2',
      baseRelationIds: ['rel-low-2'],
    });

    const result = await findPaths(
      graph,
      { fromObjectId: 'svc-a', toObjectId: 'svc-d', maxHops: 4, topK: 1 },
      scope,
    );

    expect(result.paths).toHaveLength(1);
    expect(result.paths?.[0]?.nodeIds).toEqual(['svc-a', 'svc-b', 'svc-d']);

    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((e) => e.subjectId)).toContain('svc-a');
    expect(result.edges.map((e) => e.objectId)).toContain('svc-d');
  });

  it('maxHops를 초과하는 경로는 제외해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'svc-b', 'svc-c', 'svc-d'].forEach((id) => graph.addNode(id));
    graph.addDirectedEdgeWithKey('e-ab', 'svc-a', 'svc-b', { confidence: 0.8, edgeWeight: 1 });
    graph.addDirectedEdgeWithKey('e-bc', 'svc-b', 'svc-c', { confidence: 0.8, edgeWeight: 1 });
    graph.addDirectedEdgeWithKey('e-cd', 'svc-c', 'svc-d', { confidence: 0.8, edgeWeight: 1 });

    const result = await findPaths(
      graph,
      { fromObjectId: 'svc-a', toObjectId: 'svc-d', maxHops: 2, topK: 3 },
      scope,
    );

    expect(result.paths).toEqual([]);
  });

  it('사이클이 있어도 visited 기반으로 무한루프 없이 경로를 찾아야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'svc-b', 'svc-c'].forEach((id) => graph.addNode(id));
    graph.addDirectedEdgeWithKey('e-ab', 'svc-a', 'svc-b', { confidence: 0.8, edgeWeight: 1 });
    graph.addDirectedEdgeWithKey('e-ba', 'svc-b', 'svc-a', { confidence: 0.8, edgeWeight: 1 });
    graph.addDirectedEdgeWithKey('e-bc', 'svc-b', 'svc-c', { confidence: 0.9, edgeWeight: 2 });

    const result = await findPaths(
      graph,
      { fromObjectId: 'svc-a', toObjectId: 'svc-c', maxHops: 5, topK: 3 },
      scope,
    );

    expect(result.paths?.length ?? 0).toBeGreaterThan(0);
    expect(result.paths?.[0]?.nodeIds).toEqual(['svc-a', 'svc-b', 'svc-c']);
  });
});
