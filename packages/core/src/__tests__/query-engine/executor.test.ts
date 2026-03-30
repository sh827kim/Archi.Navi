import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executePreparedQuery,
  executeQuery,
  prepareQueryExecution,
  requiresRollupGraph,
} from '../../query-engine/executor';
import { getOrBuildGraph } from '../../graph-index/index';
import { findPaths } from '../../query-engine/pathDiscovery';
import { analyzeImpact } from '../../query-engine/impactAnalysis';
import { discoverUsage } from '../../query-engine/usageDiscovery';
import { summarizeDomain } from '../../query-engine/domainSummary';
import { getActiveGeneration } from '../../rollup/generationManager';

vi.mock('../../graph-index/index', () => ({
  getOrBuildGraph: vi.fn(),
}));

vi.mock('../../query-engine/pathDiscovery', () => ({
  findPaths: vi.fn(),
}));

vi.mock('../../query-engine/impactAnalysis', () => ({
  analyzeImpact: vi.fn(),
}));

vi.mock('../../query-engine/usageDiscovery', () => ({
  discoverUsage: vi.fn(),
}));

vi.mock('../../query-engine/domainSummary', () => ({
  summarizeDomain: vi.fn(),
}));

vi.mock('../../rollup/generationManager', () => ({
  getActiveGeneration: vi.fn(),
}));

describe('query execution pipeline split', () => {
  const db = {} as Parameters<typeof executeQuery>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrBuildGraph).mockResolvedValue({} as never);
    vi.mocked(findPaths).mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.mocked(analyzeImpact).mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.mocked(discoverUsage).mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.mocked(summarizeDomain).mockResolvedValue({ nodes: [], edges: [], summary: {} } as never);
  });

  it('rollup graph가 필요한 query type만 그래프 stage를 사용해야 한다', () => {
    expect(requiresRollupGraph('PATH_DISCOVERY')).toBe(true);
    expect(requiresRollupGraph('IMPACT_ANALYSIS')).toBe(true);
    expect(requiresRollupGraph('USAGE_DISCOVERY')).toBe(true);
    expect(requiresRollupGraph('DOMAIN_SUMMARY')).toBe(false);
  });

  it('prepare stage는 generationVersion 계산과 graph 빌드를 분리해 반환해야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(11);
    const graph = { key: 'graph' } as never;
    vi.mocked(getOrBuildGraph).mockResolvedValue(graph);

    const prepared = await prepareQueryExecution(db, {
      queryType: 'IMPACT_ANALYSIS',
      workspaceId: 'ws-1',
      scope: { level: 'SERVICE_TO_SERVICE', visibility: 'VISIBLE_ONLY' },
      params: {},
    });

    expect(prepared).toEqual({ generationVersion: 11, graph });
    expect(getOrBuildGraph).toHaveBeenCalledWith(db, 'ws-1', 11, 'SERVICE_TO_SERVICE');
  });

  it('prepare stage는 DOMAIN_SUMMARY에서 graph를 만들지 않아야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(5);

    const prepared = await prepareQueryExecution(db, {
      queryType: 'DOMAIN_SUMMARY',
      workspaceId: 'ws-1',
      scope: { level: 'DOMAIN_TO_DOMAIN', visibility: 'VISIBLE_ONLY' },
      params: { domainId: 'domain-1' },
    });

    expect(prepared).toEqual({ generationVersion: 5, graph: null });
    expect(getOrBuildGraph).not.toHaveBeenCalled();
  });

  it('execution stage는 준비된 graph만 사용해 알고리즘을 수행해야 한다', async () => {
    const graph = { graph: true } as never;
    await executePreparedQuery(
      db,
      {
        queryType: 'PATH_DISCOVERY',
        workspaceId: 'ws-1',
        scope: { level: 'SERVICE_TO_SERVICE', visibility: 'VISIBLE_ONLY' },
        params: { fromObjectId: 'a', toObjectId: 'b' },
      },
      { generationVersion: 2, graph },
    );

    expect(findPaths).toHaveBeenCalledWith(
      graph,
      expect.objectContaining({ fromObjectId: 'a', toObjectId: 'b' }),
      expect.anything(),
    );
  });
});

