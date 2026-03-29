import { describe, it, expect, vi } from 'vitest';
import Graph from 'graphology';
import { discoverUsage } from '../../query-engine/usageDiscovery';
import type { QueryScope } from '@archi-navi/shared';

const scope: QueryScope = {
  level: 'SERVICE_TO_SERVICE',
  visibility: 'VISIBLE_ONLY',
};

function createMockDb(results: Array<Array<Record<string, unknown>>>) {
  const queue = [...results];
  const where = vi.fn(() => Promise.resolve(queue.shift() ?? []));
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
    graph.addNode('svc-a', { name: 'order-service', displayName: 'Order Service', objectType: 'service' });
    graph.addNode('svc-b', { name: 'billing-service', displayName: 'Billing Service', objectType: 'service' });
    graph.addNode('topic-1', { name: 'order-events', displayName: 'Order Events', objectType: 'topic' });
    graph.addDirectedEdgeWithKey('rollup-1', 'svc-a', 'topic-1', {
      relationType: 'consume',
      edgeWeight: 3,
      confidence: 0.82,
      rollupId: 'rg-1',
      baseRelationIds: ['base-1'],
    });

    const { db } = createMockDb([[
      {
        id: 'rel-1',
        subjectObjectId: 'svc-b',
        objectId: 'topic-1',
        relationType: 'consume',
        confidence: 0.77,
      },
    ]]);

    const result = await discoverUsage(db, graph, 'ws-1', { objectId: 'topic-1' }, scope);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['svc-a', 'svc-b', 'topic-1']);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'svc-a', name: 'order-service', displayName: 'Order Service' }),
        expect.objectContaining({ id: 'topic-1', name: 'order-events', displayName: 'Order Events', type: 'topic' }),
      ]),
    );
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
      [
        {
          id: 'rel-2',
          subjectObjectId: 'svc-x',
          objectId: 'table-orders',
          relationType: 'read',
          confidence: null,
        },
      ],
      [
        {
          id: 'svc-x',
          name: 'report-service',
          displayName: 'Report Service',
          objectType: 'service',
        },
        {
          id: 'table-orders',
          name: 'orders',
          displayName: 'Orders Table',
          objectType: 'db_table',
        },
      ],
    ]);

    const result = await discoverUsage(db, graph, 'ws-1', { objectId: 'table-orders' }, scope);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['svc-x', 'table-orders']);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'svc-x', name: 'report-service', displayName: 'Report Service' }),
        expect.objectContaining({ id: 'table-orders', name: 'orders', displayName: 'Orders Table', type: 'db_table' }),
      ]),
    );
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.relationType).toBe('read');
    expect(result.edges[0]?.confidence).toBe(0);
  });

  it('rollup edge 속성이 비어있거나 타입이 다르면 기본값으로 보정해야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    ['svc-a', 'topic-1'].forEach((id) => graph.addNode(id));
    graph.addDirectedEdgeWithKey('rollup-raw', 'svc-a', 'topic-1', {
      baseRelationIds: 'not-array',
    });

    const { db } = createMockDb([[]]);
    const result = await discoverUsage(db, graph, 'ws-1', { objectId: 'topic-1' }, scope);
    const edge = result.edges[0];

    expect(edge).toMatchObject({
      subjectId: 'svc-a',
      objectId: 'topic-1',
      relationType: 'call',
      edgeWeight: 1,
      confidence: 0,
      provenance: { rollupId: '', baseRelationIds: [] },
    });
  });

  it('그래프에 대상 노드가 있지만 inbound edge가 없어도 대상 노드는 포함되어야 한다', async () => {
    const graph = new Graph({ multi: false, type: 'directed' });
    graph.addNode('topic-1', { name: 'order-events', displayName: 'Order Events', objectType: 'topic' });

    const { db } = createMockDb([[]]);
    const result = await discoverUsage(db, graph, 'ws-1', { objectId: 'topic-1' }, scope);

    expect(result.nodes).toEqual([
      { id: 'topic-1', type: 'topic', name: 'order-events', displayName: 'Order Events' },
    ]);
    expect(result.edges).toEqual([]);
  });
});
