import { describe, it, expect, vi } from 'vitest';
import Graph from 'graphology';
import { discoverUsage } from '../../query-engine/usageDiscovery';
import type { QueryScope } from '@archi-navi/shared';

const scope: QueryScope = {
  level: 'SERVICE_TO_SERVICE',
  visibility: 'VISIBLE_ONLY',
};

function createMockDb(rows: Array<Record<string, unknown>>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as Parameters<typeof discoverUsage>[0], where, from, select };
}

describe('discoverUsage', () => {
  it('objectId가 없으면 빈 결과를 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    const { db, select } = createMockDb([]);

    const result = await discoverUsage(db, graph, 'ws-1', {}, scope);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('rollup inbound edge와 atomic relation을 함께 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'svc-b', 'topic-1'].forEach((id) => graph.addNode(id));
    graph.addDirectedEdgeWithKey('rollup-1', 'svc-a', 'topic-1', {
      relationType: 'consume',
      edgeWeight: 3,
      confidence: 0.82,
      rollupId: 'rg-1',
      baseRelationIds: ['base-1'],
    });

    const { db } = createMockDb([
      {
        id: 'rel-1',
        subjectObjectId: 'svc-b',
        objectId: 'topic-1',
        relationType: 'consume',
        confidence: 0.77,
      },
    ]);

    const result = await discoverUsage(db, graph, 'ws-1', { objectId: 'topic-1' }, scope);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['svc-a', 'svc-b', 'topic-1']);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.find((e) => e.provenance.rollupId === 'rg-1')).toBeTruthy();
    expect(
      result.edges.find(
        (e) =>
          e.provenance.rollupId === '' &&
          e.provenance.baseRelationIds.includes('rel-1') &&
          e.subjectId === 'svc-b' &&
          e.objectId === 'topic-1',
      ),
    ).toBeTruthy();
  });

  it('그래프 노드가 없어도 atomic relation 기반 결과를 반환해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    const { db } = createMockDb([
      {
        id: 'rel-2',
        subjectObjectId: 'svc-x',
        objectId: 'table-orders',
        relationType: 'read',
        confidence: null,
      },
    ]);

    const result = await discoverUsage(db, graph, 'ws-1', { objectId: 'table-orders' }, scope);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['svc-x', 'table-orders']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.relationType).toBe('read');
    expect(result.edges[0]?.confidence).toBe(0);
  });
});

