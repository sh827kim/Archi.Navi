import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import {
  createPgliteClient,
  evidences,
  objectRelations,
  objects,
  relationCandidates,
  relationEvidences,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { executeSmartPipeline } from '@/orchestration/smartPipeline';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000042';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

function createService(scanPath: string, name: string) {
  return {
    id: generateId(),
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name,
    path: `/${name}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: { scanPath },
  } as const;
}

describe('smartPipeline duplicate guards', () => {
  let db: TestDb;
  let rootDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    rootDir = join(tmpdir(), `archi-navi-smart-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(rootDir, { recursive: true });
    await db.insert(workspaces).values({ id: workspaceId, name: 'smart-pipeline-test' });
  });

  afterEach(() => {
    try {
      rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('이미 확정된 service relation이 있으면 LLM compound 후보를 다시 만들지 않아야 한다', async () => {
    const consumerDir = join(rootDir, 'gateway');
    const providerDir = join(rootDir, 'orders');
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(consumerDir, 'application.yml'), 'spring.application.name=gateway');

    const gateway = createService(consumerDir, 'gateway');
    const orders = createService(providerDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const existingRelationId = generateId();
    await db.insert(objectRelations).values({
      id: existingRelationId,
      workspaceId,
      relationType: 'call',
      subjectObjectId: gateway.id,
      objectId: orders.id,
      confidence: 1,
      status: 'APPROVED',
      source: 'MANUAL',
      metadata: {},
    });

    await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.91,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
    });

    const compoundCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, gateway.id),
          eq(relationCandidates.objectId, orders.id),
          eq(relationCandidates.relationType, 'call'),
        ),
      );
    expect(compoundCandidates).toHaveLength(0);

    const linkedEvidenceRows = await db
      .select()
      .from(relationEvidences)
      .where(
        and(
          eq(relationEvidences.workspaceId, workspaceId),
          eq(relationEvidences.relationId, existingRelationId),
        ),
      );
    expect(linkedEvidenceRows).toHaveLength(1);
  });

  it('이미 확정된 endpoint relation이 있으면 LLM endpoint 후보를 다시 만들지 않아야 한다', async () => {
    const consumerDir = join(rootDir, 'gateway');
    const providerDir = join(rootDir, 'orders');
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(consumerDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(join(consumerDir, 'client.ts'), 'const x = fetch("/api/orders");');

    const gateway = createService(consumerDir, 'gateway');
    const orders = createService(providerDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    await db.insert(objectRelations).values([
      {
        id: generateId(),
        workspaceId,
        relationType: 'call',
        subjectObjectId: gateway.id,
        objectId: orders.id,
        confidence: 1,
        status: 'APPROVED',
        source: 'MANUAL',
        metadata: {},
      },
      {
        id: generateId(),
        workspaceId,
        relationType: 'call',
        subjectObjectId: gateway.id,
        objectId: endpointId,
        confidence: 1,
        status: 'APPROVED',
        source: 'MANUAL',
        metadata: {},
      },
    ]);

    await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway depends on orders',
            confidence: 0.87,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("/api/orders")',
            confidence: 0.92,
          },
        ],
      }),
    });

    const endpointCandidates = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.subjectObjectId, gateway.id),
          eq(relationCandidates.objectId, endpointId),
          eq(relationCandidates.relationType, 'call'),
        ),
      );
    expect(endpointCandidates).toHaveLength(0);

    const codeEvidenceRows = await db
      .select()
      .from(evidences)
      .where(eq(evidences.workspaceId, workspaceId));
    expect(codeEvidenceRows.length).toBeGreaterThan(0);
  });

  it('OpenAPI가 없어도 expose 코드만으로 endpoint를 bootstrap 해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      `
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
  @GetMapping("/api/orders")
  public String getOrders() {
    return "ok";
  }
}
`,
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
    });

    expect(result.phase1.openApi.createdEndpointCount).toBe(0);
    expect(result.phase1.bootstrapEndpointCount).toBe(1);

    const endpoints = await db
      .select({
        id: objects.id,
        parentId: objects.parentId,
        name: objects.name,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'api_endpoint'),
        ),
      );

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.parentId).toBe(orders.id);
    expect(endpoints[0]?.name).toBe('GET /api/orders');
    expect(endpoints[0]?.metadata).toMatchObject({
      method: 'GET',
      path: '/api/orders',
      source: 'SMART_BOOTSTRAP',
    });
  });

  it('OpenAPI가 없어도 expose 코드로 endpoint를 bootstrap 하고 같은 실행에서 endpoint 후보를 생성해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return fetch("http://orders/api/orders"); }\n',
    );
    writeFileSync(
      join(ordersDir, 'server.ts'),
      "import express from 'express'; const app = express(); app.get('/api/orders', (_req, res) => res.send('ok')); export default app;\n",
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway routes to orders',
            confidence: 0.91,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/api/orders")',
            confidence: 0.94,
          },
        ],
      }),
    });

    expect(result.phase1.openApi.createdEndpointCount).toBe(0);
    expect(result.phase1.bootstrapEndpointCount).toBe(1);
    expect(result.phase3.endpointCallCount).toBe(1);
    expect(result.phase3.candidateCount).toBe(1);
    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.serviceFallbackCount).toBe(0);

    const endpoints = await db
      .select({
        id: objects.id,
        parentId: objects.parentId,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'api_endpoint'),
        ),
      );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.metadata).toMatchObject({
      source: 'SMART_BOOTSTRAP',
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    const endpointCandidate = candidates.find((candidate) => candidate.objectId === endpoints[0]?.id);
    expect(endpointCandidate).toBeDefined();
    expect(endpointCandidate?.subjectObjectId).toBe(gateway.id);
    expect(endpointCandidate?.relationType).toBe('call');
    expect(endpointCandidate?.metadata).toMatchObject({
      source: 'LLM_CODE',
      targetType: 'api_endpoint',
      targetServiceId: orders.id,
      path: '/api/orders',
    });

    const codeCandidates = candidates.filter((candidate) => {
      const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
      return metadata['source'] === 'CODE';
    });
    expect(codeCandidates).toHaveLength(0);
  });

  it('endpoint 미매칭이면 service fallback 후보를 만들고 fallbackReason을 metadata에 저장해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrderById() { return fetch("http://orders/api/orders/missing"); }\n',
    );
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      `
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
  @GetMapping("/api/orders")
  public String getOrders() {
    return "ok";
  }
}
`,
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'depend_on',
            evidence: 'gateway depends on orders',
            confidence: 0.9,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders/missing',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/api/orders/missing")',
            confidence: 0.88,
          },
        ],
      }),
    });

    expect(result.phase3.endpointCallCount).toBe(1);
    expect(result.phase3.candidateCount).toBe(1);
    expect(result.phase3.atomicCandidateCount).toBe(0);
    expect(result.phase3.serviceFallbackCount).toBe(1);
    expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
      NO_ENDPOINT_OBJECTS: 0,
      PATH_NOT_MATCHED: 1,
      METHOD_NOT_MATCHED: 0,
      INSUFFICIENT_CONTEXT: 0,
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    const fallbackCandidate = candidates.find((candidate) => {
      const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
      return metadata['source'] === 'LLM_CODE' && metadata['targetServiceId'] === orders.id;
    });

    expect(fallbackCandidate).toBeDefined();
    expect(fallbackCandidate?.subjectObjectId).toBe(gateway.id);
    expect(fallbackCandidate?.objectId).toBe(orders.id);

    const metadata = (fallbackCandidate?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata['targetType']).toBe('service');
    expect(typeof metadata['fallbackReason']).toBe('string');
    expect([
      'NO_ENDPOINT_OBJECTS',
      'PATH_NOT_MATCHED',
      'METHOD_NOT_MATCHED',
      'INSUFFICIENT_CONTEXT',
    ]).toContain(metadata['fallbackReason']);
  });

  it('full URL + query/hash + concrete id 경로를 templated endpoint로 매칭해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrderById() { return fetch("https://orders.internal/api/orders/123?include=items#detail"); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders/{id}',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders/{id}' },
      },
    ]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.92,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: 'https://orders.internal/api/orders/123?include=items#detail',
            sourceFile: 'client.ts',
            evidence: 'fetch("https://orders.internal/api/orders/123?include=items#detail")',
            confidence: 0.91,
          },
        ],
      }),
    });

    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.serviceFallbackCount).toBe(0);
    expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
      PATH_NOT_MATCHED: 0,
      METHOD_NOT_MATCHED: 0,
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    const atomicCandidate = candidates.find((candidate) => candidate.objectId === endpointId);
    expect(atomicCandidate).toBeDefined();
  });

  it('path param 표기(:id, ${id})도 동일 endpoint로 매칭해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrderById() { return callOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders/{id}',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders/{id}' },
      },
    ]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.94,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders/:id',
            sourceFile: 'client.ts',
            evidence: 'GET /api/orders/:id',
            confidence: 0.9,
          },
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders/${orderId}',
            sourceFile: 'client.ts',
            evidence: 'GET /api/orders/${orderId}',
            confidence: 0.9,
          },
        ],
      }),
    });

    expect(result.phase3.endpointCallCount).toBe(2);
    expect(result.phase3.candidateCount).toBe(1);
    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.serviceFallbackCount).toBe(0);
  });

  it('path가 호환돼도 method가 다르면 METHOD_NOT_MATCHED fallback이어야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function createOrder() { return fetch("https://orders.internal/api/orders/123?include=items#detail"); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders/{id}',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders/{id}' },
      },
    ]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.93,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'POST',
            path: 'https://orders.internal/api/orders/123?include=items#detail',
            sourceFile: 'client.ts',
            evidence: 'POST /api/orders/123',
            confidence: 0.86,
          },
        ],
      }),
    });

    expect(result.phase3.atomicCandidateCount).toBe(0);
    expect(result.phase3.serviceFallbackCount).toBe(1);
    expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
      NO_ENDPOINT_OBJECTS: 0,
      PATH_NOT_MATCHED: 0,
      METHOD_NOT_MATCHED: 1,
      INSUFFICIENT_CONTEXT: 0,
    });
  });

  it('provider endpoint object가 없으면 NO_ENDPOINT_OBJECTS fallbackReason을 저장해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return fetch("http://orders/api/orders"); }\n',
    );
    // orders 서비스는 생성하되 endpoint object를 만들 수 있는 expose 코드는 두지 않는다.

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.92,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/api/orders")',
            confidence: 0.91,
          },
        ],
      }),
    });

    expect(result.phase3.candidateCount).toBe(0);
    expect(result.phase3.atomicCandidateCount).toBe(0);
    expect(result.phase3.serviceFallbackCount).toBe(1);
    expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
      NO_ENDPOINT_OBJECTS: 1,
      PATH_NOT_MATCHED: 0,
      METHOD_NOT_MATCHED: 0,
      INSUFFICIENT_CONTEXT: 0,
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    const fallbackCandidate = candidates.find((candidate) => {
      const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
      return candidate.subjectObjectId === gateway.id &&
        candidate.objectId === orders.id &&
        metadata['targetType'] === 'service';
    });

    expect(fallbackCandidate).toBeDefined();
    expect(fallbackCandidate?.subjectObjectId).toBe(gateway.id);
    expect(fallbackCandidate?.objectId).toBe(orders.id);
    expect((fallbackCandidate?.metadata as Record<string, unknown>)['fallbackReason']).toBe('NO_ENDPOINT_OBJECTS');
  });

  it('servicePairCount는 dependency의 유효 서비스 쌍을 dedupe하고 fallbackReasonBreakdown은 발생 횟수를 누적해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      [
        'export async function loadOrders() {',
        '  await fetch("http://orders/api/orders");',
        '  await fetch("http://orders/api/orders/missing");',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class OrderController {',
        '  @GetMapping("/api/orders")',
        '  public String getOrders() { return "ok"; }',
        '}',
      ].join('\n'),
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.95,
          },
          {
            targetService: 'orders',
            relationType: 'depend_on',
            evidence: 'gateway depends on orders',
            confidence: 0.9,
          },
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway still calls orders',
            confidence: 0.88,
          },
          {
            targetService: 'gateway',
            relationType: 'call',
            evidence: 'self loop should be ignored',
            confidence: 0.7,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'POST',
            path: '/api/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/api/orders", { method: "POST" })',
            confidence: 0.84,
          },
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders/missing',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/api/orders/missing")',
            confidence: 0.83,
          },
        ],
      }),
    });

    expect(result.phase2.servicePairCount).toBe(1);
    expect(result.phase3.serviceFallbackCount).toBe(2);
    expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
      NO_ENDPOINT_OBJECTS: 0,
      PATH_NOT_MATCHED: 1,
      METHOD_NOT_MATCHED: 1,
      INSUFFICIENT_CONTEXT: 0,
    });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    const fallbackCandidates = candidates.filter((candidate) => {
      const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
      return candidate.objectId === orders.id
        && metadata['analysisMode'] === 'pair_pack'
        && metadata['targetType'] === 'service';
    });
    expect(fallbackCandidates).toHaveLength(1);
  });

  it('provider가 둘 이상이면 generateCallExtraction prompt가 pair별로 분리되어야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    const paymentDir = join(rootDir, 'payment');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });
    mkdirSync(paymentDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
        'payment.base-url=http://payment',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      [
        "import { loadOrders } from './orders-client';",
        "import { loadPayment } from './payment-client';",
        'export async function loadEverything() {',
        '  await loadOrders();',
        '  await loadPayment();',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'orders-client.ts'),
      [
        "import { ORDERS_URL } from './service-urls';",
        'export async function loadOrders() {',
        "  return fetch(`${ORDERS_URL}/api/orders`);",
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'payment-client.ts'),
      [
        "import { PAYMENT_URL } from './service-urls';",
        'export async function loadPayment() {',
        "  return fetch(`${PAYMENT_URL}/api/payments`);",
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'service-urls.ts'),
      [
        "export const ORDERS_URL = 'http://orders';",
        "export const PAYMENT_URL = 'http://payment';",
      ].join('\n'),
    );

    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class OrderController {',
        '  @GetMapping("/api/orders")',
        '  public String getOrders() { return "ok"; }',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(paymentDir, 'PaymentController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class PaymentController {',
        '  @GetMapping("/api/payments")',
        '  public String getPayments() { return "ok"; }',
        '}',
      ].join('\n'),
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const payment = createService(paymentDir, 'payment');
    await db.insert(objects).values([gateway, orders, payment]);

    const prompts: string[] = [];
    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.91,
          },
          {
            targetService: 'orders',
            relationType: 'depend_on',
            evidence: 'gateway also depends on orders',
            confidence: 0.75,
          },
          {
            targetService: 'payment',
            relationType: 'call',
            evidence: 'gateway calls payment',
            confidence: 0.9,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async (prompt) => {
        prompts.push(prompt);
        return { calls: [] };
      },
    });

    expect(result.phase2.servicePairCount).toBe(2);
    expect(prompts).toHaveLength(2);

    const ordersPrompt = prompts.find((prompt) => prompt.includes('/api/orders'));
    const paymentPrompt = prompts.find((prompt) => prompt.includes('/api/payments'));

    expect(ordersPrompt).toBeDefined();
    expect(paymentPrompt).toBeDefined();
    expect(ordersPrompt).toContain('orders');
    expect(ordersPrompt).not.toContain('/api/payments');
    expect(paymentPrompt).toContain('payment');
    expect(paymentPrompt).not.toContain('/api/orders');
  });

  it('fallback reason breakdown은 4개 reason을 각각 집계해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    const paymentDir = join(rootDir, 'payment');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });
    mkdirSync(paymentDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
        'payment.base-url=http://payment',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'orders-client.ts'),
      'export async function loadOrders() { return fetch("http://orders/api/orders"); }\n',
    );
    writeFileSync(
      join(gatewayDir, 'payment-client.ts'),
      'export async function loadPayment() { return fetch("http://payment/api/payments"); }\n',
    );
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class OrderController {',
        '  @GetMapping("/api/orders")',
        '  public String getOrders() { return "ok"; }',
        '}',
      ].join('\n'),
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const payment = createService(paymentDir, 'payment');
    await db.insert(objects).values([gateway, orders, payment]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.93,
          },
          {
            targetService: 'payment',
            relationType: 'call',
            evidence: 'gateway calls payment',
            confidence: 0.9,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async (prompt) => {
        if (prompt.includes('대상 서비스명: orders')) {
          return {
            calls: [
              {
                targetService: 'orders',
                httpMethod: 'POST',
                path: '/api/orders',
                sourceFile: 'orders-client.ts',
                evidence: 'fetch("http://orders/api/orders")',
                confidence: 0.9,
              },
              {
                targetService: 'orders',
                httpMethod: 'GET',
                path: '/api/orders/missing',
                sourceFile: 'orders-client.ts',
                evidence: 'fetch("http://orders/api/orders/missing")',
                confidence: 0.84,
              },
              {
                targetService: 'unknown-service',
                httpMethod: '',
                path: '',
                sourceFile: 'orders-client.ts',
                evidence: 'indirect wrapper without enough context',
                confidence: 0.4,
              },
            ],
          };
        }

        return {
          calls: [
            {
              targetService: 'payment',
              httpMethod: 'GET',
              path: '/api/payments',
              sourceFile: 'payment-client.ts',
              evidence: 'fetch("http://payment/api/payments")',
              confidence: 0.88,
            },
          ],
        };
      },
    });

    expect(result.phase2.servicePairCount).toBe(2);
    expect(result.phase3.serviceFallbackCount).toBe(4);
    expect(result.phase3.fallbackReasonBreakdown).toEqual({
      NO_ENDPOINT_OBJECTS: 1,
      PATH_NOT_MATCHED: 1,
      METHOD_NOT_MATCHED: 1,
      INSUFFICIENT_CONTEXT: 1,
    });
  });

  it('pair prompt에는 consumer/provider 양쪽 파일과 키워드 없는 wrapper/constant 파일이 포함되어야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      [
        "import { loadOrders } from './orders-client';",
        'export async function loadDashboard() {',
        '  return loadOrders();',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'orders-client.ts'),
      [
        "import { ORDERS_URL } from './service-urls';",
        'export async function loadOrders() {',
        "  return fetch(`${ORDERS_URL}/api/orders`);",
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'service-urls.ts'),
      "export const ORDERS_URL = 'http://orders';\n",
    );
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class OrderController {',
        '  @GetMapping("/api/orders")',
        '  public String getOrders() { return "ok"; }',
        '}',
      ].join('\n'),
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const prompts: string[] = [];
    await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.93,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async (prompt) => {
        prompts.push(prompt);
        return { calls: [] };
      },
    });

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';

    expect(prompt).toContain('client.ts');
    expect(prompt).toContain('orders-client.ts');
    expect(prompt).toContain('service-urls.ts');
    expect(prompt).toContain('OrderController.java');
    expect(prompt).toContain('orders.base-url=http://orders');
    expect(prompt).toContain('/api/orders');
  });

  it('low-confidence pair에서는 optional deep inspection을 실행하고 deepInspectionCount를 올려야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return fetch("http://orders/api/orders"); }\n',
    );
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class OrderController {',
        '  @GetMapping("/api/orders")',
        '  public String getOrders() { return "ok"; }',
        '}',
      ].join('\n'),
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const runDeepInspection = vi.fn(async () => ({
      calls: [
        {
          targetService: 'orders',
          httpMethod: 'GET',
          path: '/api/orders',
          sourceFile: 'client.ts',
          evidence: 'deep inspection recovered fetch("http://orders/api/orders")',
          confidence: 0.93,
        },
      ],
    }));

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway may call orders',
            confidence: 0.72,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
      runDeepInspection,
    });

    expect(runDeepInspection).toHaveBeenCalledTimes(1);
    expect(result.phase3.deepInspectionCount).toBe(1);
    expect(result.phase3.deepInspectionTrace).toMatchObject({
      attemptedCount: 1,
      failureCount: 0,
      triggerBreakdown: {
        lowConfidence: 1,
        insufficientContext: 0,
      },
    });
    expect(result.phase3.deepInspectionTrace.details).toHaveLength(1);
    expect(result.phase3.deepInspectionTrace.details[0]).toMatchObject({
      consumerServiceName: 'gateway',
      providerServiceName: 'orders',
      trigger: {
        lowConfidence: true,
        insufficientContext: false,
      },
      status: 'succeeded',
      fallbackReasons: [],
      toolUsage: {
        searchCalls: 0,
        readCalls: 0,
        endpointListCalls: 0,
        totalCalls: 0,
      },
      recoveredCalls: [
        {
          httpMethod: 'GET',
          path: '/api/orders',
        },
      ],
    });
    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.candidateCount).toBe(1);
  });

  it('eligible가 아니면 optional deep inspection을 실행하지 않아야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return fetch("http://orders/api/orders"); }\n',
    );
    writeFileSync(
      join(ordersDir, 'OrderController.java'),
      [
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '@RestController',
        'public class OrderController {',
        '  @GetMapping("/api/orders")',
        '  public String getOrders() { return "ok"; }',
        '}',
      ].join('\n'),
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const runDeepInspection = vi.fn(async () => ({ calls: [] }));

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway definitely calls orders',
            confidence: 0.93,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/api/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/api/orders")',
            confidence: 0.94,
          },
        ],
      }),
      runDeepInspection,
    });

    expect(runDeepInspection).not.toHaveBeenCalled();
    expect(result.phase3.deepInspectionCount).toBe(0);
    expect(result.phase3.deepInspectionTrace).toMatchObject({
      attemptedCount: 0,
      failureCount: 0,
      triggerBreakdown: {
        lowConfidence: 0,
        insufficientContext: 0,
      },
    });
    expect(result.phase3.deepInspectionTrace.details).toEqual([]);
    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.candidateCount).toBe(1);
  });

  it('INSUFFICIENT_CONTEXT fallback이면 deepInspectionTrace의 insufficientContext trigger를 집계해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return maybeCallOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const runDeepInspection = vi.fn(async () => ({ calls: [] }));

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway calls orders',
            confidence: 0.93,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'unknown-service',
            httpMethod: '',
            path: '',
            sourceFile: 'client.ts',
            evidence: 'wrapper hides concrete endpoint details',
            confidence: 0.42,
          },
        ],
      }),
      runDeepInspection,
    });

    expect(runDeepInspection).toHaveBeenCalledTimes(1);
    expect(result.phase3.deepInspectionCount).toBe(1);
    expect(result.phase3.deepInspectionTrace).toMatchObject({
      attemptedCount: 1,
      failureCount: 0,
      triggerBreakdown: {
        lowConfidence: 0,
        insufficientContext: 1,
      },
    });
    expect(result.phase3.deepInspectionTrace.details).toHaveLength(1);
    expect(result.phase3.deepInspectionTrace.details[0]).toMatchObject({
      consumerServiceName: 'gateway',
      providerServiceName: 'orders',
      trigger: {
        lowConfidence: false,
        insufficientContext: true,
      },
      status: 'no_result',
      fallbackReasons: ['INSUFFICIENT_CONTEXT'],
      toolUsage: {
        searchCalls: 0,
        readCalls: 0,
        endpointListCalls: 0,
        totalCalls: 0,
      },
      recoveredCalls: [],
    });
  });

  it('deep inspection이 실패해도 기본 Smart 결과를 유지해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(
      join(gatewayDir, 'application.yml'),
      [
        'spring.application.name=gateway',
        'orders.base-url=http://orders',
      ].join('\n'),
    );
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return fetch("http://orders/api/orders"); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    await db.insert(objects).values([gateway, orders]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runDeepInspection = vi.fn(async () => {
      throw new Error('deep inspection failed');
    });

    try {
      const result = await executeSmartPipeline(db, {
        workspaceId,
        repoRoots: [rootDir],
        generateConfigAnalysis: async () => ({
          dependencies: [
            {
              targetService: 'orders',
              relationType: 'call',
              evidence: 'gateway may call orders',
              confidence: 0.7,
            },
          ],
          detectedServiceName: 'gateway',
        }),
        generateCallExtraction: async () => ({
          calls: [
            {
              targetService: 'orders',
              httpMethod: 'GET',
              path: '/api/orders',
              sourceFile: 'client.ts',
              evidence: 'fetch("http://orders/api/orders")',
              confidence: 0.9,
            },
          ],
        }),
        runDeepInspection,
      });

      expect(runDeepInspection).toHaveBeenCalledTimes(1);
      expect(result.phase3.deepInspectionCount).toBe(1);
      expect(result.phase3.deepInspectionTrace).toMatchObject({
        attemptedCount: 1,
        failureCount: 1,
        triggerBreakdown: {
          lowConfidence: 1,
          insufficientContext: 0,
        },
      });
      expect(result.phase3.deepInspectionTrace.details).toHaveLength(1);
      expect(result.phase3.deepInspectionTrace.details[0]).toMatchObject({
        consumerServiceName: 'gateway',
        providerServiceName: 'orders',
        trigger: {
          lowConfidence: true,
          insufficientContext: false,
        },
        status: 'failed',
        fallbackReasons: ['NO_ENDPOINT_OBJECTS'],
        recoveredCalls: [],
      });
      expect(result.phase3.atomicCandidateCount).toBe(0);
      expect(result.phase3.serviceFallbackCount).toBe(1);
      expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
        NO_ENDPOINT_OBJECTS: 1,
        PATH_NOT_MATCHED: 0,
        METHOD_NOT_MATCHED: 0,
        INSUFFICIENT_CONTEXT: 0,
      });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('deepInspectionTools로 endpoint를 복구하면 atomic candidate로 저장해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return callOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    const searchFiles = vi.fn(async () => [
      {
        path: 'client.ts',
        snippet: 'fetch("http://orders/api/orders")',
      },
    ]);
    const readFile = vi.fn(async () => ({
      path: 'client.ts',
      content: 'export async function loadOrders(){ return fetch("http://orders/api/orders"); }',
    }));
    const listServiceEndpoints = vi.fn(async () => [
      {
        method: 'GET',
        path: '/api/orders',
      },
    ]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway may call orders',
            confidence: 0.7,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
      deepInspectionTools: {
        searchFiles,
        readFile,
        listServiceEndpoints,
      },
    });

    expect(listServiceEndpoints).toHaveBeenCalledWith({ serviceName: 'orders' });
    expect(searchFiles).toHaveBeenCalled();
    expect(readFile).toHaveBeenCalled();
    expect(result.phase3.deepInspectionCount).toBe(1);
    expect(result.phase3.deepInspectionTrace).toMatchObject({
      attemptedCount: 1,
      failureCount: 0,
      triggerBreakdown: {
        lowConfidence: 1,
        insufficientContext: 0,
      },
    });
    expect(result.phase3.deepInspectionTrace.details).toHaveLength(1);
    const recoveredDetail = result.phase3.deepInspectionTrace.details[0];
    expect(recoveredDetail).toBeDefined();
    expect(recoveredDetail?.status).toBe('succeeded');
    expect(recoveredDetail?.consumerServiceName).toBe('gateway');
    expect(recoveredDetail?.providerServiceName).toBe('orders');
    expect(recoveredDetail?.toolUsage.endpointListCalls).toBe(1);
    expect((recoveredDetail?.toolUsage.searchCalls ?? 0) > 0).toBe(true);
    expect((recoveredDetail?.toolUsage.readCalls ?? 0) > 0).toBe(true);
    expect(recoveredDetail?.recoveredCalls).toEqual([
      {
        httpMethod: 'GET',
        path: '/api/orders',
      },
    ]);
    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.serviceFallbackCount).toBe(0);
  });

  it('initialCalls가 비어도 search/read evidence의 concrete path로 templated endpoint를 복구해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrderById() { return callOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders/{id}',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders/{id}' },
      },
    ]);

    const searchFiles = vi.fn(async () => [
      {
        path: 'client.ts',
        snippet: 'GET https://orders.internal/api/orders/123?include=items#detail',
      },
    ]);
    const readFile = vi.fn(async () => ({
      path: 'client.ts',
      content: [
        'export async function loadOrderById() {',
        '  return fetch("https://orders.internal/api/orders/123?include=items#detail");',
        '}',
      ].join('\n'),
    }));
    const listServiceEndpoints = vi.fn(async () => [
      {
        method: 'GET',
        path: '/api/orders/{id}',
      },
    ]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway may call orders',
            confidence: 0.72,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
      deepInspectionTools: {
        searchFiles,
        readFile,
        listServiceEndpoints,
      },
    });

    expect(result.phase3.deepInspectionCount).toBe(1);
    expect(result.phase3.atomicCandidateCount).toBe(1);
    expect(result.phase3.serviceFallbackCount).toBe(0);

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    const atomicCandidate = candidates.find((candidate) => candidate.objectId === endpointId);
    expect(atomicCandidate).toBeDefined();
  });

  it('deepInspectionTools가 budget에 막히면 기본 fallback 결과를 유지해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return callOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    const searchFiles = vi.fn(async () => [
      {
        path: 'client.ts',
        snippet: 'fetch("http://orders/api/orders")',
      },
    ]);
    const readFile = vi.fn(async () => ({
      path: 'client.ts',
      content: 'export async function loadOrders(){ return fetch("http://orders/api/orders"); }',
    }));
    const listServiceEndpoints = vi.fn(async () => [
      {
        method: 'GET',
        path: '/api/orders',
      },
    ]);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway may call orders',
            confidence: 0.7,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({
        calls: [
          {
            targetService: 'orders',
            httpMethod: 'GET',
            path: '/v1/orders',
            sourceFile: 'client.ts',
            evidence: 'fetch("http://orders/v1/orders")',
            confidence: 0.8,
          },
        ],
      }),
      deepInspectionTools: {
        searchFiles,
        readFile,
        listServiceEndpoints,
      },
      deepInspectionBudget: {
        maxTotalToolCalls: 1,
      },
    });

    expect(listServiceEndpoints).toHaveBeenCalledTimes(1);
    expect(searchFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(result.phase3.deepInspectionCount).toBe(1);
    expect(result.phase3.atomicCandidateCount).toBe(0);
    expect(result.phase3.serviceFallbackCount).toBe(1);
    expect(result.phase3.fallbackReasonBreakdown).toMatchObject({
      NO_ENDPOINT_OBJECTS: 0,
      PATH_NOT_MATCHED: 1,
      METHOD_NOT_MATCHED: 0,
      INSUFFICIENT_CONTEXT: 0,
    });
  });

  it('deepInspectionTools에서 예외가 나도 파이프라인은 기본 결과를 유지해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return callOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listServiceEndpoints = vi.fn(async () => {
      throw new Error('tool failed');
    });

    try {
      const result = await executeSmartPipeline(db, {
        workspaceId,
        repoRoots: [rootDir],
        generateConfigAnalysis: async () => ({
          dependencies: [
            {
              targetService: 'orders',
              relationType: 'call',
              evidence: 'gateway may call orders',
              confidence: 0.7,
            },
          ],
          detectedServiceName: 'gateway',
        }),
        generateCallExtraction: async () => ({
          calls: [
            {
              targetService: 'orders',
              httpMethod: 'GET',
              path: '/v1/orders',
              sourceFile: 'client.ts',
              evidence: 'fetch("http://orders/v1/orders")',
              confidence: 0.8,
            },
          ],
        }),
        deepInspectionTools: {
          searchFiles: async () => [],
          readFile: async () => null,
          listServiceEndpoints,
        },
      });

      expect(listServiceEndpoints).toHaveBeenCalledTimes(1);
      expect(result.phase3.deepInspectionCount).toBe(1);
      expect(result.phase3.deepInspectionTrace).toMatchObject({
        attemptedCount: 1,
        failureCount: 1,
        triggerBreakdown: {
          lowConfidence: 1,
          insufficientContext: 0,
        },
      });
      expect(result.phase3.deepInspectionTrace.details).toHaveLength(1);
      expect(result.phase3.deepInspectionTrace.details[0]).toMatchObject({
        consumerServiceName: 'gateway',
        providerServiceName: 'orders',
        status: 'failed',
        fallbackReasons: ['PATH_NOT_MATCHED'],
        toolUsage: {
          endpointListCalls: 1,
        },
        recoveredCalls: [],
      });
      expect(result.phase3.atomicCandidateCount).toBe(0);
      expect(result.phase3.serviceFallbackCount).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('runDeepInspection이 있으면 deepInspectionTools보다 우선해야 한다', async () => {
    const gatewayDir = join(rootDir, 'gateway');
    const ordersDir = join(rootDir, 'orders');
    mkdirSync(gatewayDir, { recursive: true });
    mkdirSync(ordersDir, { recursive: true });

    writeFileSync(join(gatewayDir, 'application.yml'), 'spring.application.name=gateway');
    writeFileSync(
      join(gatewayDir, 'client.ts'),
      'export async function loadOrders() { return callOrders(); }\n',
    );

    const gateway = createService(gatewayDir, 'gateway');
    const orders = createService(ordersDir, 'orders');
    const endpointId = generateId();
    await db.insert(objects).values([
      gateway,
      orders,
      {
        id: endpointId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'COMPUTE',
        granularity: 'ATOMIC',
        name: 'GET /api/orders',
        parentId: orders.id,
        path: `/orders/${endpointId}`,
        depth: 1,
        visibility: 'VISIBLE',
        metadata: { method: 'GET', path: '/api/orders' },
      },
    ]);

    const runDeepInspection = vi.fn(async () => ({
      calls: [
        {
          targetService: 'orders',
          httpMethod: 'GET',
          path: '/api/orders',
          sourceFile: 'client.ts',
          evidence: 'custom hook recovered endpoint',
          confidence: 0.95,
        },
      ],
    }));
    const searchFiles = vi.fn(async () => []);
    const readFile = vi.fn(async () => null);
    const listServiceEndpoints = vi.fn(async () => []);

    const result = await executeSmartPipeline(db, {
      workspaceId,
      repoRoots: [rootDir],
      generateConfigAnalysis: async () => ({
        dependencies: [
          {
            targetService: 'orders',
            relationType: 'call',
            evidence: 'gateway may call orders',
            confidence: 0.7,
          },
        ],
        detectedServiceName: 'gateway',
      }),
      generateCallExtraction: async () => ({ calls: [] }),
      runDeepInspection,
      deepInspectionTools: {
        searchFiles,
        readFile,
        listServiceEndpoints,
      },
    });

    expect(runDeepInspection).toHaveBeenCalledTimes(1);
    expect(listServiceEndpoints).not.toHaveBeenCalled();
    expect(searchFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(result.phase3.deepInspectionCount).toBe(1);
    expect(result.phase3.atomicCandidateCount).toBe(1);
  });
});
