import { test, expect } from '@playwright/test';

const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';

test('P3-7: Object Mapping은 3D 렌더러가 기본이며 새로고침 후에도 유지된다', async ({ page }) => {
  const objects = [
    { id: 'svc-a', name: 'svc-a', displayName: 'Service A', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
    { id: 'svc-b', name: 'svc-b', displayName: 'Service B', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
  ];

  const edges = [
    { id: 'e1', source: 'svc-a', target: 'svc-b', relationType: 'call' },
  ];

  await page.addInitScript((workspaceId) => {
    const persisted = { state: { workspaceId }, version: 0 };
    window.localStorage.setItem('archi-navi:workspace', JSON.stringify(persisted));
  }, WORKSPACE_ID);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: WORKSPACE_ID, name: 'mapping-3d-workspace', createdAt: new Date().toISOString() },
      ]),
    });
  });

  await page.route('**/api/domain-affinities?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        nodes: [],
        edges: level === 'SERVICE_TO_SERVICE' ? edges : [],
        graphStats: [],
      }),
    });
  });

  await page.goto('/mapping-graph');

  await expect(page.getByText('렌더러')).toHaveCount(0);
  await expect(page.getByText('3D(Force)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '2D(D3)' })).toHaveCount(0);
  const graph3dCanvas = page.locator('[data-testid="mapping-graph-3d"] canvas');
  const graph3dFallback = page.locator('text=/^3D renderer unavailable:/');
  await expect
    .poll(async () => (await graph3dCanvas.count()) > 0 || (await graph3dFallback.count()) > 0, { timeout: 15000 })
    .toBe(true);

  await page.reload();
  await expect(page.getByText('렌더러')).toHaveCount(0);
  await expect(page.getByText('3D(Force)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '2D(D3)' })).toHaveCount(0);
  await expect
    .poll(async () => (await graph3dCanvas.count()) > 0 || (await graph3dFallback.count()) > 0, { timeout: 15000 })
    .toBe(true);
});