describe('executeQuery generationVersion resolution', () => {
  const db = {} as Parameters<typeof executeQuery>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrBuildGraph).mockResolvedValue({} as never);
    vi.mocked(findPaths).mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.mocked(analyzeImpact).mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.mocked(discoverUsage).mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.mocked(summarizeDomain).mockResolvedValue({ nodes: [], edges: [], summary: {} } as never);
  });

  it('generationVersion 미지정 시 ACTIVE generation을 사용해야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(7);

    const result = await executeQuery(db, {
      queryType: 'PATH_DISCOVERY',
      workspaceId: 'ws-1',
      scope: { level: 'SERVICE_TO_SERVICE', visibility: 'VISIBLE_ONLY' },
      params: {},
    });

    expect(getActiveGeneration).toHaveBeenCalledWith(db, 'ws-1');
    expect(getOrBuildGraph).toHaveBeenCalledWith(db, 'ws-1', 7, 'SERVICE_TO_SERVICE');
    expect(result.meta.generationVersion).toBe(7);
  });

  it('generationVersion 지정 시 ACTIVE 조회 없이 요청 값을 우선 사용해야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(9);

    const result = await executeQuery(db, {
      queryType: 'IMPACT_ANALYSIS',
      workspaceId: 'ws-1',
      generationVersion: 3,
      scope: { level: 'SERVICE_TO_SERVICE', visibility: 'VISIBLE_ONLY' },
      params: {},
    });

    expect(getActiveGeneration).not.toHaveBeenCalled();
    expect(getOrBuildGraph).toHaveBeenCalledWith(db, 'ws-1', 3, 'SERVICE_TO_SERVICE');
    expect(result.meta.generationVersion).toBe(3);
  });

  it('ACTIVE generation이 없으면 0으로 fallback 해야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(null);

    const result = await executeQuery(db, {
      queryType: 'DOMAIN_SUMMARY',
      workspaceId: 'ws-1',
      scope: { level: 'DOMAIN_TO_DOMAIN', visibility: 'VISIBLE_ONLY' },
      params: {},
    });

    expect(getActiveGeneration).toHaveBeenCalledWith(db, 'ws-1');
    expect(summarizeDomain).toHaveBeenCalledWith(db, 'ws-1', 0, {});
    expect(result.meta.generationVersion).toBe(0);
  });

  it('DOMAIN_SUMMARY는 그래프를 빌드하지 않아야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(5);

    const result = await executeQuery(db, {
      queryType: 'DOMAIN_SUMMARY',
      workspaceId: 'ws-1',
      scope: { level: 'DOMAIN_TO_DOMAIN', visibility: 'VISIBLE_ONLY' },
      params: { domainId: 'domain-1' },
    });

    expect(getOrBuildGraph).not.toHaveBeenCalled();
    expect(summarizeDomain).toHaveBeenCalledWith(db, 'ws-1', 5, { domainId: 'domain-1' });
    expect(result.queryType).toBe('DOMAIN_SUMMARY');
  });

  it('알 수 없는 queryType이면 빈 결과를 반환해야 한다', async () => {
    vi.mocked(getActiveGeneration).mockResolvedValue(2);

    const result = await executeQuery(db, {
      queryType: 'UNKNOWN_QUERY' as unknown as 'PATH_DISCOVERY',
      workspaceId: 'ws-1',
      scope: { level: 'SERVICE_TO_SERVICE', visibility: 'VISIBLE_ONLY' },
      params: {},
    });

    expect(getOrBuildGraph).not.toHaveBeenCalled();
    expect(findPaths).not.toHaveBeenCalled();
    expect(analyzeImpact).not.toHaveBeenCalled();
    expect(discoverUsage).not.toHaveBeenCalled();
    expect(summarizeDomain).not.toHaveBeenCalled();
    expect(result.result).toEqual({ nodes: [], edges: [] });
    expect(result.meta.generationVersion).toBe(2);
  });
});
