import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_NAME = 's1-e2e-workspace';

function ok(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function bootstrapWorkspace(
  page: Page,
  {
    workspaceId = WORKSPACE_ID,
    workspaceName = WORKSPACE_NAME,
  }: {
    workspaceId?: string;
    workspaceName?: string;
  } = {},
) {
  await page.addInitScript((workspaceId) => {
    window.localStorage.setItem(
      'archi-navi:workspace',
      JSON.stringify({
        state: { workspaceId },
        version: 0,
      }),
    );
  }, workspaceId);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill(
      ok([
        {
          id: workspaceId,
          name: workspaceName,
          createdAt: '2026-03-29T00:00:00.000Z',
        },
      ]),
    );
  });
}

async function pickObject(
  page: Page,
  {
    label,
    search,
    optionLabel,
    optionName,
  }: {
    label: string;
    search: string;
    optionLabel: string;
    optionName: string;
  },
) {
  const picker = page.getByText(label, { exact: true }).locator('xpath=..');

  await picker.getByPlaceholder('Object 이름 검색...').fill(search);
  await picker.getByRole('button', {
    name: new RegExp(
      `${escapeRegExp(optionLabel)}\\s+${escapeRegExp(optionName)}`,
    ),
  }).click();
}

test('S1-2 /services 상세 sheet에서 displayName/description/visibility PATCH를 보낸다', async ({
  page,
}) => {
  await bootstrapWorkspace(page);

  const patchBodies: Array<Record<string, unknown>> = [];
  let displayName = '주문 서비스';
  let description = '기존 설명';
  let visibility = 'VISIBLE';

  await page.route(`**/api/objects?workspaceId=${WORKSPACE_ID}`, async (route) => {
    await route.fulfill(
      ok([
        {
          id: 'obj-1',
          name: 'orders-service',
          displayName,
          objectType: 'service',
          granularity: 'COMPOUND',
          visibility,
          parentId: null,
          depth: 0,
        },
      ]),
    );
  });

  await page.route(`**/api/objects/obj-1?workspaceId=${WORKSPACE_ID}`, async (route) => {
    await route.fulfill(
      ok({
        id: 'obj-1',
        name: 'orders-service',
        displayName,
        description,
        objectType: 'service',
        granularity: 'COMPOUND',
        visibility,
        parentId: null,
        depth: 0,
        outbound: [],
        inbound: [],
        children: [],
      }),
    );
  });

  await page.route(`**/api/objects/obj-1/tags?workspaceId=${WORKSPACE_ID}`, async (route) => {
    await route.fulfill(ok([]));
  });

  await page.route(`**/api/tags?workspaceId=${WORKSPACE_ID}`, async (route) => {
    await route.fulfill(ok([]));
  });

  await page.route('**/api/objects/obj-1', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    patchBodies.push(payload);

    if ('displayName' in payload) {
      displayName = String(payload.displayName ?? '');
    }
    if ('description' in payload) {
      description = String(payload.description ?? '');
    }
    if ('visibility' in payload) {
      visibility = String(payload.visibility ?? '');
    }

    await route.fulfill(ok({ ok: true }));
  });

  await page.goto('/services');

  const serviceCard = page.locator('.glass-card').filter({
    has: page.getByText('주문 서비스', { exact: true }),
  }).filter({
    has: page.getByText('orders-service', { exact: true }),
  }).first();
  await expect(serviceCard).toBeVisible();
  await serviceCard.click();

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('orders-service')).toBeVisible();

  const displayNameField = sheet.getByText('orders-service', { exact: true })
    .locator('xpath=preceding-sibling::*[1]');
  await displayNameField.click();
  const displayNameInput = sheet.getByPlaceholder('표시 이름 입력...');
  await expect(displayNameInput).toHaveValue('주문 서비스');
  await displayNameInput.fill('주문 서비스 v2');
  await displayNameInput.press('Enter');

  await expect.poll(() => patchBodies.length).toBe(1);
  expect(patchBodies[0]).toEqual({
    workspaceId: WORKSPACE_ID,
    displayName: '주문 서비스 v2',
  });
  await expect(displayNameField).toContainText('주문 서비스 v2');

  await sheet.getByText('기존 설명').click();
  const descriptionInput = sheet.getByPlaceholder('설명을 입력하세요...');
  await expect(descriptionInput).toHaveValue('기존 설명');
  await descriptionInput.fill('변경된 설명');
  await sheet.getByLabel('인라인 저장').click();

  await expect.poll(() => patchBodies.length).toBe(2);
  expect(patchBodies[1]).toEqual({
    workspaceId: WORKSPACE_ID,
    description: '변경된 설명',
  });
  await expect(sheet.getByText('변경된 설명')).toBeVisible();

  const visibilityToggle = sheet.getByRole('button', { name: '가시성 전환' });
  await expect(visibilityToggle).toContainText('VISIBLE');
  await visibilityToggle.click();

  await expect.poll(() => patchBodies.length).toBe(3);
  expect(patchBodies[2]).toEqual({
    workspaceId: WORKSPACE_ID,
    visibility: 'HIDDEN',
  });
  await expect(sheet.getByText('HIDDEN')).toBeVisible();
});

