// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  proofStatesMock,
  proofFrontiersMock,
  interactionIntentsMock,
  proofPatchesMock,
  proofStepsMock,
  objectsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  proofStatesMock: { table: 'proof_states', workspaceId: 'workspace_id', id: 'id' },
  proofFrontiersMock: { table: 'proof_frontiers', workspaceId: 'workspace_id', proofStateId: 'proof_state_id', createdAt: 'created_at', id: 'id' },
  interactionIntentsMock: { table: 'interaction_intents', workspaceId: 'workspace_id', id: 'id' },
  proofPatchesMock: { table: 'proof_patches', workspaceId: 'workspace_id', proofStateId: 'proof_state_id', createdAt: 'created_at', id: 'id' },
  proofStepsMock: { table: 'proof_steps', proofStateId: 'proof_state_id', stepOrder: 'step_order' },
  objectsMock: { table: 'objects', workspaceId: 'workspace_id', id: 'id', objectType: 'object_type' },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  proofStates: proofStatesMock,
  proofFrontiers: proofFrontiersMock,
  interactionIntents: interactionIntentsMock,
  proofPatches: proofPatchesMock,
  proofSteps: proofStepsMock,
  objects: objectsMock,
}));

import { GET } from '@/app/api/inference/frontiers/[proofStateId]/route';

function createDbMock() {
  const serviceRows = [
    { id: 'svc-a', name: 'consumer-svc', objectType: 'service', parentId: null },
    { id: 'svc-b', name: 'provider-svc', objectType: 'service', parentId: null },
    { id: 'svc-c', name: 'provider-candidate', objectType: 'service', parentId: null },
  ];
  let objectWhereCallCount = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: { table: string }) => {
        if (table.table === 'proof_states') {
          return {
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{
                id: 'proof-1',
                intentId: 'intent-1',
                status: 'FRONTIER',
                proofType: 'http_call',
                consumerServiceId: 'svc-a',
                sourceFunctionId: null,
                providerServiceId: 'svc-b',
                methodResolved: 'GET',
                externalPathResolved: '/orders/{id}',
                internalPathResolved: '/internal/orders/{id}',
                confidence: 0.33,
              }]),
            })),
          };
        }
        if (table.table === 'proof_frontiers') {
          return {
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{
                proofStateId: 'proof-1',
                frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
                frontierClass: 'TARGET',
                retryStrategy: 'manual_review',
                priority: 100,
                detail: {
                  candidateProviderIds: ['svc-b', 'svc-c'],
                },
              }]),
            })),
          };
        }
        if (table.table === 'interaction_intents') {
          return {
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{
                id: 'intent-1',
                intentType: 'http_gateway_route',
                targetServiceHint: 'provider',
                gatewayKind: 'spring_cloud_gateway',
                externalRoutePattern: '/api/orders/**',
              }]),
            })),
          };
        }
        if (table.table === 'proof_patches') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([]),
              })),
            })),
          };
        }
        if (table.table === 'proof_steps') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([{
                  id: 'step-1',
                  stepOrder: 9,
                  stepType: 'resolve_provider',
                  status: 'FAILED',
                  message: 'provider ambiguous',
                  inputSnapshot: {},
                  outputSnapshot: {},
                }]),
              })),
            })),
          };
        }
        if (table.table === 'objects') {
          return {
            where: vi.fn(() => {
              objectWhereCallCount += 1;
              if (objectWhereCallCount === 1) {
                return Promise.resolve([
                  { id: 'svc-b', name: 'provider-svc', objectType: 'service', parentId: null },
                  { id: 'svc-c', name: 'provider-candidate', objectType: 'service', parentId: null },
                ]);
              }
              if (objectWhereCallCount === 2) {
                return {
                  limit: vi.fn().mockResolvedValue(serviceRows),
                };
              }
              if (objectWhereCallCount === 3) {
                return {
                  limit: vi.fn().mockResolvedValue([{ id: 'svc-a', name: 'consumer-svc' }]),
                };
              }
              return {
                limit: vi.fn().mockResolvedValue([{ id: 'svc-b', name: 'provider-svc' }]),
              };
            }),
          };
        }
        throw new Error(`unexpected table ${table.table}`);
      }),
      limit: vi.fn().mockResolvedValue(serviceRows),
    })),
  };
}

describe('GET /api/inference/frontiers/[proofStateId]', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await GET(
      new Request('http://localhost/api/inference/frontiers/proof-1') as never,
      { params: Promise.resolve({ proofStateId: 'proof-1' }) },
    );
    expect(response.status).toBe(400);
  });

  it('frontier 상세와 patchableActions를 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());
    const response = await GET(
      new Request('http://localhost/api/inference/frontiers/proof-1?workspaceId=ws-1') as never,
      { params: Promise.resolve({ proofStateId: 'proof-1' }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      proofStateId: 'proof-1',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      patchableActions: ['provider_service_selection'],
      gatewayKind: 'spring_cloud_gateway',
      externalRoutePattern: '/api/orders/**',
      candidateServices: expect.arrayContaining([
        expect.objectContaining({ id: 'svc-b' }),
      ]),
      recentProofSteps: expect.arrayContaining([
        expect.objectContaining({ id: 'step-1', stepType: 'resolve_provider' }),
      ]),
    }));
  });
});
