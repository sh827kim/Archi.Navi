// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as any },
}));

vi.mock('@archi-navi/db', async () => {
  const actual = await vi.importActual<typeof import('@archi-navi/db')>('@archi-navi/db');
  return {
    ...actual,
    getDb: async () => dbHolder.db,
  };
});

import {
  createTestDb as createEmbeddedTestDb,
  domainCandidates,
  inferenceRuns,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { GET } from '@/app/api/dashboard/summary/route';

const workspaceId = '00000000-0000-0000-0000-000000000121';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

describe('GET /api/dashboard/summary', () => {
  beforeEach(async () => {
    dbHolder.db = await createTestDb();
  });

  it('워크스페이스 요약과 최근 추론 실행을 반환해야 한다', async () => {
    await dbHolder.db.insert(workspaces).values({
      id: workspaceId,
      name: 'dashboard-summary-test',
    });

    await dbHolder.db.insert(objects).values([
      {
        id: '00000000-0000-0000-0000-000000000201',
        workspaceId,
        objectType: 'service',
        category: null,
        granularity: 'COMPOUND',
        name: 'orders',
        displayName: 'Orders',
        path: 'orders',
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: '00000000-0000-0000-0000-000000000202',
        workspaceId,
        objectType: 'service',
        category: null,
        granularity: 'COMPOUND',
        name: 'billing',
        displayName: 'Billing',
        path: 'billing',
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: '00000000-0000-0000-0000-000000000203',
        workspaceId,
        objectType: 'domain',
        category: null,
        granularity: 'COMPOUND',
        name: 'commerce',
        displayName: 'Commerce',
        path: 'commerce',
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    await dbHolder.db.insert(relationCandidates).values({
      id: '00000000-0000-0000-0000-000000000301',
      workspaceId,
      relationType: 'call',
      subjectObjectId: '00000000-0000-0000-0000-000000000201',
      objectId: '00000000-0000-0000-0000-000000000202',
      confidence: 0.84,
      metadata: {},
      status: 'PENDING',
    });

    await dbHolder.db.insert(domainCandidates).values({
      id: '00000000-0000-0000-0000-000000000401',
      workspaceId,
      objectId: '00000000-0000-0000-0000-000000000201',
      affinityMap: { '00000000-0000-0000-0000-000000000203': 0.91 },
      purity: 0.91,
      primaryDomainId: '00000000-0000-0000-0000-000000000203',
      secondaryDomainIds: [],
      signals: {},
      status: 'PENDING',
    });

    await dbHolder.db.insert(inferenceRuns).values([
      {
        id: '00000000-0000-0000-0000-000000000501',
        workspaceId,
        status: 'FAILED',
        triggerType: 'MANUAL',
        requestedModes: ['config'],
        sourceSummary: { local: 1 },
        errorMessage: 'older failure',
        createdAt: new Date('2026-03-29T09:00:00.000Z'),
        updatedAt: new Date('2026-03-29T09:00:00.000Z'),
      },
      {
        id: '00000000-0000-0000-0000-000000000502',
        workspaceId,
        status: 'SUCCEEDED',
        triggerType: 'CLI',
        requestedModes: ['config', 'code'],
        sourceSummary: { local: 2 },
        createdAt: new Date('2026-03-29T10:00:00.000Z'),
        updatedAt: new Date('2026-03-29T10:00:00.000Z'),
      },
    ]);

    const response = await GET({
      nextUrl: new URL(`http://localhost/api/dashboard/summary?workspaceId=${workspaceId}`),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      counts: {
        objects: 3,
        services: 2,
        domains: 1,
        pendingRelations: 1,
        pendingDomains: 1,
      },
      recentRuns: [
        expect.objectContaining({
          id: '00000000-0000-0000-0000-000000000502',
          status: 'SUCCEEDED',
        }),
        expect.objectContaining({
          id: '00000000-0000-0000-0000-000000000501',
          status: 'FAILED',
        }),
      ],
    });
  });

  it('workspaceId가 없으면 400을 반환해야 한다', async () => {
    const response = await GET({
      nextUrl: new URL('http://localhost/api/dashboard/summary'),
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'workspaceId is required' });
  });
});
