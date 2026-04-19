// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  validateAndApplyProofPatchMock,
  proofStatesMock,
  relationCandidatesMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  validateAndApplyProofPatchMock: vi.fn(),
  proofStatesMock: { table: 'proof_states', workspaceId: 'workspace_id', id: 'id' },
  relationCandidatesMock: { table: 'relation_candidates', workspaceId: 'workspace_id', id: 'id', metadata: 'metadata' },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  proofStates: proofStatesMock,
  relationCandidates: relationCandidatesMock,
}));

vi.mock('@archi-navi/inference', () => ({
  validateAndApplyProofPatch: validateAndApplyProofPatchMock,
}));

import { POST } from '@/app/api/inference/frontiers/[proofStateId]/patch/route';

function createDbMock(input?: { stateAfterStatus?: string }) {
  const stateAfterStatus = input?.stateAfterStatus ?? 'CLOSED_ATOMIC';
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: { table: string }) => {
        if (table.table === 'proof_states') {
          return {
            where: vi.fn(() => ({
              limit: vi.fn()
                .mockResolvedValueOnce([{ id: 'proof-1', status: 'FRONTIER' }])
                .mockResolvedValueOnce([{ id: 'proof-1', status: stateAfterStatus }]),
            })),
          };
        }
        if (table.table === 'relation_candidates') {
          return {
            where: vi.fn().mockResolvedValue([
              { id: 'cand-1', metadata: { proofStateId: 'proof-1' } },
              { id: 'cand-2', metadata: { proofStateId: 'other' } },
            ]),
          };
        }
        throw new Error(`unexpected table ${table.table}`);
      }),
    })),
  };
}

describe('POST /api/inference/frontiers/[proofStateId]/patch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('지원하지 않는 patchType이면 400을 반환해야 한다', async () => {
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          patchType: 'unsupported_patch',
          payload: {},
        }),
      }) as never,
      { params: Promise.resolve({ proofStateId: 'proof-1' }) },
    );
    expect(response.status).toBe(400);
  });

  it('patch 적용 결과와 candidate 반영 정보를 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock());
    validateAndApplyProofPatchMock.mockResolvedValue({
      patchId: 'patch-1',
      validationStatus: 'ACCEPTED',
      errors: [],
      resolution: { status: 'CLOSED_ATOMIC' },
    });

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          patchType: 'provider_service_selection',
          payload: { selectedServiceId: 'svc-b' },
        }),
      }) as never,
      { params: Promise.resolve({ proofStateId: 'proof-1' }) },
    );

    expect(response.status).toBe(200);
    expect(validateAndApplyProofPatchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        proofStateId: 'proof-1',
        patchType: 'provider_service_selection',
        sourceKind: 'manual',
      }),
    );
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      patchId: 'patch-1',
      validationStatus: 'ACCEPTED',
      createdOrUpdatedCandidateIds: ['cand-1'],
    }));
  });

  it('보류 저장이면 applyMode=defer와 PENDING 상태를 그대로 반환해야 한다', async () => {
    getDbMock.mockResolvedValue(createDbMock({ stateAfterStatus: 'FRONTIER' }));
    validateAndApplyProofPatchMock.mockResolvedValue({
      patchId: 'patch-pending-1',
      validationStatus: 'PENDING',
      errors: [],
      resolution: null,
    });

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          patchType: 'provider_service_selection',
          payload: { selectedServiceId: 'svc-b' },
          applyMode: 'defer',
        }),
      }) as never,
      { params: Promise.resolve({ proofStateId: 'proof-1' }) },
    );

    expect(response.status).toBe(200);
    expect(validateAndApplyProofPatchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        proofStateId: 'proof-1',
        patchType: 'provider_service_selection',
        sourceKind: 'manual',
        applyMode: 'defer',
      }),
    );
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      patchId: 'patch-pending-1',
      validationStatus: 'PENDING',
      proofStatus: 'FRONTIER',
      createdOrUpdatedCandidateIds: ['cand-1'],
    }));
  });
});
