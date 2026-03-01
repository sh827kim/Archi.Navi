import { test, expect } from '@playwright/test';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const NODE_COUNT = 250;
const EDGE_COUNT = 5000;

type ObjectItem = {
  id: string;
  name: string;
  displayName: string;
  objectType: string;
  granularity: string;
  parentId: string | null;
  depth: number;
};

type RollupEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
};

function buildMockObjects(): ObjectItem[] {
  return Array.from({ length: NODE_COUNT }, (_, idx) => {
    const id = `svc-${idx + 1}`;
    return {
      id,
      name: id,
      displayName: `Service ${idx + 1}`,
      objectType: 'service',
      granularity: 'COMPOUND',
      parentId: null,
      depth: 0,
    };
  });
}

function buildMockEdges(): RollupEdge[] {
  const edges: RollupEdge[] = [];
  for (let idx = 0; idx < EDGE_COUNT; idx++) {
    const src = `svc-${(idx % NODE_COUNT) + 1}`;
    const tgt = `svc-${((idx * 7 + 13) % NODE_COUNT) + 1}`;
    if (src === tgt) continue;
    edges.push({
      id: `edge-${idx + 1}`,
      source: src,
      target: tgt,
      relationType: idx % 3 === 0 ? 'call' : idx % 3 === 1 ? 'depend_on' : 'expose',
    });
  }
  return edges;
}

function buildGraphStats(edges: RollupEdge[]) {
  const inMap = new Map<string, number>();
  const outMap = new Map<string, number>();
  edges.forEach((edge) => {
    outMap.set(edge.source, (outMap.get(edge.source) ?? 0) + 1);
    inMap.set(edge.target, (inMap.get(edge.target) ?? 0) + 1);
  });
  return Array.from({ length: NODE_COUNT }, (_, idx) => {
    const id = `svc-${idx + 1}`;
    return {
      objectId: id,
      inDegree: inMap.get(id) ?? 0,
      outDegree: outMap.get(id) ?? 0,
    };
  });
}

test('P3-3: 2000+ 엣지에서 점진 렌더링 배지가 표시되고 완료 후 사라진다', async ({ page }) => {
  const objects = buildMockObjects();
  const s2sEdges = buildMockEdges();
  const s2sStats = buildGraphStats(s2sEdges);

  await page.addInitScript((workspaceId) => {
    const persisted = { state: { workspaceId }, version: 0 };
    window.localStorage.setItem('archi-navi:workspace', JSON.stringify(persisted));
  }, WORKSPACE_ID);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: WORKSPACE_ID, name: 'e2e-workspace', createdAt: new Date().toISOString() },
      ]),
    });
  });

  await page.route('**/api/objects?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(objects),
    });
  });

  await page.route('**/api/rollups?*', async (route) => {
    const url = new URL(route.request().url());
    const level = url.searchParams.get('level');

    if (level === 'SERVICE_TO_SERVICE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: [],
          edges: s2sEdges,
          graphStats: s2sStats,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        nodes: [],
        edges: [],
        graphStats: [],
      }),
    });
  });

  await page.goto('/mapping-graph');
  await expect(page.getByRole('button', { name: '서비스 ↔ 서비스' })).toBeVisible();

  const progressBadge = page.locator('text=/^edge\\s+\\d+\\/5000$/');
  await expect(progressBadge).toBeVisible({ timeout: 15000 });

  await expect
    .poll(async () => page.locator('path.link-path').count(), { timeout: 20000 })
    .toBe(EDGE_COUNT);

  await expect(progressBadge).toHaveCount(0, { timeout: 15000 });
});
