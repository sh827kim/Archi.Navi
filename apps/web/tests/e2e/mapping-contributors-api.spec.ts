import { test, expect, type APIRequestContext } from '@playwright/test';

async function createService(
  request: APIRequestContext,
  workspaceId: string,
  name: string,
): Promise<string> {
  const res = await request.post('/api/objects', {
    data: {
      workspaceId,
      objectType: 'service',
      granularity: 'COMPOUND',
      name,
      displayName: name,
    },
  });
  expect(res.ok()).toBeTruthy();
  const json = (await res.json()) as { id: string };
  return json.id;
}

test('mapping contributors API returns grouped atomic contributors with evidence chain', async ({ request }) => {
  const workspaceName = `e2e-contrib-${Date.now()}`;
  const createWs = await request.post('/api/workspaces', { data: { name: workspaceName } });
  expect(createWs.ok()).toBeTruthy();
  const workspaceId = ((await createWs.json()) as { id: string }).id;

  const reset = await request.post('/api/dev/reset', { data: { workspaceId } });
  expect(reset.ok()).toBeTruthy();

  const orderServiceId = await createService(request, workspaceId, 'order-service');
  const paymentServiceId = await createService(request, workspaceId, 'payment-service');
  const relationRes = await request.post('/api/relations', {
    data: {
      workspaceId,
      subjectObjectId: orderServiceId,
      relationType: 'depend_on',
      objectId: paymentServiceId,
      confidence: 0.93,
    },
  });
  expect(relationRes.ok()).toBeTruthy();

  const contributorsRes = await request.get(
    `/api/mapping/contributors?workspaceId=${workspaceId}&sourceCompoundId=${orderServiceId}&targetCompoundId=${paymentServiceId}&groupBy=relationType`,
  );
  expect(contributorsRes.ok()).toBeTruthy();
  const contributorsJson = (await contributorsRes.json()) as {
    summary: { totalCount: number; byRelationType: Record<string, number> };
    groups: Array<{
      groupKey: string;
      weight: number;
      relations: Array<{
        relationType: string;
        evidenceCount: number;
        evidences: Array<{ evidenceType: string }>;
      }>;
    }>;
  };

  expect(contributorsJson.summary.totalCount).toBeGreaterThan(0);
  expect(contributorsJson.summary.byRelationType['depend_on'] ?? 0).toBeGreaterThan(0);
  expect(contributorsJson.groups.length).toBeGreaterThan(0);

  const relationGroup = contributorsJson.groups.find((group) => group.groupKey === 'depend_on');
  expect(relationGroup).toBeTruthy();
  expect(relationGroup!.relations.length).toBeGreaterThan(0);
  expect(Array.isArray(relationGroup!.relations[0]?.evidences)).toBe(true);
});

test('mapping contributors API supports scopeMode and additional groupBy options', async ({ request }) => {
  const workspaceName = `e2e-contrib-phase-b-${Date.now()}`;
  const createWs = await request.post('/api/workspaces', { data: { name: workspaceName } });
  expect(createWs.ok()).toBeTruthy();
  const workspaceId = ((await createWs.json()) as { id: string }).id;

  const reset = await request.post('/api/dev/reset', { data: { workspaceId } });
  expect(reset.ok()).toBeTruthy();

  const orderServiceId = await createService(request, workspaceId, 'order-service');
  const userServiceId = await createService(request, workspaceId, 'user-service');
  const paymentServiceId = await createService(request, workspaceId, 'payment-service');

  const relOrderToUser = await request.post('/api/relations', {
    data: {
      workspaceId,
      subjectObjectId: orderServiceId,
      relationType: 'call',
      objectId: userServiceId,
      confidence: 0.92,
    },
  });
  expect(relOrderToUser.ok()).toBeTruthy();

  const relPaymentToUser = await request.post('/api/relations', {
    data: {
      workspaceId,
      subjectObjectId: paymentServiceId,
      relationType: 'call',
      objectId: userServiceId,
      confidence: 0.91,
    },
  });
  expect(relPaymentToUser.ok()).toBeTruthy();

  const subtreeRes = await request.get(
    `/api/mapping/contributors?workspaceId=${workspaceId}&sourceCompoundId=${orderServiceId}&targetCompoundId=${userServiceId}&groupBy=sourceAtomic&scopeMode=SUBTREE`,
  );
  expect(subtreeRes.ok()).toBeTruthy();
  const subtreeJson = (await subtreeRes.json()) as {
    summary: { totalCount: number };
    groups: Array<{ groupKey: string }>;
    scopeMode: string;
  };
  expect(subtreeJson.scopeMode).toBe('SUBTREE');
  expect(subtreeJson.summary.totalCount).toBeGreaterThan(0);
  expect(subtreeJson.groups.some((group) => group.groupKey.includes('order-service'))).toBe(true);

  const globalRes = await request.get(
    `/api/mapping/contributors?workspaceId=${workspaceId}&sourceCompoundId=${orderServiceId}&targetCompoundId=${userServiceId}&groupBy=targetAtomic&scopeMode=GLOBAL`,
  );
  expect(globalRes.ok()).toBeTruthy();
  const globalJson = (await globalRes.json()) as {
    summary: { totalCount: number };
    groups: Array<{ groupKey: string }>;
    scopeMode: string;
  };
  expect(globalJson.scopeMode).toBe('GLOBAL');
  expect(globalJson.summary.totalCount).toBeGreaterThan(subtreeJson.summary.totalCount);
  expect(globalJson.groups.some((group) => group.groupKey.includes('user-service'))).toBe(true);

  const pagedRes = await request.get(
    `/api/mapping/contributors?workspaceId=${workspaceId}&sourceCompoundId=${orderServiceId}&targetCompoundId=${userServiceId}&groupBy=targetAtomic&scopeMode=GLOBAL&limit=1`,
  );
  expect(pagedRes.ok()).toBeTruthy();
  const pagedJson = (await pagedRes.json()) as {
    groups: Array<{ groupKey: string }>;
    pageInfo?: { hasNext: boolean; nextCursor: string | null };
  };
  expect(pagedJson.groups.length).toBe(1);
  expect(pagedJson.pageInfo).toBeTruthy();
  expect(typeof pagedJson.pageInfo?.hasNext).toBe('boolean');

  if (pagedJson.pageInfo?.nextCursor) {
    const nextRes = await request.get(
      `/api/mapping/contributors?workspaceId=${workspaceId}&sourceCompoundId=${orderServiceId}&targetCompoundId=${userServiceId}&groupBy=targetAtomic&scopeMode=GLOBAL&limit=1&cursor=${encodeURIComponent(pagedJson.pageInfo.nextCursor)}`,
    );
    expect(nextRes.ok()).toBeTruthy();
    const nextJson = (await nextRes.json()) as {
      groups: Array<{ groupKey: string }>;
    };
    expect(nextJson.groups.length).toBe(1);
    expect(nextJson.groups[0]?.groupKey).not.toBe(pagedJson.groups[0]?.groupKey);
  }
});
