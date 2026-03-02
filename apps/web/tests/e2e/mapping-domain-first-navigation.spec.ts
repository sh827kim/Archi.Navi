import { test, expect } from '@playwright/test';

const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';

test('P3-4: Domain-first 내비게이션(도메인→서비스→아토믹) + 상위로 복귀', async ({ page }) => {
  await page.addInitScript((workspaceId) => {
    const persisted = { state: { workspaceId }, version: 0 };
    window.localStorage.setItem('archi-navi:workspace', JSON.stringify(persisted));
    window.localStorage.setItem('archi-navi:e2e-node-actions', '1');
  }, WORKSPACE_ID);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: WORKSPACE_ID, name: 'domain-first-workspace', createdAt: new Date().toISOString() },
      ]),
    });
  });

  await page.route('**/api/objects?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'dom-order', name: 'dom-order', displayName: 'Order Domain', objectType: 'domain', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'dom-payment', name: 'dom-payment', displayName: 'Payment Domain', objectType: 'domain', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'svc-order', name: 'svc-order', displayName: 'Order Service', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'svc-payment', name: 'svc-payment', displayName: 'Payment Service', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'ep-order-create', name: 'ep-order-create', displayName: 'POST /orders', objectType: 'api_endpoint', granularity: 'ATOMIC', parentId: 'svc-order', depth: 1 },
        { id: 'ep-payment-charge', name: 'ep-payment-charge', displayName: 'POST /payments/charge', objectType: 'api_endpoint', granularity: 'ATOMIC', parentId: 'svc-payment', depth: 1 },
      ]),
    });
  });

  await page.route('**/api/domain-affinities?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { objectId: 'svc-order', domainId: 'dom-order', affinity: 0.91 },
        { objectId: 'svc-payment', domainId: 'dom-payment', affinity: 0.95 },
      ]),
    });
  });

  await page.route('**/api/rollups?*', async (route) => {
    const url = new URL(route.request().url());
    const level = url.searchParams.get('level');

    if (level === 'DOMAIN_TO_DOMAIN') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: [],
          edges: [
            { id: 'd2d-1', source: 'dom-order', target: 'dom-payment', relationType: 'call' },
          ],
          graphStats: [
            { objectId: 'dom-order', inDegree: 1, outDegree: 1 },
            { objectId: 'dom-payment', inDegree: 1, outDegree: 1 },
          ],
        }),
      });
      return;
    }

    if (level === 'SERVICE_TO_SERVICE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: [],
          edges: [
            { id: 's2s-1', source: 'svc-order', target: 'svc-payment', relationType: 'call' },
          ],
          graphStats: [
            { objectId: 'svc-order', inDegree: 1, outDegree: 1 },
            { objectId: 'svc-payment', inDegree: 1, outDegree: 1 },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nodes: [], edges: [], graphStats: [] }),
    });
  });

  await page.route('**/api/relations?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'rel-call-1', subjectObjectId: 'svc-order', objectId: 'ep-payment-charge', relationType: 'call' },
        { id: 'rel-expose-1', subjectObjectId: 'svc-payment', objectId: 'ep-payment-charge', relationType: 'expose' },
      ]),
    });
  });

  await page.goto('/mapping-graph');

  await expect(page.getByRole('button', { name: '도메인 ↔ 도메인' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Domain', exact: true })).toBeVisible();
  await expect(page.getByTestId('mapping-graph-e2e-node-actions')).toBeVisible();

  await expect
    .poll(async () => page.getByTestId('mapping-graph-e2e-node-action').count(), { timeout: 15000 })
    .toBe(2);

  await page.locator('[data-testid="mapping-graph-e2e-node-action"][data-node-id="dom-order"]').click();

  await expect(page.getByRole('button', { name: 'Order Domain' })).toBeVisible();
  await expect(page.getByRole('button', { name: '서비스 ↔ 서비스' })).toBeVisible();
  await expect
    .poll(async () => page.getByTestId('mapping-graph-e2e-node-action').count(), { timeout: 15000 })
    .toBe(1);

  await page.locator('[data-testid="mapping-graph-e2e-node-action"][data-node-id="svc-order"]').click();
  await expect(page.getByText('← Inbound')).toBeVisible();
  await expect(page.locator('span[title="Order Service"]')).toBeVisible();

  await page.getByRole('button', { name: /상위로/ }).click();
  await expect(page.getByText('← Inbound')).toHaveCount(0);

  await page.getByRole('button', { name: /상위로/ }).click();
  await expect(page.getByRole('button', { name: 'Order Domain' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Domain', exact: true })).toBeVisible();
});
