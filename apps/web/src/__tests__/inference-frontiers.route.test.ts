// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  proofFrontiersMock,
  proofStatesMock,
  interactionIntentsMock,
  objectsMock,
  proofPatchesMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  proofFrontiersMock: { table: 'proof_frontiers', workspaceId: 'workspace_id', frontierReason: 'frontier_reason', proofStateId: 'proof_state_id', priority: 'priority', updatedAt: 'updated_at' },
  proofStatesMock: { table: 'proof_states', workspaceId: 'workspace_id', id: 'id' },
  interactionIntentsMock: { table: 'interaction_intents', workspaceId: 'workspace_id', id: 'id' },
  objectsMock: { table: 'objects', workspaceId: 'workspace_id', id: 'id', name: 'name' },
  proofPatchesMock: { table: 'proof_patches', workspaceId: 'workspace_id', proofStateId: 'proof_state_id', createdAt: 'created_at', id: 'id' },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  proofFrontiers: proofFrontiersMock,
  proofStates: proofStatesMock,
  interactionIntents: interactionIntentsMock,
  objects: objectsMock,
  proofPatches: proofPatchesMock,
}));

import { GET } from '@/app/api/inference/frontiers/route';

function createDbMock(input: {
  frontiers?: unknown[];
  states?: unknown[];
  intents?: unknown[];
  objects?: unknown[];
  patches?: unknown[];
}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: { table: string }) => {
        if (table.table === 'proof_frontiers') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(input.frontiers ?? []),
            })),
          };
        }
        if (table.table === 'proof_states') {
          return {
            where: vi.fn().mockResolvedValue(input.states ?? []),
          };
        }
        if (table.table === 'interaction_intents') {
          return {
            where: vi.fn().mockResolvedValue(input.intents ?? []),
          };
        }
        if (table.table === 'objects') {
          return {
            where: vi.fn().mockResolvedValue(input.objects ?? []),
          };
        }
        if (table.table === 'proof_patches') {
          return {
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(input.patches ?? []),
            })),
          };
        }
        throw new Error(`unexpected table ${table.table}`);
      }),
    })),
  };
}

describe('GET /api/inference/frontiers', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await GET(new Request('http://localhost/api/inference/frontiers'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'workspaceId is required' });
  });

  it('frontier 목록과 latestPatch를 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock({
      frontiers: [{
        proofStateId: 'proof-1',
        frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
        frontierClass: 'TARGET',
        retryStrategy: 'manual_review',
        priority: 120,
        detail: { candidateProviderIds: ['svc-b'] },
      }],
      states: [{
        id: 'proof-1',
        intentId: 'intent-1',
        consumerServiceId: 'svc-a',
        sourceFunctionId: 'fn-a',
        providerServiceId: 'svc-b',
        status: 'FRONTIER',
        methodResolved: 'GET',
        externalPathResolved: '/orders/{id}',
        internalPathResolved: '/internal/orders/{id}',
        confidence: 0.42,
      }],
      intents: [{ id: 'intent-1', intentType: 'http_call' }],
      objects: [
        { id: 'svc-a', name: 'orders-consumer' },
        { id: 'fn-a', name: 'fetchOrders' },
        { id: 'svc-b', name: 'orders-provider' },
      ],
      patches: [{
        id: 'patch-1',
        proofStateId: 'proof-1',
        patchType: 'provider_service_selection',
        validationStatus: 'PENDING',
        sourceKind: 'manual',
        createdAt: '2026-04-15T00:00:00.000Z',
      }],
    }));

    const response = await GET(new Request('http://localhost/api/inference/frontiers?workspaceId=ws-1'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([expect.objectContaining({
      proofStateId: 'proof-1',
      intentType: 'http_call',
      sourceServiceName: 'orders-consumer',
      providerServiceName: 'orders-provider',
      frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
      latestPatch: expect.objectContaining({
        id: 'patch-1',
        patchType: 'provider_service_selection',
      }),
    })]);
  });
});
