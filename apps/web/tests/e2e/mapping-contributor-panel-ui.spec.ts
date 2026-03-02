import { test, expect } from '@playwright/test';

const WORKSPACE_ID = '44444444-4444-4444-4444-444444444444';

test('Object Mapping 링크 선택 시 Contributor 패널이 열린다', async ({ page }) => {
  const objects = [
    {
      id: 'svc-order',
      name: 'order-service',
      displayName: 'Order Service',
      objectType: 'service',
      granularity: 'COMPOUND',
      parentId: null,
      depth: 0,
    },
    {
      id: 'svc-user',
      name: 'user-service',
      displayName: 'User Service',
      objectType: 'service',
      granularity: 'COMPOUND',
      parentId: null,
      depth: 0,
    },
  ];

  const edges = [
    { id: 'rollup-1', source: 'svc-order', target: 'svc-user', relationType: 'call' },
  ];

  await page.addInitScript((workspaceId) => {
    const persisted = { state: { workspaceId }, version: 0 };
    window.localStorage.setItem('archi-navi:workspace', JSON.stringify(persisted));
    window.localStorage.setItem('archi-navi:e2e-link-actions', '1');
  }, WORKSPACE_ID);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: WORKSPACE_ID, name: 'mapping-contributor-ui', createdAt: new Date().toISOString() },
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

  await page.route('**/api/mapping/contributors?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        summary: {
          totalCount: 1,
          byRelationType: { call: 1 },
        },
        groups: [
          {
            groupKey: 'User Service',
            weight: 1,
            relations: [
              {
                relationId: 'rel-1',
                relationType: 'call',
                confidence: 0.95,
                sourceAtomicId: 'a1',
                sourceAtomicLabel: 'GET /api/orders/:id',
                sourceCompoundId: 'svc-order',
                sourceCompoundLabel: 'Order Service',
                targetAtomicId: 'a2',
                targetAtomicLabel: 'GET /api/users/:id',
                targetCompoundId: 'svc-user',
                targetCompoundLabel: 'User Service',
                evidenceCount: 1,
                evidences: [
                  {
                    id: 'ev-1',
                    evidenceType: 'FILE',
                    filePath: 'apps/order/src/order.ts',
                    lineStart: 10,
                    lineEnd: 20,
                    excerpt: 'client.get("/api/users/:id")',
                  },
                ],
              },
            ],
          },
        ],
        scopeMode: 'SUBTREE',
        pageInfo: {
          limit: 20,
          hasNext: false,
          nextCursor: null,
        },
      }),
    });
  });

  await page.goto('/mapping-graph');

  const linkAction = page.locator('[data-testid="mapping-graph-e2e-link-action"]').first();
  await expect(linkAction).toBeVisible();
  await linkAction.click();

  await expect(page.getByText('relation: call')).toBeVisible();
  await expect(page.getByText('Order Service → User Service')).toBeVisible();
  await expect(page.getByText('client.get("/api/users/:id")')).toBeVisible();
});
