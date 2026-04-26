// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  getDbMock,
  mergeMock,
  applyRollupChangesMock,
  createDomainAffinityChangedEventMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  mergeMock: vi.fn(),
  applyRollupChangesMock: vi.fn(),
  createDomainAffinityChangedEventMock: vi.fn((objectId: string, domainId: string) => ({
    type: 'DOMAIN_AFFINITY_CHANGED',
    payload: { objectId, domainId },
  })),
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
}));

vi.mock('@archi-navi/inference', async () => {
  class DbTableMergeError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    DbTableMergeError,
    mergeImplicitSchemaDbTableCandidate: mergeMock,
  };
});

vi.mock('@/lib/rollup-change-events', () => ({
  applyRollupChanges: applyRollupChangesMock,
  createDomainAffinityChangedEvent: createDomainAffinityChangedEventMock,
}));

import { DbTableMergeError } from '@archi-navi/inference';
import { POST } from '@/app/api/db-tables/merge-candidate/route';

function makeRequest(body: unknown): NextRequest {
  return new Request('http://localhost/api/db-tables/merge-candidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function makeRawRequest(body: string): NextRequest {
  return new Request('http://localhost/api/db-tables/merge-candidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }) as NextRequest;
}

describe('POST /api/db-tables/merge-candidate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceId와 candidateId가 없으면 400을 반환한다', async () => {
    const res = await POST(makeRequest({ workspaceId: 'ws-1' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'workspaceId와 candidateId가 필요합니다' });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('JSON 형식이 깨진 요청은 400을 반환한다', async () => {
    const res = await POST(makeRawRequest('{ broken json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '요청 JSON 형식이 올바르지 않습니다' });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('병합 성공 시 도메인 affinity rollup 이벤트를 발행한다', async () => {
    const db = {};
    getDbMock.mockResolvedValue(db);
    mergeMock.mockResolvedValue({
      success: true,
      sourceObjectId: 'table-unqualified',
      targetObjectId: 'table-qualified',
      mergedRelationCount: 1,
      mergedCandidateCount: 2,
      mergedDomainAffinityCount: 1,
      affectedDomainIds: ['domain-1'],
    });

    const res = await POST(makeRequest({ workspaceId: 'ws-1', candidateId: 'cand-1' }));

    expect(res.status).toBe(200);
    expect(mergeMock).toHaveBeenCalledWith(db, { workspaceId: 'ws-1', candidateId: 'cand-1' });
    expect(applyRollupChangesMock).toHaveBeenCalledWith(db, 'ws-1', [
      { type: 'DOMAIN_AFFINITY_CHANGED', payload: { objectId: 'table-unqualified', domainId: 'domain-1' } },
      { type: 'DOMAIN_AFFINITY_CHANGED', payload: { objectId: 'table-qualified', domainId: 'domain-1' } },
    ]);
    expect(await res.json()).toMatchObject({
      success: true,
      sourceObjectId: 'table-unqualified',
      targetObjectId: 'table-qualified',
    });
  });

  it('병합 검증 오류는 지정된 status와 code로 반환한다', async () => {
    getDbMock.mockResolvedValue({});
    mergeMock.mockRejectedValue(
      new DbTableMergeError('INVALID_MERGE_CANDIDATE', 'invalid merge candidate', 400),
    );

    const res = await POST(makeRequest({ workspaceId: 'ws-1', candidateId: 'cand-1' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid merge candidate',
      code: 'INVALID_MERGE_CANDIDATE',
    });
  });
});
