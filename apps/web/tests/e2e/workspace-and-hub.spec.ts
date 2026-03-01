import { test, expect } from '@playwright/test';

const MOCK_WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';

test('워크스페이스 온보딩 마법사를 완료하면 architecture로 진입한다', async ({ page }) => {
  const workspaceName = `e2e-onboarding-${Date.now()}`;

  await page.goto('/workspaces/new');
  await expect(page.getByRole('heading', { name: '워크스페이스 생성' })).toBeVisible();

  await page.getByPlaceholder('예: 쇼핑몰 플랫폼').fill(workspaceName);

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('관계 추론 기본 가중치를 저장합니다.')).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('아키텍처 레이어를 초기 등록합니다.')).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('태그를 미리 등록합니다.')).toBeVisible();

  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('코드 스캔을 실행하거나 건너뛸 수 있습니다.')).toBeVisible();

  await page.getByRole('button', { name: '건너뛰고 완료' }).click();
  await expect(page).toHaveURL(/\/architecture/, { timeout: 20000 });

  await page.goto('/workspaces');
  await expect(page.getByRole('button', { name: new RegExp(workspaceName) }).first()).toBeVisible();
});

test('워크스페이스 목록 선택 시 architecture로 이동한다', async ({ request, page }) => {
  const workspaceName = `e2e-select-${Date.now()}`;
  const create = await request.post('/api/workspaces', {
    data: { name: workspaceName },
  });
  expect(create.ok()).toBeTruthy();

  await page.goto('/workspaces');
  const target = page.getByRole('button', { name: new RegExp(workspaceName) }).first();
  await expect(target).toBeVisible();
  await target.click();
  await expect(page).toHaveURL(/\/architecture/);
});

test('P3-2: Hub 접기/펼치기 토글이 노드 표시 수를 변경한다', async ({ page }) => {
  const objects = [
    { id: 'svc-hub', name: 'svc-hub', displayName: 'Hub Service', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
    { id: 'svc-a', name: 'svc-a', displayName: 'Service A', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
    { id: 'svc-b', name: 'svc-b', displayName: 'Service B', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
    { id: 'svc-c', name: 'svc-c', displayName: 'Service C', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
    { id: 'svc-d', name: 'svc-d', displayName: 'Service D', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
  ];

  const edges = [
    { id: 'e1', source: 'svc-a', target: 'svc-hub', relationType: 'call' },
    { id: 'e2', source: 'svc-b', target: 'svc-hub', relationType: 'call' },
    { id: 'e3', source: 'svc-c', target: 'svc-hub', relationType: 'call' },
    { id: 'e4', source: 'svc-d', target: 'svc-hub', relationType: 'call' },
    { id: 'e5', source: 'svc-hub', target: 'svc-a', relationType: 'depend_on' },
    { id: 'e6', source: 'svc-hub', target: 'svc-b', relationType: 'depend_on' },
  ];

  await page.addInitScript((workspaceId) => {
    const persisted = { state: { workspaceId }, version: 0 };
    window.localStorage.setItem('archi-navi:workspace', JSON.stringify(persisted));
    window.localStorage.setItem('archi-navi:rollup:hub-threshold', '5');
  }, MOCK_WORKSPACE_ID);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: MOCK_WORKSPACE_ID, name: 'hub-e2e-workspace', createdAt: new Date().toISOString() },
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
          edges,
          graphStats: [
            { objectId: 'svc-hub', inDegree: 120, outDegree: 80 },
            { objectId: 'svc-a', inDegree: 2, outDegree: 1 },
            { objectId: 'svc-b', inDegree: 2, outDegree: 1 },
            { objectId: 'svc-c', inDegree: 1, outDegree: 1 },
            { objectId: 'svc-d', inDegree: 1, outDegree: 1 },
          ],
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
  await expect(page.getByRole('button', { name: /Hub 접기/ })).toBeVisible();
  await expect
    .poll(async () => page.locator('g.node').count(), { timeout: 15000 })
    .toBe(5);

  await page.getByRole('button', { name: /Hub 접기/ }).click();
  await expect(page.getByRole('button', { name: /Hub 펼치기/ })).toBeVisible();
  await expect
    .poll(async () => page.locator('g.node').count(), { timeout: 15000 })
    .toBe(4);
});
