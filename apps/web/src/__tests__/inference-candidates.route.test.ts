// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getDbMock,
  relationCandidatesMock,
  relationCandidateEvidencesMock,
  objectsMock,
  evidencesMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  relationCandidatesMock: {
    workspaceId: 'relation_candidates.workspace_id',
    status: 'relation_candidates.status',
    id: 'relation_candidates.id',
    subjectObjectId: 'relation_candidates.subject_object_id',
    objectId: 'relation_candidates.object_id',
  },
  relationCandidateEvidencesMock: {
    candidateId: 'relation_candidate_evidences.candidate_id',
    workspaceId: 'relation_candidate_evidences.workspace_id',
    evidenceId: 'relation_candidate_evidences.evidence_id',
  },
  objectsMock: {
    id: 'objects.id',
    displayName: 'objects.display_name',
    name: 'objects.name',
    granularity: 'objects.granularity',
    parentId: 'objects.parent_id',
    objectType: 'objects.object_type',
    workspaceId: 'objects.workspace_id',
  },
  evidencesMock: {
    id: 'evidences.id',
    evidenceType: 'evidences.evidence_type',
  },
}));

vi.mock('@archi-navi/db', () => ({
  getDb: getDbMock,
  relationCandidates: relationCandidatesMock,
  relationCandidateEvidences: relationCandidateEvidencesMock,
  objects: objectsMock,
  evidences: evidencesMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
}));

import { GET } from '@/app/api/inference/candidates/route';

describe('GET /api/inference/candidates', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('evidence 링크를 기반으로 crossValidation 요약을 응답에 포함해야 한다', async () => {
    const candidates = [
      {
        id: 'cand-1',
        subjectObjectId: 'svc-1',
        objectId: 'svc-2',
        relationType: 'call',
        confidence: 0.82,
        status: 'PENDING',
        metadata: { source: 'CODE' },
      },
    ];
    const allObjects = [
      {
        id: 'svc-1',
        displayName: 'order-service',
        name: 'order-service',
        granularity: 'COMPOUND',
        parentId: null,
        objectType: 'service',
      },
      {
        id: 'svc-2',
        displayName: 'payment-service',
        name: 'payment-service',
        granularity: 'COMPOUND',
        parentId: null,
        objectType: 'service',
      },
    ];
    const evidenceRows = [
      { candidateId: 'cand-1', evidenceType: 'CONFIG' },
      { candidateId: 'cand-1', evidenceType: 'FILE' },
    ];

    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: async () => candidates,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            innerJoin: () => ({
              where: async () => evidenceRows,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: async () => allObjects,
          }),
        }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/candidates?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cand-1',
        subjectName: 'order-service',
        objectName: 'payment-service',
        crossValidation: expect.objectContaining({
          validated: true,
          supportCount: 2,
          supportingSources: ['config', 'code'],
          contradictions: [],
        }),
      }),
    ]));
  });

  it('metadata의 STALE_CONFIG contradiction을 응답에 포함해야 한다', async () => {
    const candidates = [
      {
        id: 'cand-2',
        subjectObjectId: 'svc-1',
        objectId: 'db-1',
        relationType: 'read',
        confidence: 0.75,
        status: 'PENDING',
        metadata: {
          source: 'application_yml',
          crossValidation: {
            contradictions: [{ ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.15 }],
          },
        },
      },
    ];
    const allObjects = [
      {
        id: 'svc-1',
        displayName: 'order-service',
        name: 'order-service',
        granularity: 'COMPOUND',
        parentId: null,
        objectType: 'service',
      },
      {
        id: 'db-1',
        displayName: 'order-db',
        name: 'order-db',
        granularity: 'COMPOUND',
        parentId: null,
        objectType: 'database',
      },
    ];
    const evidenceRows = [{ candidateId: 'cand-2', evidenceType: 'CONFIG' }];

    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: async () => candidates,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            innerJoin: () => ({
              where: async () => evidenceRows,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: async () => allObjects,
          }),
        }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/candidates?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cand-2',
        crossValidation: expect.objectContaining({
          validated: false,
          supportCount: 1,
          supportingSources: ['config'],
          contradictions: [{ ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.15 }],
        }),
      }),
    ]));
  });

  it('알려진 contradiction 타입은 C2~C4도 그대로 응답에 포함해야 한다', async () => {
    const candidates = [
      {
        id: 'cand-3',
        subjectObjectId: 'svc-1',
        objectId: 'svc-2',
        relationType: 'call',
        confidence: 0.7,
        status: 'PENDING',
        metadata: {
          source: 'CODE',
          crossValidation: {
            contradictions: [
              { ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 },
              { ruleId: 'C3', type: 'DEAD_TOPIC', penalty: 0.15 },
              { ruleId: 'C4', type: 'ORPHAN_FK', penalty: 0.15 },
            ],
          },
        },
      },
    ];
    const allObjects = [
      {
        id: 'svc-1',
        displayName: 'order-service',
        name: 'order-service',
        granularity: 'COMPOUND',
        parentId: null,
        objectType: 'service',
      },
      {
        id: 'svc-2',
        displayName: 'billing-service',
        name: 'billing-service',
        granularity: 'COMPOUND',
        parentId: null,
        objectType: 'service',
      },
    ];
    const evidenceRows = [{ candidateId: 'cand-3', evidenceType: 'FILE' }];

    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: async () => candidates,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            innerJoin: () => ({
              where: async () => evidenceRows,
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: async () => allObjects,
          }),
        }),
    };
    getDbMock.mockResolvedValue(db);

    const response = await GET(
      new NextRequest('http://localhost/api/inference/candidates?workspaceId=ws-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cand-3',
        crossValidation: expect.objectContaining({
          validated: false,
          supportCount: 1,
          supportingSources: ['code'],
          contradictions: [
            { ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 },
            { ruleId: 'C3', type: 'DEAD_TOPIC', penalty: 0.15 },
            { ruleId: 'C4', type: 'ORPHAN_FK', penalty: 0.15 },
          ],
        }),
      }),
    ]));
  });
});
