import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { join } from 'path';
import { createTestDb as createEmbeddedTestDb } from '@archi-navi/db';
import {
  domainDiscoveryMemberships,
  domainDiscoveryRuns,
  objects,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { generateDomainLabels } from '@/llm/domainLabeler';

async function createTestDb() {
  return await createEmbeddedTestDb();
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function seedWorkspace(db: TestDb) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
  await db.insert(domainDiscoveryRuns).values({
    id: runId,
    workspaceId,
    algo: 'louvain',
    algoVersion: '1.0',
    inputLayers: ['call'],
    parameters: {},
    graphStats: {},
    status: 'DONE',
    startedAt: new Date(),
    finishedAt: new Date(),
  });
}

async function createObject(
  db: TestDb,
  params: {
    id?: string;
    objectType: 'domain' | 'service';
    name: string;
    displayName?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const id = params.id ?? generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: params.objectType,
    granularity: 'COMPOUND',
    name: params.name,
    displayName: params.displayName ?? null,
    path: `/${id}`,
    depth: 0,
    metadata: params.metadata ?? {},
  });
  return id;
}

async function addMembership(db: TestDb, domainId: string, objectId: string) {
  await db.insert(domainDiscoveryMemberships).values({
    id: generateId(),
    workspaceId,
    runId,
    domainId,
    objectId,
    affinity: 1,
    purity: null,
  });
}

describe('generateDomainLabels', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seedWorkspace(db);
  });

  it('도메인 객체 metadata에 한국어/영어 llmLabel 쌍을 저장한다', async () => {
    const domainId = await createObject(db, {
      id: '00000000-0000-0000-0000-000000000132',
      objectType: 'domain',
      name: 'discovered:order-1',
      displayName: 'Order Domain',
      metadata: {
        labelCandidates: [{ text: 'order', score: 0.9 }],
      },
    });
    const memberId = await createObject(db, {
      objectType: 'service',
      name: 'order-service',
      displayName: 'Order Service',
    });
    await addMembership(db, domainId, memberId);

    const result = await generateDomainLabels(
      db,
      async () => ({ ko: '주문 관리', en: 'Order Management' }),
      { workspaceId, runId },
    );

    expect(result).toMatchObject({
      processedCount: 1,
      labeledCount: 1,
      skippedCount: 0,
      callCount: 1,
      errorCount: 0,
    });

    const domainRows = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.id, domainId), eq(objects.workspaceId, workspaceId)));
    const metadata = domainRows[0]?.metadata as Record<string, unknown>;
    const llmLabel = metadata['llmLabel'] as Record<string, unknown>;

    expect(llmLabel).toMatchObject({
      ko: '주문 관리',
      en: 'Order Management',
    });
    expect(typeof llmLabel['labeledAt']).toBe('string');
  });

  it('기존 llmLabel 이 있으면 호출하지 않고 skip 한다', async () => {
    const domainId = await createObject(db, {
      id: '00000000-0000-0000-0000-000000000133',
      objectType: 'domain',
      name: 'discovered:billing-1',
      metadata: {
        labelCandidates: [{ text: 'billing', score: 0.8 }],
        llmLabel: { ko: '정산', en: 'Billing' },
      },
    });
    const memberId = await createObject(db, {
      objectType: 'service',
      name: 'billing-service',
    });
    await addMembership(db, domainId, memberId);

    const generateFn = vi.fn(async () => ({ ko: '결제', en: 'Payment' }));
    const result = await generateDomainLabels(db, generateFn, { workspaceId, runId });

    expect(result).toMatchObject({
      processedCount: 1,
      labeledCount: 0,
      skippedCount: 1,
      callCount: 0,
      errorCount: 0,
    });
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('LLM 생성이 실패해도 throw 하지 않고 기존 결과를 유지한다', async () => {
    const failingDomainId = await createObject(db, {
      id: '00000000-0000-0000-0000-000000000134',
      objectType: 'domain',
      name: 'discovered:catalog-1',
      metadata: {
        labelCandidates: [{ text: 'catalog', score: 0.9 }],
      },
    });
    const succeedingDomainId = await createObject(db, {
      id: '00000000-0000-0000-0000-000000000135',
      objectType: 'domain',
      name: 'discovered:shipping-1',
      metadata: {
        labelCandidates: [{ text: 'shipping', score: 0.9 }],
      },
    });
    await addMembership(
      db,
      failingDomainId,
      await createObject(db, { objectType: 'service', name: 'catalog-service' }),
    );
    await addMembership(
      db,
      succeedingDomainId,
      await createObject(db, { objectType: 'service', name: 'shipping-service' }),
    );

    const result = await generateDomainLabels(
      db,
      async (context) => {
        if (context.domainId === failingDomainId) {
          throw new Error('llm unavailable');
        }
        return { ko: '배송', en: 'Shipping' };
      },
      { workspaceId, runId },
    );

    expect(result).toMatchObject({
      processedCount: 2,
      labeledCount: 1,
      skippedCount: 0,
      callCount: 2,
      errorCount: 1,
    });

    const domainRows = await db
      .select({ id: objects.id, metadata: objects.metadata })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'domain'),
        ),
      );

    const failingMetadata = domainRows.find((row) => row.id === failingDomainId)
      ?.metadata as Record<string, unknown>;
    const succeedingMetadata = domainRows.find((row) => row.id === succeedingDomainId)
      ?.metadata as Record<string, unknown>;

    expect(failingMetadata['llmLabel']).toBeUndefined();
    expect((succeedingMetadata['llmLabel'] as Record<string, unknown>)['ko']).toBe('배송');
  });
});
