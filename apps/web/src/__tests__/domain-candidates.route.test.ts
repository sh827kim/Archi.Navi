// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getDbMock,
  approveDomainCandidateMock,
  applyRollupChangesMock,
  createDomainAffinityChangedEventMock,
  domainCandidatesMock,
  objectsMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  approveDomainCandidateMock: vi.fn(),
  applyRollupChangesMock: vi.fn(),
  createDomainAffinityChangedEventMock: vi.fn(() => ({ type: 'domain-affinity-changed' })),
  domainCandidatesMock: {
    id: 'domain_candidates.id',
    workspaceId: 'domain_candidates.workspace_id',
    status: 'domain_candidates.status',
    objectId: 'domain_candidates.object_id',
    primaryDomainId: 'domain_candidates.primary_domain_id',
    affinityMap: 'domain_candidates.affinity_map',
  },
  objectsMock: {
    id: 'objects.id',
    workspaceId: 'objects.workspace_id',
    displayName: 'objects.display_name',
    name: 'objects.name',
  },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  domainCandidates: domainCandidatesMock,
  objects: objectsMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
}));

vi.mock('@archi-navi/inference', () => ({
  approveDomainCandidate: approveDomainCandidateMock,
}));

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createDomainAffinityChangedEvent: createDomainAffinityChangedEventMock,
}));

import { GET } from '@/app/api/inference/domain-candidates/route';
import { PATCH } from '@/app/api/inference/domain-candidates/[id]/route';

describe('domain candidates routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET은 Track A domain feedback metadata를 응답에 노출해야 한다', async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: async () => [{
                id: 'cand-1',
                objectId: 'svc-1',
                primaryDomainId: 'domain-1',
                purity: 0.92,
                affinityMap: { 'domain-1': 1 },
                signals: {
                  feedback: {
                    key: 'TRACK_A:domain-1:HIGH',
                    track: 'TRACK_A',
                    primaryDomainId: 'domain-1',
                    purityBucket: 'HIGH',
                    basePurity: 0.84,
                    adjustment: 0.08,
                    adjustedPurity: 0.92,
                    applied: true,
                    sampleCount: 12,
                  },
                },
                status: 'PENDING',
                createdAt: '2026-03-28T00:00:00.000Z',
              }],
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: async () => [
              { id: 'svc-1', displayName: 'Orders API', name: 'orders-api' },
              { id: 'domain-1', displayName: 'Orders', name: 'orders' },
            ],
          }),
        }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/domain-candidates?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual([
      expect.objectContaining({
        id: 'cand-1',
        objectName: 'Orders API',
        primaryDomainName: 'Orders',
        domainFeedback: {
          key: 'TRACK_A:domain-1:HIGH',
          track: 'TRACK_A',
          primaryDomainId: 'domain-1',
          purityBucket: 'HIGH',
          basePurity: 0.84,
          adjustment: 0.08,
          adjustedPurity: 0.92,
          applied: true,
          sampleCount: 12,
        },
      }),
    ]);
  });

  it('PATCH APPROVED는 approveDomainCandidate에 위임하고 rollup 반영까지 연결해야 한다', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              objectId: 'svc-1',
              primaryDomainId: 'domain-1',
              affinityMap: { 'domain-1': 1 },
            }],
          }),
        }),
      }),
    };
    getDbMock.mockResolvedValue(db);
    approveDomainCandidateMock.mockResolvedValue({
      success: true,
      status: 'APPROVED',
      affinityCount: 1,
    });

    const response = await PATCH(
      new NextRequest('http://localhost/api/inference/domain-candidates/cand-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'APPROVED' }),
      }),
      { params: Promise.resolve({ id: 'cand-1' }) },
    );

    expect(response.status).toBe(200);
    expect(approveDomainCandidateMock).toHaveBeenCalledWith(db, 'cand-1', 'APPROVED');
    expect(createDomainAffinityChangedEventMock).toHaveBeenCalledWith('svc-1', 'domain-1');
    expect(applyRollupChangesMock).toHaveBeenCalledWith(db, 'ws-1', [
      { type: 'domain-affinity-changed' },
    ]);
  });

  it('PATCH REJECTED는 approveDomainCandidate에 위임하되 rollup 변경은 만들지 않아야 한다', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [{
              workspaceId: 'ws-1',
              objectId: 'svc-1',
              primaryDomainId: 'domain-1',
              affinityMap: { 'domain-1': 1 },
            }],
          }),
        }),
      }),
    };
    getDbMock.mockResolvedValue(db);
    approveDomainCandidateMock.mockResolvedValue({
      success: true,
      status: 'REJECTED',
      affinityCount: 0,
    });

    const response = await PATCH(
      new NextRequest('http://localhost/api/inference/domain-candidates/cand-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'REJECTED' }),
      }),
      { params: Promise.resolve({ id: 'cand-1' }) },
    );

    expect(response.status).toBe(200);
    expect(approveDomainCandidateMock).toHaveBeenCalledWith(db, 'cand-1', 'REJECTED');
    expect(createDomainAffinityChangedEventMock).not.toHaveBeenCalled();
    expect(applyRollupChangesMock).not.toHaveBeenCalled();
  });
});
