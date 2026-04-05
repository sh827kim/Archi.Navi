import { test, expect, type Page, type Route } from '@playwright/test';

const WORKSPACE_ID = '44444444-4444-4444-4444-444444444444';

type Candidate = {
  id: string;
  subjectName: string;
  subjectGranularity: 'COMPOUND' | 'ATOMIC';
  subjectParentName: string | null;
  subjectObjectType: string | null;
  relationType: string;
  objectName: string;
  objectGranularity: 'COMPOUND' | 'ATOMIC';
  objectParentName: string | null;
  objectObjectType: string | null;
  objectId: string;
  subjectObjectId: string;
  confidence: number;
  source: string;
  status: 'PENDING';
  llmExplanation?: {
    summary: string;
  };
  crossValidation?: {
    validated: boolean;
    supportCount: number;
    supportingSources: string[];
    contradictions?: Array<{
      ruleId: string;
      type: 'PHANTOM_CALL' | 'STALE_CONFIG' | 'DEAD_TOPIC' | 'ORPHAN_FK';
      penalty: number;
    }>;
  };
  metadata?: {
    targetType?: 'service';
    analysisMode?: string;
    fallbackReason?: 'PATH_NOT_MATCHED';
    fallbackContext?: {
      attemptedMethod: string;
      attemptedPath: string;
      evidenceSummary?: string;
    };
    [key: string]: unknown;
  };
};

function createCandidate(
  id: string,
  objectName: string,
  options?: Partial<Candidate>,
): Candidate {
  return {
    id,
    subjectName: `caller-${id}`,
    subjectGranularity: 'COMPOUND',
    subjectParentName: null,
    subjectObjectType: 'service',
    relationType: 'call',
    objectName,
    objectGranularity: 'COMPOUND',
    objectParentName: null,
    objectObjectType: 'service',
    objectId: `service-${id}`,
    subjectObjectId: `caller-${id}`,
    confidence: 0.82,
    source: 'INFERRED',
    status: 'PENDING',
    ...options,
  };
}

async function bootstrapWorkspace(page: Page) {
  await page.addInitScript((workspaceId) => {
    window.localStorage.setItem(
      'archi-navi:workspace',
      JSON.stringify({ state: { workspaceId }, version: 0 }),
    );
  }, WORKSPACE_ID);
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installApprovalBaseRoutes(page: Page) {
  await page.route('**/api/workspaces', async (route) => {
    await fulfillJson(route, [
      { id: WORKSPACE_ID, name: 'approval-e2e-workspace', createdAt: new Date().toISOString() },
    ]);
  });

  await page.route('**/api/inference/domain-candidates?*', async (route) => {
    await fulfillJson(route, []);
  });

  await page.route('**/api/scan/paths?*', async (route) => {
    await fulfillJson(route, {
      paths: ['/mock/repo/apps/order-service'],
      parentDirs: ['/mock/repo'],
    });
  });
}

test('S1-6: approval pagination은 더 보기 append 후 경고 필터를 유지한다', async ({ page }) => {
  const firstPage = Array.from({ length: 200 }, (_, index) =>
    createCandidate(`cand-${index}`, `service-${index}`),
  );
  const secondPage = [
    createCandidate('cand-late-warning', 'late-warning', {
      crossValidation: {
        validated: false,
        supportCount: 1,
        supportingSources: ['code'],
        contradictions: [{ ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 }],
      },
    }),
  ];

  await bootstrapWorkspace(page);
  await installApprovalBaseRoutes(page);

  await page.route('**/api/inference/candidates?*', async (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get('offset');
    if (offset === '0') {
      await fulfillJson(route, firstPage);
      return;
    }
    if (offset === '200') {
      await fulfillJson(route, secondPage);
      return;
    }
    throw new Error(`Unexpected offset: ${offset}`);
  });

  await page.goto('/approval');

  await expect(page.getByRole('heading', { name: '승인 대기', exact: true })).toBeVisible();
  await expect(page.getByTestId('approval-candidate-card')).toHaveCount(200);
  await expect(
    page.locator('[data-testid="approval-candidate-card"][data-candidate-id="cand-late-warning"]'),
  ).toHaveCount(0);

  await page.getByRole('button', { name: /더 보기/ }).click();

  await expect(page.getByTestId('approval-candidate-card')).toHaveCount(201);
  await expect(
    page.locator('[data-testid="approval-candidate-card"][data-candidate-id="cand-late-warning"]'),
  ).toBeVisible();

  await page.getByLabel('교차 검증 필터').selectOption('warnings');

  await expect(page.getByTestId('approval-candidate-card')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="approval-candidate-card"][data-candidate-id="cand-late-warning"]'),
  ).toBeVisible();
  await expect(page.getByText('service-0')).toHaveCount(0);
});

