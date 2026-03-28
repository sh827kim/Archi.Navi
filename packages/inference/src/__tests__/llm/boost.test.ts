/**
 * LLM code intent analysis(boost) — unresolved call edge 기반 보완 후보 테스트
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  codeArtifacts,
  codeCallEdges,
  createPgliteClient,
  evidences,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { generateBoostCandidates } from '@/llm/boost';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000031';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function createService(db: TestDb, name: string): Promise<string> {
  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name,
    displayName: name,
    path: `/${id}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });
  return id;
}

async function createUnresolvedCallEdge(
  db: TestDb,
  input: {
    callerServiceId: string;
    repoRoot: string;
    calleeSymbol: string;
    excerpt: string;
    filePath?: string;
  },
) {
  const artifactId = generateId();
  const evidenceId = generateId();

  await db.insert(codeArtifacts).values({
    id: artifactId,
    workspaceId,
    language: 'java',
    repoRoot: input.repoRoot,
    filePath: input.filePath ?? `src/${artifactId}.java`,
    ownerObjectId: input.callerServiceId,
  });

  await db.insert(evidences).values({
    id: evidenceId,
    workspaceId,
    evidenceType: 'FILE',
    filePath: input.filePath ?? `src/${artifactId}.java`,
    lineStart: 10,
    lineEnd: 12,
    excerpt: input.excerpt,
    metadata: {
      kind: 'call',
      confidence: 0.4,
    },
  });

  await db.insert(codeCallEdges).values({
    id: generateId(),
    workspaceId,
    callerArtifactId: artifactId,
    calleeSymbol: input.calleeSymbol,
    evidenceId,
  });
}

describe('generateBoostCandidates', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'llm-boost-test' });
  });

  it('F2/F3: unresolved 동적 호출 컨텍스트에서 LLM_BOOST 후보를 생성해야 한다', async () => {
    const orderServiceId = await createService(db, 'order-service');
    const paymentServiceId = await createService(db, 'payment-service');
    await createUnresolvedCallEdge(db, {
      callerServiceId: orderServiceId,
      repoRoot: '/repo/order',
      calleeSymbol: 'paymentClient.callDynamic',
      excerpt: 'String url = baseUrl + "/" + serviceName + "/api/pay"; client.get(url);',
      filePath: 'src/main/java/OrderClient.java',
    });

    const result = await generateBoostCandidates(
      db,
      vi.fn(async (context) => {
        expect(context.callerServiceName).toBe('order-service');
        expect(context.excerpt).toContain('serviceName');
        expect(context.candidateServices).toContain('payment-service');
        return {
          targetServiceName: 'payment-service',
          relationType: 'call',
          confidence: 0.9,
          reasoning: '동적 URL의 serviceName이 payment-service를 가리킨다.',
        };
      }),
      {
        workspaceId,
        repoRoots: ['/repo/order'],
        maxCalls: 5,
      },
    );

    expect(result).toEqual({
      scannedCount: 1,
      generatedCount: 1,
      skippedCount: 0,
      callCount: 1,
      errorCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidate?.subjectObjectId).toBe(orderServiceId);
    expect(candidate?.objectId).toBe(paymentServiceId);
    expect(candidate?.confidence).toBe(0.7);

    const metadata = candidate?.metadata as Record<string, unknown>;
    expect(metadata.source).toBe('LLM_BOOST');
    expect(metadata.llmBoost).toEqual(
      expect.objectContaining({
        calleeSymbol: 'paymentClient.callDynamic',
        targetServiceName: 'payment-service',
        suggestedConfidence: 0.7,
      }),
    );

    const links = await db
      .select()
      .from(relationCandidateEvidences)
      .where(eq(relationCandidateEvidences.workspaceId, workspaceId));
    expect(links).toHaveLength(1);
  });

  it('F5: maxCalls를 초과하면 남은 boost 작업은 skip 해야 한다', async () => {
    const orderServiceId = await createService(db, 'order-service');
    await createService(db, 'payment-service');
    await createService(db, 'shipping-service');

    await createUnresolvedCallEdge(db, {
      callerServiceId: orderServiceId,
      repoRoot: '/repo/order',
      calleeSymbol: 'dynamicCallA',
      excerpt: 'client.get(baseUrl + serviceNameA)',
      filePath: 'src/A.java',
    });
    await createUnresolvedCallEdge(db, {
      callerServiceId: orderServiceId,
      repoRoot: '/repo/order',
      calleeSymbol: 'dynamicCallB',
      excerpt: 'client.get(baseUrl + serviceNameB)',
      filePath: 'src/B.java',
    });

    const result = await generateBoostCandidates(
      db,
      vi.fn(async () => ({
        targetServiceName: 'payment-service',
        relationType: 'call',
        confidence: 0.6,
        reasoning: 'boost',
      })),
      {
        workspaceId,
        repoRoots: ['/repo/order'],
        maxCalls: 1,
      },
    );

    expect(result.scannedCount).toBe(2);
    expect(result.generatedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.callCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('F9: LLM 호출이 실패해도 기존 결과에 영향 없이 errorCount만 증가해야 한다', async () => {
    const orderServiceId = await createService(db, 'order-service');
    await createService(db, 'payment-service');
    await createUnresolvedCallEdge(db, {
      callerServiceId: orderServiceId,
      repoRoot: '/repo/order',
      calleeSymbol: 'dynamicCall',
      excerpt: 'client.get(dynamicUrl)',
    });

    const result = await generateBoostCandidates(
      db,
      vi.fn(async () => {
        throw new Error('model timeout');
      }),
      {
        workspaceId,
        repoRoots: ['/repo/order'],
        maxCalls: 5,
      },
    );

    expect(result).toEqual({
      scannedCount: 1,
      generatedCount: 0,
      skippedCount: 0,
      callCount: 1,
      errorCount: 1,
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(candidates).toHaveLength(0);
  });
});
