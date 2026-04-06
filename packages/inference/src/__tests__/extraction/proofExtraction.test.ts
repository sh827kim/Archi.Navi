import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  aliasBindings,
  closeTestDb,
  codeArtifacts,
  codeCallEdges,
  createTestDb,
  evidences,
  functionSummaries,
  getEmbeddedPostgresTestSupport,
  interactionIntents,
  objects,
  proofStates,
  relationCandidates,
  routeTransforms,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { extractAliasBindingsFromCodeSignals, extractAliasBindingsFromConfig } from '@/extraction/aliasBindings';
import { extractFunctionSummariesFromCodeSignals } from '@/extraction/functionSummary';
import {
  extractInteractionIntentsFromCodeSignals,
  extractInteractionIntentsFromConfigRoutes,
} from '@/extraction/intents';
import { stableHash } from '@/extraction/shared';
import { extractAstCodeSignals } from '@/code/ast/extractAstCodeSignals';
import { extractRouteTransformsFromConfig } from '@/extraction/routeTransforms';
import type { GatewayRouteTransformPlugin } from '@/extraction/routeTransforms';

const workspaceId = '00000000-0000-0000-0000-000000000654';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

if (!embeddedSupport.supported) {
  console.warn(
    `[inference:test] skipping proof extraction integration tests: ${
      embeddedSupport.reason ?? 'unsupported test database environment'
    }`,
  );
}

async function insertObject(
  db: TestDb,
  input: {
    id?: string;
    objectType: string;
    name: string;
    parentId?: string | null;
    category?: string;
    granularity?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const id = input.id ?? generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: input.objectType,
    category: input.category ?? (input.objectType === 'service' || input.objectType === 'function' ? 'COMPUTE' : 'CHANNEL'),
    granularity: input.granularity ?? (input.objectType === 'service' ? 'COMPOUND' : 'ATOMIC'),
    name: input.name,
    parentId: input.parentId ?? null,
    path: `/${id}`,
    depth: input.parentId ? 1 : 0,
    visibility: 'VISIBLE',
    metadata: input.metadata ?? {},
  });
  return id;
}