test('S1-1b: llm-boost 모드에서 /api/inference/run body에 llmBoost.enabled=true를 보낸다', async ({ page }) => {
  let inferenceRunBody: Record<string, unknown> | null = null;
  let candidatePayload: Candidate[] = [];

  await bootstrapWorkspace(page);
  await installApprovalBaseRoutes(page);

  await page.route('**/api/inference/candidates?*', async (route) => {
    await fulfillJson(route, candidatePayload);
  });

  await page.route('**/api/inference/run', async (route) => {
    inferenceRunBody = route.request().postDataJSON() as Record<string, unknown>;
    candidatePayload = [createCandidate('cand-llm-boost', 'llm-boost-service')];
    await fulfillJson(route, {
      summary: { relationCandidatesCreated: 1 },
      results: {
        code: {
          enginesUsed: ['ast'],
          fallbackCount: 0,
          scanFailures: [],
          signalCount: 2,
        },
        config: { processedFileCount: 1 },
      },
      llmBoost: { codeIntentAnalysis: { generatedCount: 1 } },
      warnings: [],
    });
  });

  await page.goto('/approval');

  await expect(page.getByText('현재 필터 조건에 맞는 승인 후보가 없습니다.')).toBeVisible();
  await page.getByLabel('추론 모드').selectOption('llm-boost');
  await page.getByRole('button', { name: '추론 실행' }).click();

  await expect(page.getByText('llm-boost-service')).toBeVisible();
  expect(inferenceRunBody).toMatchObject({
    workspaceId: WORKSPACE_ID,
    useServiceMetadataPaths: true,
    repoRoots: ['/mock/repo'],
    llmBoost: {
      enabled: true,
      codeIntentAnalysis: true,
      generateExplanations: true,
    },
  });
});

test('S1-1c: LLM 평가가 /api/inference/llm-filter를 호출하고 설명이 반영된 UI로 새로고침된다', async ({ page }) => {
  let llmFilterCallCount = 0;
  let candidatePayload: Candidate[] = [
    createCandidate('cand-llm-filter', 'llm-filter-target'),
  ];

  await bootstrapWorkspace(page);
  await installApprovalBaseRoutes(page);

  await page.route('**/api/inference/candidates?*', async (route) => {
    await fulfillJson(route, candidatePayload);
  });

  await page.route('**/api/inference/llm-filter', async (route) => {
    llmFilterCallCount += 1;
    candidatePayload = [
      createCandidate('cand-llm-filter', 'llm-filter-target', {
        llmExplanation: {
          summary: 'LLM이 llm-filter-target 호출 근거를 확인했습니다.',
        },
      }),
    ];
    await fulfillJson(route, { filtered: 1, explained: 1 });
  });

  await page.goto('/approval');

  await expect(page.getByText('llm-filter-target')).toBeVisible();
  await page.getByRole('button', { name: 'LLM 평가' }).click();

  await expect(page.getByText('LLM이 llm-filter-target 호출 근거를 확인했습니다.')).toBeVisible();
  expect(llmFilterCallCount).toBe(1);
});