test('S1-4 /query PATH_DISCOVERY 요청 본문과 경로 결과를 검증한다', async ({ page }) => {
  await bootstrapWorkspace(page);

  let queryBody: Record<string, unknown> | null = null;

  await page.route(`**/api/objects?workspaceId=${WORKSPACE_ID}`, async (route) => {
    await route.fulfill(
      ok([
        {
          id: 'obj-orders',
          name: 'orders-service',
          displayName: 'Orders API',
          objectType: 'service',
        },
        {
          id: 'obj-billing',
          name: 'billing-service',
          displayName: 'Billing API',
          objectType: 'service',
        },
      ]),
    );
  });

  await page.route('**/api/query', async (route) => {
    queryBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill(
      ok({
        queryType: 'PATH_DISCOVERY',
        result: {
          nodes: [
            {
              id: 'obj-orders',
              type: 'service',
              name: 'orders-service',
              displayName: 'Orders API',
              depth: 0,
            },
            {
              id: 'obj-billing',
              type: 'service',
              name: 'billing-service',
              displayName: 'Billing API',
              depth: 0,
            },
          ],
          edges: [
            {
              subjectId: 'obj-orders',
              objectId: 'obj-billing',
              relationType: 'depend_on',
              level: 'SERVICE_TO_SERVICE',
              edgeWeight: 1,
              confidence: 0.92,
            },
          ],
          paths: [
            {
              pathId: 'path-1',
              nodeIds: ['obj-orders', 'obj-billing'],
              score: 0.92,
            },
          ],
        },
      }),
    );
  });

  await page.goto('/query');

  await page.getByRole('button', { name: '경로 탐색' }).click();

  await pickObject(page, {
    label: '시작 Object',
    search: 'Orders',
    optionLabel: 'Orders API',
    optionName: 'orders-service',
  });
  await pickObject(page, {
    label: '도착 Object',
    search: 'Billing',
    optionLabel: 'Billing API',
    optionName: 'billing-service',
  });

  await page.getByRole('button', { name: '쿼리 실행' }).click();

  await expect.poll(() => queryBody).not.toBeNull();
  expect(queryBody).toEqual({
    workspaceId: WORKSPACE_ID,
    queryType: 'PATH_DISCOVERY',
    scope: {
      level: 'SERVICE_TO_SERVICE',
      visibility: 'VISIBLE_ONLY',
    },
    params: {
      fromObjectId: 'obj-orders',
      toObjectId: 'obj-billing',
      maxHops: 3,
    },
  });

  await expect(page.getByText('노드 2개 · 엣지 1개 · 경로 1개')).toBeVisible();
  await expect(page.getByRole('heading', { name: '경로 (1)' })).toBeVisible();
  await expect(page.getByText('Orders API').last()).toBeVisible();
  await expect(page.getByText('Billing API').last()).toBeVisible();
});

test('S1-5 /inference-runs가 실제 시드 run의 상세 sources/events를 브라우저에서 확장 표시한다', async ({
  request,
  page,
}) => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const workspaceName = 'Default Workspace';

  const resetWorkspace = await request.post('/api/dev/reset', {
    data: { workspaceId },
  });
  expect(resetWorkspace.ok()).toBeTruthy();

  await bootstrapWorkspace(page, { workspaceId, workspaceName });

  const fixtureRepoRoot = path.resolve(__dirname, '..', 'fixtures', 'inference-config');
  const createRun = await request.post('/api/inference/runs', {
    headers: {
      authorization: 'Bearer secret-token',
    },
    data: {
      workspaceId,
      triggerType: 'E2E_DETAIL',
      modes: ['config'],
      repoRoots: [fixtureRepoRoot],
      useServiceMetadataPaths: false,
    },
  });
  expect(createRun.ok()).toBeTruthy();

  const { runId } = (await createRun.json()) as { runId: string };
  expect(runId).toBeTruthy();

  await page.goto('/inference-runs');

  await expect(page.getByRole('heading', { name: '추론 이력' })).toBeVisible();

  const runCard = page.locator('.glass-card').filter({
    has: page.getByText('E2E_DETAIL', { exact: true }),
  }).first();
  await expect(runCard).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: '새로고침' })).toBeVisible();

  await runCard.locator('button').first().click();

  await expect(runCard.getByText('소스 (1)', { exact: true })).toBeVisible();
  await expect(runCard.getByText(fixtureRepoRoot, { exact: true })).toBeVisible();
  await expect(runCard.getByText('이벤트 로그', { exact: false })).toBeVisible();
  await expect(runCard.getByText('Inference run이 생성되었습니다.', { exact: true })).toBeVisible();
});