describeDb('proof extraction', () => {
  let db: TestDb;
  let repoRoot: string | null = null;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'proof-extraction' });
    repoRoot = mkdtempSync(join(tmpdir(), 'archi-proof-'));
  });

  afterEach(async () => {
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = null;
    }
    await closeTestDb(db);
  });

  it('path-only HTTP call도 function summary와 interaction intent로 보존해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/gateway.ts',
      ownerObjectId: functionId,
      sha256: 'sha-a',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      lineStart: 10,
      lineEnd: 10,
      excerpt: "client.get('/api/orders/123')",
      metadata: {
        kind: 'call',
        method: 'GET',
        confidence: 0.88,
        configKeys: ['orders.base-url'],
        extractionMode: 'ast',
      },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders/123',
      weight: 1,
      evidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-a' });
    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-a' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.summaryKind).toBe('http');
    expect((summaries[0]?.outboundHttp as Record<string, unknown>)['path']).toBe('/api/orders/123');
    expect((summaries[0]?.outboundHttp as Record<string, unknown>)['configKeys']).toEqual(['orders.base-url']);
    expect(summaries[0]?.aliasHints).toEqual(['orders.base-url']);
    expect(summaries[0]?.signalSources).toEqual(['ast']);
    expect(summaries[0]?.extractionStrategy).toBe('ast_primary');
    expect(summaries[0]?.provenanceEvidenceIds).toEqual([evidenceId]);
    expect(summaries[0]?.unresolvedReasons).toEqual([]);
    expect(summaries[0]?.summaryCompleteness).toBe(1);

    const intents = await db.select().from(interactionIntents).where(eq(interactionIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.intentType).toBe('http_call');
    expect(intents[0]?.sourceServiceId).toBe(serviceId);
    expect(intents[0]?.sourceFunctionId).toBe(functionId);
    expect(intents[0]?.externalPathHint).toBe('/api/orders/123');
    expect(intents[0]?.hostHint).toBeNull();
    expect(intents[0]?.configKeys).toEqual(['orders.base-url']);
    expect(intents[0]?.summaryRefs).toEqual([summaries[0]?.id]);
  });

  it('동일 function의 outbound 변화는 summary version을 올리고 기존 row를 supersede 해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/gateway.ts',
      ownerObjectId: functionId,
      sha256: 'sha-a',
    });

    const firstEvidenceId = generateId();
    await db.insert(evidences).values({
      id: firstEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      lineStart: 10,
      lineEnd: 10,
      excerpt: "client.get('/api/orders/123')",
      metadata: { kind: 'call', method: 'GET', confidence: 0.9 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders/123',
      weight: 1,
      evidenceId: firstEvidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-a' });

    await db.delete(codeCallEdges).where(eq(codeCallEdges.callerArtifactId, artifactId));
    const secondEvidenceId = generateId();
    await db.insert(evidences).values({
      id: secondEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      lineStart: 12,
      lineEnd: 12,
      excerpt: "client.post('/api/orders')",
      metadata: { kind: 'call', method: 'POST', confidence: 0.93 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders',
      weight: 1,
      evidenceId: secondEvidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-b' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(2);
    const active = summaries.find((summary) => summary.status === 'ACTIVE');
    const superseded = summaries.find((summary) => summary.status === 'SUPERSEDED');
    expect(active?.summaryVersion).toBe(2);
    expect((active?.outboundHttp as Record<string, unknown>)['method']).toBe('POST');
    expect(superseded?.summaryVersion).toBe(1);
  });

  it('최신 code signal pass에서 사라진 interaction intent는 정리되어야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/gateway.ts',
      ownerObjectId: functionId,
      sha256: 'sha-intent-retire',
    });

    const firstEvidenceId = generateId();
    await db.insert(evidences).values({
      id: firstEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/gateway.ts',
      lineStart: 10,
      lineEnd: 10,
      excerpt: "client.get('/api/orders/123')",
      metadata: { kind: 'call', method: 'GET', confidence: 0.9 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders/123',
      weight: 1,
      evidenceId: firstEvidenceId,
    });

    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-a' });

    let intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, functionId)));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.externalPathHint).toBe('/api/orders/123');

    await db.delete(codeCallEdges).where(eq(codeCallEdges.callerArtifactId, artifactId));
    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-b' });

    intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, functionId)));
    expect(intents).toHaveLength(0);
  });

  it('dynamic/truncated HTTP signal은 unresolved reason과 completeness 저하를 보존해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrderDynamic',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/dynamic-gateway.ts',
      ownerObjectId: functionId,
      sha256: 'sha-dynamic-http',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/dynamic-gateway.ts',
      lineStart: 20,
      lineEnd: 20,
      excerpt: 'client.request(pathTemplate)',
      metadata: {
        kind: 'call',
        confidence: 0.63,
        extractionMode: 'regex',
        truncated: true,
      },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders/${orderId}',
      weight: 1,
      evidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-dynamic-http' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.signalSources).toEqual(['regex']);
    expect(summaries[0]?.extractionStrategy).toBe('legacy_edges_fallback');
    expect(summaries[0]?.provenanceEvidenceIds).toEqual([evidenceId]);
    expect(summaries[0]?.unresolvedReasons).toEqual([
      'dynamic_http_path',
      'missing_http_method',
      'missing_http_provider_hint',
      'truncated_signal',
    ]);
    expect(summaries[0]?.summaryCompleteness).toBe(0.15);
    expect(summaries[0]?.flags).toMatchObject({
      truncated: true,
      dynamicPath: true,
      dynamicHost: false,
      unsupportedPattern: false,
      astBacked: false,
    });
  });

  it('Zuul config는 gateway target alias와 route transform IR로 저장해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const targetServiceId = await insertObject(db, { objectType: 'service', name: 'order-service' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    orders:',
        '      path: /api/orders/**',
        '      serviceId: order-service',
      ].join('\n'),
      'utf-8',
    );

    await extractAliasBindingsFromConfig(db, { workspaceId, repoRoot, runId: 'run-c' });
    await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot, runId: 'run-c' });

    const bindings = await db
      .select()
      .from(aliasBindings)
      .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.bindingKind, 'gateway_target')));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.aliasKey).toBe('order-service');
    expect(bindings[0]?.resolvedServiceId).toBe(targetServiceId);

    const transforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.gatewayKind).toBe('zuul');
    expect(transforms[0]?.matchPath).toBe('/api/orders/**');
    expect(transforms[0]?.matchMode).toBe('prefix');
    expect(transforms[0]?.stripPrefixCount).toBe(1);
    expect(transforms[0]?.pathCapturePolicy).toBe('glob');
    expect(transforms[0]?.prependPrefix).toBeNull();
    expect(transforms[0]?.routeMountPrefix).toBeNull();
    expect(transforms[0]?.targetServiceHint).toBe('order-service');
    expect(transforms[0]?.targetPathBaseHint).toBe('/orders');
    expect(transforms[0]?.evidenceIds).toEqual([
      `config_repo:${stableHash([repoRoot])}`,
      expect.stringMatching(/config:.*application\.yml#orders$/),
    ]);
  });

  it('SCG config도 Path/StripPrefix/PrefixPath/RewritePath/lb 형식을 IR로 정규화해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    await insertObject(db, { objectType: 'service', name: 'order-service' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        '  cloud:',
        '    gateway:',
        '      routes:',
        '        - id: orders',
        '          uri: lb://order-service',
        '          predicates:',
        '            - Path=/api/orders/**',
        '          filters:',
        '            - StripPrefix=1',
        '            - PrefixPath=/gateway',
        '            - RewritePath=/orders/(?<id>.*), /internal/orders/$1',
      ].join('\n'),
      'utf-8',
    );

    const result = await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot, runId: 'run-scg' });

    expect(result).toMatchObject({
      routeTransformCount: 1,
      fileCount: 1,
      processedFileCount: 1,
    });

    const transforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.gatewayKind).toBe('spring_cloud_gateway');
    expect(transforms[0]?.matchPath).toBe('/api/orders/**');
    expect(transforms[0]?.matchMode).toBe('prefix');
    expect(transforms[0]?.stripPrefixCount).toBe(1);
    expect(transforms[0]?.prependPrefix).toBe('/gateway');
    expect(transforms[0]?.routeMountPrefix).toBe('/gateway');
    expect(transforms[0]?.rewriteRegex).toBe('/orders/(?<id>.*)');
    expect(transforms[0]?.rewriteReplacement).toBe('/internal/orders/$1');
    expect(transforms[0]?.targetServiceHint).toBe('order-service');
    expect(transforms[0]?.targetPathBaseHint).toBe('/orders');
    expect(transforms[0]?.targetHostAlias).toBeNull();
    expect(transforms[0]?.ownerServiceId).toBe(gatewayServiceId);
    expect(transforms[0]?.evidenceIds).toEqual([
      `config_repo:${stableHash([repoRoot])}`,
      expect.stringMatching(/config:.*application\.yml#orders$/),
    ]);
  });

  it('alias binding 재추출 시 동일 alias key의 이전 ACTIVE binding을 SUPERSEDED로 전환해야 한다', async () => {
    await insertObject(db, { objectType: 'service', name: 'gateway' });
    const orderServiceId = await insertObject(db, { objectType: 'service', name: 'order-service' });
    const paymentServiceId = await insertObject(db, { objectType: 'service', name: 'payment-service' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: gateway',
        'clients:',
        '  order-service:',
        '    base-url: http://order-service',
      ].join('\n'),
      'utf-8',
    );
    await extractAliasBindingsFromConfig(db, { workspaceId, repoRoot, runId: 'run-alias-v1' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: gateway',
        'clients:',
        '  order-service:',
        '    base-url: http://payment-service',
      ].join('\n'),
      'utf-8',
    );
    await extractAliasBindingsFromConfig(db, { workspaceId, repoRoot, runId: 'run-alias-v2' });

    const bindings = await db
      .select()
      .from(aliasBindings)
      .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.aliasKey, 'clients.order-service.base-url')));
    expect(bindings).toHaveLength(2);

    const activeBindings = bindings.filter((binding) => binding.status === 'ACTIVE');
    expect(activeBindings).toHaveLength(1);
    expect(activeBindings[0]?.resolvedServiceId).toBe(paymentServiceId);
    expect(bindings.some((binding) => binding.status === 'SUPERSEDED' && binding.resolvedServiceId === orderServiceId)).toBe(true);
  });

  it('route transform 재추출 시 config에서 사라진 이전 transform을 정리해야 한다', async () => {
    await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    await insertObject(db, { objectType: 'service', name: 'order-service' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    orders:',
        '      path: /api/orders/**',
        '      serviceId: order-service',
      ].join('\n'),
      'utf-8',
    );
    await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot, runId: 'run-route-v1' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    payments:',
        '      path: /api/payments/**',
        '      serviceId: order-service',
      ].join('\n'),
      'utf-8',
    );
    await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot, runId: 'run-route-v2' });

    const transforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.matchPath).toBe('/api/payments/**');
    expect(transforms[0]?.evidenceIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/^config_repo:/),
      expect.stringMatching(/config:.*application\.yml#payments$/),
    ]));
  });

  it('multi-source 추출 시 현재 repo에서 obsolete prune이 다른 repo transform을 삭제하면 안 된다', async () => {
    await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    await insertObject(db, { objectType: 'service', name: 'order-service' });
    await insertObject(db, { objectType: 'service', name: 'payment-service' });

    const anotherRepoRoot = mkdtempSync(join(tmpdir(), 'archi-proof-'));
    try {
      writeFileSync(
        join(repoRoot, 'application.yml'),
        [
          'spring:',
          '  application:',
          '    name: api-gateway',
          'zuul:',
          '  routes:',
          '    orders:',
          '      path: /api/orders/**',
          '      serviceId: order-service',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(
        join(anotherRepoRoot, 'application.yml'),
        [
          'spring:',
          '  application:',
          '    name: api-gateway',
          'zuul:',
          '  routes:',
          '    payments:',
          '      path: /api/payments/**',
          '      serviceId: payment-service',
        ].join('\n'),
        'utf-8',
      );

      await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot, runId: 'run-multi-source' });
      await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot: anotherRepoRoot, runId: 'run-multi-source' });

      const transforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
      expect(transforms).toHaveLength(2);
      expect(transforms.map((row) => row.matchPath).sort()).toEqual(['/api/orders/**', '/api/payments/**']);
    } finally {
      rmSync(anotherRepoRoot, { recursive: true, force: true });
    }
  });

  it('custom gateway plugin은 supportsFile로 기본 파일명 밖에서도 route transform을 추출할 수 있어야 한다', async () => {
    await insertObject(db, { objectType: 'service', name: 'edge-gateway' });
    await insertObject(db, { objectType: 'service', name: 'order-service' });

    writeFileSync(
      join(repoRoot, 'edge.routes.yml'),
      [
        'custom-gateway:',
        '  enabled: true',
      ].join('\n'),
      'utf-8',
    );

    const customPlugin: GatewayRouteTransformPlugin = {
      id: 'custom-gateway-test',
      displayName: 'Custom Gateway Test Plugin',
      supportsFile({ filePath }) {
        return filePath.endsWith('edge.routes.yml');
      },
      extract({ content, filePath }) {
        if (!filePath.endsWith('edge.routes.yml')) return null;
        if (!content.includes('custom-gateway')) return null;
        return {
          ownerServiceName: 'edge-gateway',
          routes: [
            {
              routeKey: 'orders-custom',
              gatewayKind: 'custom',
              matchPath: '/edge/orders/(.*)',
              matchMode: 'regex',
              targetServiceHint: 'order-service',
              stripPrefixCount: 0,
              prependPrefix: '/internal',
              matchHost: 'edge.company.internal',
              rewriteRegex: null,
              rewriteReplacement: null,
              pathCapturePolicy: 'regex_capture',
              routeMountPrefix: '/edge',
              targetPathBaseHint: '/orders/internal',
              targetHostAlias: 'orders.internal',
              priority: 17,
            },
          ],
        };
      },
    };

    const result = await extractRouteTransformsFromConfig(db, {
      workspaceId,
      repoRoot,
      runId: 'run-custom-plugin',
      plugins: [customPlugin],
    });

    expect(result).toMatchObject({
      routeTransformCount: 1,
      fileCount: 1,
      processedFileCount: 1,
    });
    const transforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.gatewayKind).toBe('custom');
    expect(transforms[0]?.matchPath).toBe('/edge/orders/(.*)');
    expect(transforms[0]?.matchMode).toBe('regex');
    expect(transforms[0]?.matchHost).toBe('edge.company.internal');
    expect(transforms[0]?.prependPrefix).toBe('/internal');
    expect(transforms[0]?.pathCapturePolicy).toBe('regex_capture');
    expect(transforms[0]?.routeMountPrefix).toBe('/edge');
    expect(transforms[0]?.targetServiceHint).toBe('order-service');
    expect(transforms[0]?.targetHostAlias).toBe('orders.internal');
    expect(transforms[0]?.targetPathBaseHint).toBe('/orders/internal');
    expect(transforms[0]?.priority).toBe(17);
  });

  it('config-only gateway route도 proof engine용 interaction intent로 승격해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    await insertObject(db, { objectType: 'service', name: 'article-service' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'zuul:',
        '  routes:',
        '    articles:',
        '      path: /api/articles/**',
        '      serviceId: article-service',
      ].join('\n'),
      'utf-8',
    );

    const result = await extractInteractionIntentsFromConfigRoutes(db, {
      workspaceId,
      repoRoot,
      runId: 'run-config-intent',
    });

    expect(result.intentCount).toBe(1);
    expect(result.gatewayRouteSeedCount).toBe(1);
    const intents = await db.select().from(interactionIntents).where(eq(interactionIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.intentType).toBe('http_gateway_route');
    expect(intents[0]?.sourceServiceId).toBe(gatewayServiceId);
    expect(intents[0]?.sourceFunctionId).toBeNull();
    expect(intents[0]?.gatewayKind).toBe('zuul');
    expect(intents[0]?.routeScopeKind).toBe('prefix');
    expect(intents[0]?.externalRoutePattern).toBe('/api/articles/**');
    expect(intents[0]?.providerHint).toBe('article-service');
    expect(intents[0]?.targetServiceHint).toBe('article-service');
    expect(intents[0]?.methodConstraint).toBe('unknown');
    expect(intents[0]?.hostHint).toBe('article-service');
    expect(intents[0]?.externalPathHint).toBe('/api/articles');
    expect(intents[0]?.evidenceIds).toEqual([expect.stringMatching(/config:.*application\.yml#articles$/)]);
  });

  it('SCG config route도 proof engine용 interaction intent로 승격해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    await insertObject(db, { objectType: 'service', name: 'order-service' });

    writeFileSync(
      join(repoRoot, 'application.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        '  cloud:',
        '    gateway:',
        '      routes:',
        '        - id: orders',
        '          uri: lb://order-service',
        '          predicates:',
        '            - Path=/api/orders/**',
      ].join('\n'),
      'utf-8',
    );

    const result = await extractInteractionIntentsFromConfigRoutes(db, {
      workspaceId,
      repoRoot,
      runId: 'run-config-scg-intent',
    });

    expect(result.intentCount).toBe(1);
    expect(result.gatewayRouteSeedCount).toBe(1);
    const intents = await db.select().from(interactionIntents).where(eq(interactionIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      intentType: 'http_gateway_route',
      sourceServiceId: gatewayServiceId,
      sourceFunctionId: null,
      gatewayKind: 'spring_cloud_gateway',
      routeScopeKind: 'prefix',
      externalRoutePattern: '/api/orders/**',
      providerHint: 'order-service',
      targetServiceHint: 'order-service',
      methodConstraint: 'unknown',
      hostHint: 'order-service',
      externalPathHint: '/api/orders',
    });
  });

  it('code signal에서 사라진 intent를 retire할 때 proof-projected candidate도 함께 삭제해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      repoRoot,
      filePath: 'src/GatewayClient.ts',
      language: 'typescript',
      artifactType: 'source_file',
      ownerObjectId: functionId,
      contentHash: 'artifact-hash-1',
      metadata: {},
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/GatewayClient.ts',
      excerpt: 'axios.get("http://ORDER_SERVICE/api/orders")',
      metadata: { kind: 'http_call', method: 'GET' },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'http://ORDER_SERVICE/api/orders',
      relationType: 'calls',
      evidenceId,
      createdAt: new Date(),
    });

    await extractInteractionIntentsFromCodeSignals(db, {
      workspaceId,
      repoRoot,
      runId: 'run-intent-initial',
    });

    const [intent] = await db.select().from(interactionIntents).where(eq(interactionIntents.workspaceId, workspaceId));
    expect(intent).toBeDefined();

    const proofStateId = generateId();
    await db.insert(proofStates).values({
      id: proofStateId,
      workspaceId,
      intentId: intent!.id,
      proofType: 'http_call',
      status: 'NEW',
      consumerServiceId: serviceId,
      sourceFunctionId: functionId,
    });

    await db.insert(relationCandidates).values({
      id: generateId(),
      workspaceId,
      relationType: 'calls',
      subjectObjectId: serviceId,
      objectId: serviceId,
      confidence: 0.9,
      status: 'APPROVED',
      metadata: { source: 'intent_proof', proofStateId },
    });

    await db.delete(codeCallEdges).where(eq(codeCallEdges.callerArtifactId, artifactId));

    await extractInteractionIntentsFromCodeSignals(db, {
      workspaceId,
      repoRoot,
      runId: 'run-intent-retire',
    });

    const intentsAfter = await db.select().from(interactionIntents).where(eq(interactionIntents.workspaceId, workspaceId));
    const candidatesAfter = await db.select().from(relationCandidates).where(eq(relationCandidates.workspaceId, workspaceId));
    expect(intentsAfter).toHaveLength(0);
    expect(candidatesAfter).toHaveLength(0);
  });

  it('AST ingest가 만든 function owner를 function summary와 interaction intent가 그대로 사용해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });

    const srcDir = join(repoRoot, 'gateway', 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'OrderClient.ts'),
      `class OrderClient {
  async fetchOrder() {
    return axios.get('/api/orders');
  }
}`,
      'utf-8',
    );

    await extractAstCodeSignals(db, { workspaceId, repoRoot });
    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-ast-owner' });
    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-ast-owner' });

    const generatedFunctions = await db
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'function'),
          eq(objects.parentId, serviceId),
        ),
      );
    expect(generatedFunctions).toHaveLength(1);

    const generatedFunctionId = generatedFunctions[0]?.id;
    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, generatedFunctionId!)));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.signalSources).toEqual(['ast']);
    expect(summaries[0]?.extractionStrategy).toBe('ast_primary');

    const intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, generatedFunctionId!)));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.sourceServiceId).toBe(serviceId);
    expect(intents[0]?.sourceFunctionId).toBe(generatedFunctionId);
    expect(intents[0]?.externalPathHint).toBe('/api/orders');
  });

  it('stale ownerFunctionId가 있어도 ownerFunctionKey로 function summary와 interaction intent를 복구해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/stale-owner.ts',
      ownerObjectId: serviceId,
      sha256: 'sha-stale-owner',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/stale-owner.ts',
      lineStart: 7,
      lineEnd: 7,
      excerpt: "return axios.get('/api/orders');",
      metadata: {
        kind: 'call',
        method: 'GET',
        confidence: 0.91,
        ownerFunctionId: generateId(),
        ownerFunctionKey: 'src/stale-owner.ts::_::GatewayClient.fetchOrder::7-9',
        ownerFunctionName: 'GatewayClient.fetchOrder',
      },
    });
    await db.update(objects).set({
      metadata: {
        functionKey: 'src/stale-owner.ts::_::GatewayClient.fetchOrder::7-9',
      },
    }).where(eq(objects.id, functionId));

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: '/api/orders',
      weight: 1,
      evidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-stale-owner' });
    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-stale-owner' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);

    const intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, functionId)));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.sourceServiceId).toBe(serviceId);
  });

  it('DB config key는 function summary aliasHints와 interaction intent에 보존해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayRepository.loadOrders',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/repository.ts',
      ownerObjectId: functionId,
      sha256: 'sha-db-config',
    });

    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/repository.ts',
      lineStart: 14,
      lineEnd: 14,
      excerpt: 'jdbc.query("select * from orders")',
      metadata: {
        kind: 'db_read',
        configKeys: ['spring.datasource.orders'],
      },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'public.orders',
      weight: 1,
      evidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-db-config' });
    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-db-config' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.aliasHints).toContain('spring.datasource.orders');

    const intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, functionId)));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.intentType).toBe('db_access');
    expect(intents[0]?.configKeys).toEqual(['spring.datasource.orders']);
    expect(intents[0]?.dbSchemaHint).toBe('public');
    expect(intents[0]?.dbTableHints).toEqual(['orders']);
  });

  it('HTTP host는 code signal에서 service discovery alias binding으로 캐시해야 한다', async () => {
    await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: await insertObject(db, { objectType: 'service', name: 'caller-service' }),
      category: 'CODE',
    });
    const targetServiceId = await insertObject(db, { objectType: 'service', name: 'order-api' });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/Caller.java',
      ownerObjectId: functionId,
      sha256: 'sha-b',
    });
    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/Caller.java',
      lineStart: 4,
      lineEnd: 4,
      excerpt: 'restTemplate.getForObject("http://order-api.internal/api/orders", String.class)',
      metadata: { kind: 'call', confidence: 0.91 },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'http://order-api.internal/api/orders',
      weight: 1,
      evidenceId,
    });

    await extractAliasBindingsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-d' });

    const bindings = await db.select().from(aliasBindings).where(eq(aliasBindings.workspaceId, workspaceId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.bindingKind).toBe('service_discovery');
    expect(bindings[0]?.aliasKey).toBe('order-api.internal');
    expect(bindings[0]?.resolvedServiceId).toBe(targetServiceId);
  });

  it('code config key alias binding은 source service 단위로 owner를 분리해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const billingServiceId = await insertObject(db, { objectType: 'service', name: 'billing-service' });
    await insertObject(db, { objectType: 'service', name: 'order-service' });
    await insertObject(db, { objectType: 'service', name: 'payment-service' });

    const gatewayFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: gatewayServiceId,
      category: 'CODE',
    });
    const billingFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'BillingClient.fetchPayment',
      parentId: billingServiceId,
      category: 'CODE',
    });

    const gatewayArtifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: gatewayArtifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/GatewayClient.java',
      ownerObjectId: gatewayFunctionId,
      sha256: 'sha-gateway',
    });
    const billingArtifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: billingArtifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath: 'src/BillingClient.java',
      ownerObjectId: billingFunctionId,
      sha256: 'sha-billing',
    });

    const gatewayEvidenceId = generateId();
    await db.insert(evidences).values({
      id: gatewayEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/GatewayClient.java',
      lineStart: 12,
      lineEnd: 12,
      excerpt: 'restTemplate.getForObject(orderBaseUrl + "/api/orders", String.class)',
      metadata: { kind: 'call', configKeys: ['client.api.url'] },
    });
    const billingEvidenceId = generateId();
    await db.insert(evidences).values({
      id: billingEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/BillingClient.java',
      lineStart: 9,
      lineEnd: 9,
      excerpt: 'restTemplate.getForObject(paymentBaseUrl + "/api/payments", String.class)',
      metadata: { kind: 'call', configKeys: ['client.api.url'] },
    });

    await db.insert(codeCallEdges).values([
      {
        id: generateId(),
        workspaceId,
        callerArtifactId: gatewayArtifactId,
        calleeSymbol: 'http://order-service.internal/api/orders',
        weight: 1,
        evidenceId: gatewayEvidenceId,
      },
      {
        id: generateId(),
        workspaceId,
        callerArtifactId: billingArtifactId,
        calleeSymbol: 'http://payment-service.internal/api/payments',
        weight: 1,
        evidenceId: billingEvidenceId,
      },
    ]);

    await extractAliasBindingsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-owner-scope' });

    const configBindings = await db
      .select()
      .from(aliasBindings)
      .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.aliasKey, 'client.api.url')));

    expect(configBindings).toHaveLength(2);
    expect(configBindings.every((binding) => binding.status === 'ACTIVE')).toBe(true);
    expect(configBindings.map((binding) => binding.ownerServiceId).sort()).toEqual(
      [billingServiceId, gatewayServiceId].sort(),
    );
  });

  it('config property alias와 route transform IR은 richer slot으로 저장해야 한다', async () => {
    const gatewayServiceId = await insertObject(db, { objectType: 'service', name: 'api-gateway' });
    const targetServiceId = await insertObject(db, { objectType: 'service', name: 'payment-service' });

    writeFileSync(
      join(repoRoot, 'bootstrap.yml'),
      [
        'spring:',
        '  application:',
        '    name: api-gateway',
        'clients:',
        '  payment:',
        '    base-url: http://payment-service.internal',
        'zuul:',
        '  prefix: /gateway',
        '  routes:',
        '    payments:',
        '      path: /payments/**',
        '      serviceId: payment-service',
        '      host: api.company.internal',
        '      rewriteRegex: ^/payments/(.*)$',
        '      rewriteReplacement: /v1/payments/$1',
      ].join('\n'),
      'utf-8',
    );

    await extractAliasBindingsFromConfig(db, { workspaceId, repoRoot, runId: 'run-rich-config' });
    await extractRouteTransformsFromConfig(db, { workspaceId, repoRoot, runId: 'run-rich-config' });

    const bindings = await db
      .select()
      .from(aliasBindings)
      .where(and(eq(aliasBindings.workspaceId, workspaceId), eq(aliasBindings.ownerServiceId, gatewayServiceId)));
    expect(bindings.some((binding) => binding.bindingKind === 'base_url' && binding.aliasKey === 'clients.payment.base-url')).toBe(true);
    expect(bindings.some((binding) => binding.resolvedServiceId === targetServiceId)).toBe(true);

    const transforms = await db.select().from(routeTransforms).where(eq(routeTransforms.workspaceId, workspaceId));
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.matchMode).toBe('prefix');
    expect(transforms[0]?.matchHost).toBe('api.company.internal');
    expect(transforms[0]?.pathCapturePolicy).toBe('glob');
    expect(transforms[0]?.prependPrefix).toBe('/gateway');
    expect(transforms[0]?.routeMountPrefix).toBe('/gateway');
    expect(transforms[0]?.rewriteRegex).toBe('^/payments/(.*)$');
    expect(transforms[0]?.rewriteReplacement).toBe('/v1/payments/$1');
    expect(transforms[0]?.targetPathBaseHint).toBe('/payments');
    expect(transforms[0]?.ownerServiceId).toBe(gatewayServiceId);
  });

  it('DB/Message partial evidence는 multi-hint slot으로 보존해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'billing-service' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'BillingPublisher.publishInvoice',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/billing.ts',
      ownerObjectId: functionId,
      sha256: 'sha-billing',
    });

    const dbEvidenceId = generateId();
    await db.insert(evidences).values({
      id: dbEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/billing.ts',
      lineStart: 10,
      lineEnd: 10,
      excerpt: 'jdbc.query("select * from public.invoices")',
      metadata: {
        kind: 'db_read',
        queryFragmentHash: 'query-fragment-1',
        configKeys: ['spring.datasource.billing'],
        extractionMode: 'ast',
      },
    });
    const messageEvidenceId = generateId();
    await db.insert(evidences).values({
      id: messageEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath: 'src/billing.ts',
      lineStart: 14,
      lineEnd: 14,
      excerpt: 'publisher.publish("invoice.created")',
      metadata: {
        kind: 'produce',
        brokerKind: 'kafka',
        routingKey: 'invoice.created.v1',
        extractionMode: 'hybrid',
      },
    });

    await db.insert(codeCallEdges).values([
      {
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: 'public.invoices',
        weight: 1,
        evidenceId: dbEvidenceId,
      },
      {
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: 'invoice.created',
        weight: 1,
        evidenceId: messageEvidenceId,
      },
    ]);

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-multi-hint' });
    await extractInteractionIntentsFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-multi-hint' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);
    expect((summaries[0]?.outboundDb as Record<string, unknown>)['schemaHints']).toEqual(['public']);
    expect((summaries[0]?.outboundDb as Record<string, unknown>)['tableHints']).toEqual(['invoices']);
    expect((summaries[0]?.outboundMessage as Record<string, unknown>)['brokerKind']).toBe('kafka');
    expect((summaries[0]?.outboundMessage as Record<string, unknown>)['topicHints']).toEqual(['invoice.created']);
    expect((summaries[0]?.outboundMessage as Record<string, unknown>)['routingKeyHints']).toEqual(['invoice.created.v1']);
    expect(summaries[0]?.signalSources).toEqual(['ast', 'hybrid']);
    expect(summaries[0]?.extractionStrategy).toBe('ast_primary');
    expect(summaries[0]?.provenanceEvidenceIds).toEqual([dbEvidenceId, messageEvidenceId]);
    expect(summaries[0]?.unresolvedReasons).toEqual([]);
    expect(summaries[0]?.summaryCompleteness).toBe(1);

    const intents = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.sourceFunctionId, functionId)));
    expect(intents.find((intent) => intent.intentType === 'db_access')?.dbQueryFragmentHash).toBe('query-fragment-1');
    expect(intents.find((intent) => intent.intentType === 'message_publish')?.messageBrokerKind).toBe('kafka');
    expect(intents.find((intent) => intent.intentType === 'message_publish')?.messageTopicHints).toEqual(['invoice.created']);
  });

  it('AST primary와 legacy edge corroboration이 함께 있으면 mixed_signals로 기록하고 primary payload를 유지해야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'GatewayClient.fetchOrder',
      parentId: serviceId,
      category: 'CODE',
    });

    const artifactId = generateId();
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'typescript',
      repoRoot,
      filePath: 'src/gateway-mixed.ts',
      ownerObjectId: functionId,
      sha256: 'sha-mixed-http',
    });

    const astEvidenceId = generateId();
    const legacyEvidenceId = generateId();
    await db.insert(evidences).values([
      {
        id: astEvidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: 'src/gateway-mixed.ts',
        lineStart: 11,
        lineEnd: 11,
        excerpt: "client.get('/api/orders/123')",
        metadata: {
          kind: 'call',
          method: 'GET',
          confidence: 0.9,
          extractionMode: 'ast',
          configKeys: ['orders.base-url'],
        },
      },
      {
        id: legacyEvidenceId,
        workspaceId,
        evidenceType: 'FILE',
        filePath: 'src/gateway-mixed.ts',
        lineStart: 12,
        lineEnd: 12,
        excerpt: 'client.request(dynamicPath)',
        metadata: {
          kind: 'call',
          extractionMode: 'regex',
          truncated: true,
        },
      },
    ]);
    await db.insert(codeCallEdges).values([
      {
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: '/api/orders/123',
        weight: 1,
        evidenceId: astEvidenceId,
      },
      {
        id: generateId(),
        workspaceId,
        callerArtifactId: artifactId,
        calleeSymbol: '/api/orders/${orderId}',
        weight: 1,
        evidenceId: legacyEvidenceId,
      },
    ]);

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot, runId: 'run-mixed-signals' });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.extractionStrategy).toBe('mixed_signals');
    expect(summaries[0]?.signalSources).toEqual(['ast', 'regex']);
    expect((summaries[0]?.outboundHttp as Record<string, unknown>)['path']).toBe('/api/orders/123');
    expect((summaries[0]?.outboundHttp as Record<string, unknown>)['method']).toBe('GET');
    expect(summaries[0]?.summaryCompleteness).toBe(1);
    expect(summaries[0]?.unresolvedReasons).toEqual([]);
    expect(summaries[0]?.flags).toMatchObject({
      truncated: false,
      dynamicPath: false,
      unsupportedPattern: false,
      astBacked: true,
    });
  });

  it('mixed_signals 모드에서 AST confidence가 regex confidence보다 우선 적용되어야 한다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'billing-service' });
    const functionId = await insertObject(db, {
      objectType: 'function',
      name: 'BillingClient.charge',
      parentId: serviceId,
    });
    const artifactId = generateId();
    const filePath = join(repoRoot, 'src', 'billing', 'BillingClient.java');
    mkdirSync(join(repoRoot, 'src', 'billing'), { recursive: true });
    writeFileSync(filePath, 'class BillingClient {}');
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: 'java',
      repoRoot,
      filePath,
      ownerObjectId: functionId,
    });

    // regex 신호: 높은 confidence 0.95
    const regexEvidenceId = generateId();
    await db.insert(evidences).values({
      id: regexEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath,
      lineStart: 10,
      lineEnd: 12,
      excerpt: 'restTemplate.postForObject(billingUrl, ...)',
      metadata: {
        kind: 'call',
        method: 'POST',
        path: '/api/billing/charge',
        confidence: 0.95,
        extractionMode: 'regex',
        configKeys: ['billing.base-url'],
      },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'http://billing-host/api/billing/charge',
      calleeOwnerObjectId: null,
      weight: 1,
      evidenceId: regexEvidenceId,
    });

    // AST 신호: 낮은 confidence 0.78
    const astEvidenceId = generateId();
    await db.insert(evidences).values({
      id: astEvidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath,
      lineStart: 10,
      lineEnd: 12,
      excerpt: 'restTemplate.postForObject(billingUrl, ...)',
      metadata: {
        kind: 'call',
        method: 'POST',
        path: '/api/billing/charge',
        confidence: 0.78,
        extractionMode: 'ast',
        configKeys: ['billing.base-url'],
      },
    });
    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: 'http://billing-host/api/billing/charge',
      calleeOwnerObjectId: null,
      weight: 1,
      evidenceId: astEvidenceId,
    });

    await extractFunctionSummariesFromCodeSignals(db, { workspaceId, repoRoot });

    const summaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.functionId, functionId)));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.extractionStrategy).toBe('mixed_signals');

    // AST confidence(0.78)가 regex confidence(0.95)보다 우선 적용
    expect(summaries[0]?.confidence).toBe(0.78);

    // summaryCompleteness는 순수 slot completeness (extraction strategy 보너스 없음)
    expect(summaries[0]?.summaryCompleteness).toBe(0.9);

    expect(summaries[0]?.flags).toMatchObject({
      astBacked: true,
    });
  });
});