test('S1-1a: Smart 모드가 /api/inference/smart를 호출하고 proof summary viewer와 fallback hint를 노출한다', async ({ page }) => {
  let smartRequestBody: Record<string, unknown> | null = null;
  let candidatePayload: Candidate[] = [];

  await bootstrapWorkspace(page);
  await installApprovalBaseRoutes(page);

  await page.route('**/api/inference/candidates?*', async (route) => {
    await fulfillJson(route, candidatePayload);
  });

  await page.route('**/api/inference/smart?*', async (route) => {
    await fulfillJson(route, {
      success: true,
      run: {
        id: 'smart-run-1',
        status: 'SUCCEEDED',
        stats: {
          proofSummary: {
            engine: 'intent_proof',
            intentCount: 3,
            proofClosedAtomicCount: 0,
            proofFrontierCount: 1,
            proofRejectedCount: 2,
            projectedCandidateCount: 0,
            agentFrontierCount: 1,
            agentPatchedFrontierCount: 0,
            frontierBreakdown: {
              PATH_NOT_MATCHED: 1,
            },
            targetBreakdown: {
              service: 1,
            },
          },
        },
      },
    });
  });

  await page.route('**/api/inference/smart', async (route) => {
    smartRequestBody = route.request().postDataJSON() as Record<string, unknown>;
    candidatePayload = [
      createCandidate('cand-smart-fallback', 'orders-service', {
        metadata: {
          targetType: 'service',
          fallbackReason: 'PATH_NOT_MATCHED',
          fallbackContext: {
            attemptedMethod: 'GET',
            attemptedPath: '/api/orders/missing',
            evidenceSummary: 'fetch("http://orders/api/orders/missing")',
          },
        },
      }),
    ];
    await fulfillJson(route, {
      success: true,
      queued: true,
      runId: 'smart-run-1',
      run: {
        id: 'smart-run-1',
        status: 'QUEUED',
      },
    });
  });

  await page.goto('/approval');

  await expect(page.getByRole('heading', { name: '승인 대기', exact: true })).toBeVisible();
  await page.getByLabel('추론 모드').selectOption('smart');
  await page.getByRole('button', { name: '추론 실행' }).click();

  await expect(page.getByTestId('smart-trace-viewer')).toBeVisible();
  await expect(page.getByTestId('smart-trace-viewer')).toContainText('Intent Proof Summary');
  await expect(page.getByTestId('smart-trace-viewer')).toContainText('intent 3개');
  await expect(page.getByTestId('smart-trace-viewer')).toContainText('frontier 1개');
  await expect(page.getByTestId('smart-trace-viewer')).toContainText('Frontier breakdown: PATH_NOT_MATCHED 1개');

  const fallbackCard = page.locator(
    '[data-testid="approval-candidate-card"][data-candidate-id="cand-smart-fallback"]',
  );
  await expect(fallbackCard).toContainText('Smart fallback');
  await expect(fallbackCard).toContainText('시도 호출 GET /api/orders/missing');
  await expect(fallbackCard).toContainText('근거 fetch("http://orders/api/orders/missing")');

  expect(smartRequestBody).toMatchObject({
    workspaceId: WORKSPACE_ID,
    repoRoots: ['/mock/repo'],
    useServiceMetadataPaths: true,
    async: true,
  });
  expect(smartRequestBody).not.toHaveProperty('analysisMode');
});

test('S1-7: approval 화면에서 proof chain drill-down과 frontier queue를 노출한다', async ({ page }) => {
  const candidatePayload: Candidate[] = [
    createCandidate('cand-proof-chain', 'provider-orders', {
      metadata: {
        proof: {
          sourceService: 'gateway',
          sourceFunction: 'OrderController.getOrders',
          resolvedProviderEndpoint: { method: 'GET', path: '/orders' },
          routeChain: ['gateway', 'orders'],
          supportingEvidence: ['gateway.ts:42'],
          contradictions: [{ type: 'STALE_CONFIG' }],
          proofSteps: [
            { stepType: 'resolve_alias', status: 'ok' },
            { stepType: 'match_endpoint', status: 'ok' },
          ],
          frontierHistory: [
            {
              frontierReason: 'PATH_NOT_MATCHED',
              missingSlots: ['provider_path'],
              relevantSnippets: ['routes/order.ts'],
              lastResolutionStep: 'match_endpoint',
              retryable: true,
              hasAgentPatch: true,
            },
          ],
          patchHistory: [{ patchType: 'route_patch', status: 'APPLIED' }],
        },
      },
    }),
  ];

  await bootstrapWorkspace(page);
  await installApprovalBaseRoutes(page);
  await page.route('**/api/inference/candidates?*', async (route) => {
    await fulfillJson(route, candidatePayload);
  });

  await page.goto('/approval');

  await expect(page.getByTestId('frontier-queue')).toBeVisible();
  await expect(page.getByText('Frontier Queue (1)')).toBeVisible();
  await page.getByText('Proof chain drill-down').click();
  await expect(page.getByText('source function: OrderController.getOrders')).toBeVisible();
  await expect(page.getByText('resolved provider endpoint: GET /orders')).toBeVisible();
  await expect(page.getByText('frontier history: PATH_NOT_MATCHED')).toBeVisible();
});
