import path from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

async function createService(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const res = await request.post('/api/objects', {
    data: {
      workspaceId: WORKSPACE_ID,
      objectType: 'service',
      granularity: 'COMPOUND',
      name,
      displayName: name,
    },
  });
  expect(res.ok()).toBeTruthy();
  const json = (await res.json()) as { id: string };
  expect(json.id).toBeTruthy();
  return json.id;
}

test('추론→승인→롤업→쿼리→채팅 카드 렌더링 시나리오', async ({ request, page }) => {
  await test.step('워크스페이스 초기화', async () => {
    const reset = await request.post('/api/dev/reset', {
      data: { workspaceId: WORKSPACE_ID },
    });
    expect(reset.ok()).toBeTruthy();
  });

  let orderServiceId = '';
  let paymentServiceId = '';

  await test.step('서비스 오브젝트 생성 + config 추론 실행', async () => {
    orderServiceId = await createService(request, 'order-service');
    paymentServiceId = await createService(request, 'payment-service');

    const fixtureRepoRoot = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'inference-config',
    );

    const infer = await request.post('/api/inference/run', {
      data: {
        workspaceId: WORKSPACE_ID,
        modes: ['config'],
        repoRoots: [fixtureRepoRoot],
        useServiceMetadataPaths: false,
      },
    });
    expect(infer.ok()).toBeTruthy();

    const inferJson = (await infer.json()) as {
      ok: boolean;
      summary?: { relationCandidatesCreated?: number };
    };
    expect(inferJson.ok).toBe(true);
    expect(inferJson.summary?.relationCandidatesCreated ?? 0).toBeGreaterThan(0);
  });

  let approvedCandidateId = '';

  await test.step('관계 후보 승인', async () => {
    const candidatesRes = await request.get(
      `/api/inference/candidates?workspaceId=${WORKSPACE_ID}&status=PENDING`,
    );
    expect(candidatesRes.ok()).toBeTruthy();
    const candidates = (await candidatesRes.json()) as Array<{
      id: string;
      subjectName: string;
      relationType: string;
      objectName: string;
    }>;

    const target = candidates.find(
      (c) =>
        c.relationType === 'depend_on' &&
        c.subjectName.includes('order-service') &&
        c.objectName.includes('payment-service'),
    );
    expect(target).toBeTruthy();
    approvedCandidateId = target!.id;

    const approve = await request.patch(
      `/api/inference/candidates/${approvedCandidateId}`,
      {
        data: { status: 'APPROVED' },
      },
    );
    expect(approve.ok()).toBeTruthy();

    const approveJson = (await approve.json()) as { success: boolean };
    expect(approveJson.success).toBe(true);
  });

  await test.step('롤업 재빌드 + Query 검증(경로/근거)', async () => {
    const rebuild = await request.post('/api/rollups', {
      data: { workspaceId: WORKSPACE_ID },
    });
    expect(rebuild.ok()).toBeTruthy();
    const rebuildJson = (await rebuild.json()) as {
      ok: boolean;
      generationVersion: number;
    };
    expect(rebuildJson.ok).toBe(true);
    expect(rebuildJson.generationVersion).toBeGreaterThan(0);

    const query = await request.post('/api/query', {
      data: {
        workspaceId: WORKSPACE_ID,
        queryType: 'PATH_DISCOVERY',
        scope: {
          level: 'SERVICE_TO_SERVICE',
          visibility: 'VISIBLE_ONLY',
        },
        params: {
          fromObjectId: orderServiceId,
          toObjectId: paymentServiceId,
          maxHops: 4,
          topK: 3,
        },
      },
    });
    expect(query.ok()).toBeTruthy();

    const queryJson = (await query.json()) as {
      result: {
        edges: Array<{ provenance?: { baseRelationIds?: string[] } }>;
        paths?: unknown[];
      };
    };
    expect(queryJson.result.paths?.length ?? 0).toBeGreaterThan(0);
    expect(queryJson.result.edges.length).toBeGreaterThan(0);

    const hasProvenance = queryJson.result.edges.some(
      (edge) => (edge.provenance?.baseRelationIds?.length ?? 0) > 0,
    );
    expect(hasProvenance).toBe(true);
  });

  await test.step('채팅 카드 렌더링 검증', async () => {
    await page.goto('/architecture');

    await page.locator('button[title^="AI 채팅"]').click();
    await page.getByPlaceholder('질문을 입력하세요...').fill('order-service가 의존하는 서비스는?');
    await page.getByPlaceholder('질문을 입력하세요...').press('Enter');

    await expect(page.getByText('결론', { exact: true })).toBeVisible();
    await expect(page.getByText('신뢰도', { exact: true })).toBeVisible();
    await expect(page.getByText('order-service는 payment-service에 의존합니다.')).toBeVisible();
  });
});
