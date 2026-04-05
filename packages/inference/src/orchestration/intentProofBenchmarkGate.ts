import { and, eq } from 'drizzle-orm';
import {
  aliasBindings,
  createTestDb,
  functionSummaries,
  interactionIntents,
  objects,
  proofFrontiers,
  proofPatches,
  proofStates,
  relationCandidates,
  routeTransforms,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  resolveInteractionIntentProof,
  validateAndApplyProofPatch,
} from '@/orchestration/intentProofEngine';

type ExpectedStatus = 'CLOSED_ATOMIC' | 'FRONTIER' | 'REJECTED';
type ExpectedPatchStatus = 'ACCEPTED' | 'REJECTED';
type TestDb = Awaited<ReturnType<typeof createTestDb>>;

export interface IntentProofBenchmarkBaseline {
  version: string;
  thresholds: {
    minScenarioPassRate: number;
    minCandidateExpectationRate: number;
    minFrontierExpectationRate: number;
    minRejectedExpectationRate: number;
    minAcceptedPatchRate: number;
    minRejectedPatchRate: number;
    maxFailureCount: number;
  };
}

export interface IntentProofBenchmarkMetrics {
  totalScenarios: number;
  passedScenarios: number;
  scenarioPassRate: number;
  candidateExpectationRate: number;
  frontierExpectationRate: number;
  rejectedExpectationRate: number;
  acceptedPatchRate: number;
  rejectedPatchRate: number;
}

export interface IntentProofBenchmarkScenarioReport {
  id: string;
  passed: boolean;
  expectedStatus: ExpectedStatus;
  actualStatus: string;
  expectedFrontierReason: string | null;
  actualFrontierReason: string | null;
  expectedRelationType: string | null;
  actualRelationType: string | null;
  patchStatus: string | null;
  patchErrors: string[];
  notes: string[];
}

export interface IntentProofBenchmarkReport {
  version: string;
  generatedAt: string;
  metrics: IntentProofBenchmarkMetrics;
  scenarios: IntentProofBenchmarkScenarioReport[];
  failures: string[];
}

interface BenchmarkContext {
  db: TestDb;
  workspaceId: string;
  serviceId: string;
  functionId: string;
}

interface ScenarioExpectation {
  status: ExpectedStatus;
  frontierReason?: string;
  relationType?: string;
  candidateCount?: number;
  patchStatus?: ExpectedPatchStatus;
}

interface ScenarioExecutionResult {
  actualStatus: string;
  actualFrontierReason: string | null;
  actualRelationType: string | null;
  candidateCount: number;
  patchStatus: string | null;
  patchErrors: string[];
  notes: string[];
}

interface BenchmarkScenario {
  id: string;
  expectation: ScenarioExpectation;
  execute: (context: BenchmarkContext) => Promise<ScenarioExecutionResult>;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function createBenchmarkDb(): Promise<TestDb> {
  return await createTestDb();
}

async function insertObject(
  db: TestDb,
  workspaceId: string,
  input: {
    id?: string;
    objectType: string;
    name: string;
    parentId?: string | null;
    metadata?: Record<string, unknown>;
    granularity?: string;
    category?: string | null;
  },
) {
  const id = input.id ?? generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: input.objectType,
    category: input.category ?? 'COMPUTE',
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

async function createBenchmarkContext(db: TestDb): Promise<BenchmarkContext> {
  const workspaceId = generateId();
  await db.insert(workspaces).values({ id: workspaceId, name: 'intent-proof-benchmark' });

  const serviceId = await insertObject(db, workspaceId, {
    objectType: 'service',
    name: 'order-service',
  });
  const functionId = await insertObject(db, workspaceId, {
    objectType: 'function',
    name: 'OrderService.handle',
    parentId: serviceId,
    category: 'CODE',
  });

  return { db, workspaceId, serviceId, functionId };
}

async function readCandidates(context: BenchmarkContext) {
  return context.db
    .select()
    .from(relationCandidates)
    .where(eq(relationCandidates.workspaceId, context.workspaceId));
}

async function readFrontierReason(context: BenchmarkContext, proofStateId: string) {
  const [frontier] = await context.db
    .select()
    .from(proofFrontiers)
    .where(eq(proofFrontiers.proofStateId, proofStateId));
  return frontier?.frontierReason ?? null;
}

async function httpClosedAtomicScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const providerServiceId = await insertObject(context.db, context.workspaceId, {
    objectType: 'service',
    name: 'order-api',
  });
  const endpointId = await insertObject(context.db, context.workspaceId, {
    objectType: 'api_endpoint',
    name: 'GET /internal/orders/{id}',
    parentId: providerServiceId,
    metadata: { method: 'GET', path: '/internal/orders/{id}' },
  });

  await context.db.insert(aliasBindings).values({
    id: generateId(),
    workspaceId: context.workspaceId,
    bindingKind: 'property_alias',
    ownerServiceId: context.serviceId,
    aliasKey: 'client.order.base-url',
    aliasValue: 'ORDER_API',
    resolvedServiceId: providerServiceId,
    resolvedHost: 'order-api.internal',
    sourceHash: 'benchmark-http-closed-alias',
  });

  await context.db.insert(routeTransforms).values({
    id: generateId(),
    workspaceId: context.workspaceId,
    gatewayKind: 'gateway',
    ownerServiceId: context.serviceId,
    matchPath: '/public/orders/*',
    stripPrefixCount: 1,
    prependPrefix: '/internal',
    targetServiceHint: 'order-api',
    sourceHash: 'benchmark-http-closed-route',
  });

  const summaryId = generateId();
  await context.db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId: context.workspaceId,
    functionId: context.functionId,
    serviceId: context.serviceId,
    summaryKind: 'http',
    outboundHttp: {
      method: 'GET',
      path: '/public/orders/123',
      hostAlias: 'ORDER_API',
    },
    aliasHints: ['client.order.base-url'],
    sourceHash: 'benchmark-http-closed-summary',
    confidence: 0.96,
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'http_call',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    methodHint: 'GET',
    externalPathHint: '/public/orders/123',
    hostHint: 'ORDER_API',
    configKeys: ['client.order.base-url'],
    summaryRefs: [summaryId],
    intentHash: 'benchmark-http-closed-intent',
    anchorHash: 'benchmark-http-closed-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const candidates = await readCandidates(context);

  return {
    actualStatus: resolution.status,
    actualFrontierReason: null,
    actualRelationType: candidates[0]?.relationType ?? null,
    candidateCount: candidates.length,
    patchStatus: null,
    patchErrors: [],
    notes: candidates[0]?.objectId === endpointId ? [] : ['resolved endpoint did not match expected object'],
  };
}

async function httpHostAliasFrontierScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'http_call',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    methodHint: 'GET',
    externalPathHint: '/orders/123',
    hostHint: 'missing-host',
    intentHash: 'benchmark-http-frontier-intent',
    anchorHash: 'benchmark-http-frontier-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });

  return {
    actualStatus: resolution.status,
    actualFrontierReason: await readFrontierReason(context, resolution.proofStateId),
    actualRelationType: null,
    candidateCount: (await readCandidates(context)).length,
    patchStatus: null,
    patchErrors: [],
    notes: [],
  };
}

async function httpMethodRejectedScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const providerServiceId = await insertObject(context.db, context.workspaceId, {
    objectType: 'service',
    name: 'billing-api',
  });
  await insertObject(context.db, context.workspaceId, {
    objectType: 'api_endpoint',
    name: 'GET /billing/invoices/{id}',
    parentId: providerServiceId,
    metadata: { method: 'GET', path: '/billing/invoices/{id}' },
  });

  await context.db.insert(aliasBindings).values({
    id: generateId(),
    workspaceId: context.workspaceId,
    bindingKind: 'property_alias',
    ownerServiceId: context.serviceId,
    aliasKey: 'client.billing.url',
    aliasValue: 'BILLING_API',
    resolvedServiceId: providerServiceId,
    sourceHash: 'benchmark-http-rejected-alias',
  });

  const summaryId = generateId();
  await context.db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId: context.workspaceId,
    functionId: context.functionId,
    serviceId: context.serviceId,
    summaryKind: 'http',
    outboundHttp: {
      method: 'POST',
      path: '/billing/invoices/123',
      hostAlias: 'BILLING_API',
    },
    aliasHints: ['client.billing.url'],
    sourceHash: 'benchmark-http-rejected-summary',
    confidence: 0.92,
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'http_call',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    methodHint: 'GET',
    externalPathHint: '/billing/invoices/123',
    hostHint: 'BILLING_API',
    configKeys: ['client.billing.url'],
    summaryRefs: [summaryId],
    intentHash: 'benchmark-http-rejected-intent',
    anchorHash: 'benchmark-http-rejected-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const [state] = await context.db
    .select()
    .from(proofStates)
    .where(eq(proofStates.id, resolution.proofStateId));

  return {
    actualStatus: resolution.status,
    actualFrontierReason: state?.rejectedReason ?? null,
    actualRelationType: null,
    candidateCount: (await readCandidates(context)).length,
    patchStatus: null,
    patchErrors: [],
    notes: [],
  };
}

async function httpEndpointAmbiguousScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const providerServiceId = await insertObject(context.db, context.workspaceId, {
    objectType: 'service',
    name: 'inventory-api',
  });
  await insertObject(context.db, context.workspaceId, {
    objectType: 'api_endpoint',
    name: 'GET /inventory/items/{id}',
    parentId: providerServiceId,
    metadata: { method: 'GET', path: '/inventory/items/{id}' },
  });
  await insertObject(context.db, context.workspaceId, {
    objectType: 'api_endpoint',
    name: 'GET /inventory/items/{itemId}',
    parentId: providerServiceId,
    metadata: { method: 'GET', path: '/inventory/items/{itemId}' },
  });

  await context.db.insert(aliasBindings).values({
    id: generateId(),
    workspaceId: context.workspaceId,
    bindingKind: 'property_alias',
    ownerServiceId: context.serviceId,
    aliasKey: 'client.inventory.url',
    aliasValue: 'INVENTORY_API',
    resolvedServiceId: providerServiceId,
    sourceHash: 'benchmark-http-ambiguous-alias',
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'http_call',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    methodHint: 'GET',
    externalPathHint: '/inventory/items/123',
    hostHint: 'INVENTORY_API',
    configKeys: ['client.inventory.url'],
    intentHash: 'benchmark-http-ambiguous-intent',
    anchorHash: 'benchmark-http-ambiguous-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });

  return {
    actualStatus: resolution.status,
    actualFrontierReason: await readFrontierReason(context, resolution.proofStateId),
    actualRelationType: null,
    candidateCount: (await readCandidates(context)).length,
    patchStatus: null,
    patchErrors: [],
    notes: [],
  };
}

async function dbReadClosedScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const databaseId = await insertObject(context.db, context.workspaceId, {
    objectType: 'database',
    name: 'order-db',
    category: 'STORAGE',
    granularity: 'COMPOUND',
  });
  const tableId = await insertObject(context.db, context.workspaceId, {
    objectType: 'db_table',
    name: 'orders',
    parentId: databaseId,
    category: 'STORAGE',
    metadata: { schema: 'public' },
  });

  const summaryId = generateId();
  await context.db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId: context.workspaceId,
    functionId: context.functionId,
    serviceId: context.serviceId,
    summaryKind: 'db',
    outboundDb: { action: 'SELECT', schema: 'public', table: 'orders' },
    sourceHash: 'benchmark-db-read-summary',
    confidence: 0.93,
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'db_access',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    resourceHint: 'public.orders',
    methodHint: 'SELECT',
    summaryRefs: [summaryId],
    intentHash: 'benchmark-db-read-intent',
    anchorHash: 'benchmark-db-read-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const candidates = await readCandidates(context);

  return {
    actualStatus: resolution.status,
    actualFrontierReason: null,
    actualRelationType: candidates[0]?.relationType ?? null,
    candidateCount: candidates.length,
    patchStatus: null,
    patchErrors: [],
    notes: candidates[0]?.objectId === tableId ? [] : ['resolved db_table did not match expected object'],
  };
}

async function dbWriteClosedScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const databaseId = await insertObject(context.db, context.workspaceId, {
    objectType: 'database',
    name: 'billing-db',
    category: 'STORAGE',
    granularity: 'COMPOUND',
  });
  const tableId = await insertObject(context.db, context.workspaceId, {
    objectType: 'db_table',
    name: 'payments',
    parentId: databaseId,
    category: 'STORAGE',
    metadata: { schema: 'billing' },
  });

  const summaryId = generateId();
  await context.db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId: context.workspaceId,
    functionId: context.functionId,
    serviceId: context.serviceId,
    summaryKind: 'db',
    outboundDb: { action: 'UPDATE', schema: 'billing', table: 'payments' },
    sourceHash: 'benchmark-db-write-summary',
    confidence: 0.95,
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'db_access',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    resourceHint: 'billing.payments',
    methodHint: 'UPDATE',
    summaryRefs: [summaryId],
    intentHash: 'benchmark-db-write-intent',
    anchorHash: 'benchmark-db-write-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const candidates = await readCandidates(context);

  return {
    actualStatus: resolution.status,
    actualFrontierReason: null,
    actualRelationType: candidates[0]?.relationType ?? null,
    candidateCount: candidates.length,
    patchStatus: null,
    patchErrors: [],
    notes: candidates[0]?.objectId === tableId ? [] : ['resolved db_table did not match expected object'],
  };
}

async function dbAmbiguousFrontierScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const dbA = await insertObject(context.db, context.workspaceId, {
    objectType: 'database',
    name: 'order-db-a',
    category: 'STORAGE',
    granularity: 'COMPOUND',
  });
  const dbB = await insertObject(context.db, context.workspaceId, {
    objectType: 'database',
    name: 'order-db-b',
    category: 'STORAGE',
    granularity: 'COMPOUND',
  });
  await insertObject(context.db, context.workspaceId, {
    objectType: 'db_table',
    name: 'orders',
    parentId: dbA,
    category: 'STORAGE',
    metadata: { schema: 'public' },
  });
  await insertObject(context.db, context.workspaceId, {
    objectType: 'db_table',
    name: 'orders',
    parentId: dbB,
    category: 'STORAGE',
    metadata: { schema: 'audit' },
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'db_access',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    resourceHint: 'orders',
    methodHint: 'SELECT',
    intentHash: 'benchmark-db-ambiguous-intent',
    anchorHash: 'benchmark-db-ambiguous-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });

  return {
    actualStatus: resolution.status,
    actualFrontierReason: await readFrontierReason(context, resolution.proofStateId),
    actualRelationType: null,
    candidateCount: (await readCandidates(context)).length,
    patchStatus: null,
    patchErrors: [],
    notes: [],
  };
}

async function messagePublishClosedScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const topicId = await insertObject(context.db, context.workspaceId, {
    objectType: 'topic',
    name: 'orders.created',
    category: 'CHANNEL',
  });

  const summaryId = generateId();
  await context.db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId: context.workspaceId,
    functionId: context.functionId,
    serviceId: context.serviceId,
    summaryKind: 'message',
    outboundMessage: { topic: 'orders.created', channelType: 'topic' },
    sourceHash: 'benchmark-message-publish-summary',
    confidence: 0.91,
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'message_publish',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    summaryRefs: [summaryId],
    intentHash: 'benchmark-message-publish-intent',
    anchorHash: 'benchmark-message-publish-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const candidates = await readCandidates(context);

  return {
    actualStatus: resolution.status,
    actualFrontierReason: null,
    actualRelationType: candidates[0]?.relationType ?? null,
    candidateCount: candidates.length,
    patchStatus: null,
    patchErrors: [],
    notes: candidates[0]?.objectId === topicId ? [] : ['resolved topic did not match expected object'],
  };
}

async function messageConsumePatchRecoveryScenario(
  context: BenchmarkContext,
): Promise<ScenarioExecutionResult> {
  const queueId = await insertObject(context.db, context.workspaceId, {
    objectType: 'queue',
    name: 'email.queue',
    category: 'CHANNEL',
  });

  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'message_consume',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    intentHash: 'benchmark-message-consume-intent',
    anchorHash: 'benchmark-message-consume-anchor',
  });

  const initial = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const patchResult = await validateAndApplyProofPatch(context.db, {
    workspaceId: context.workspaceId,
    proofStateId: initial.proofStateId,
    patchType: 'function_summary_patch',
    payload: {
      functionId: context.functionId,
      serviceId: context.serviceId,
      summaryKind: 'message',
      outboundMessage: {
        queue: 'email.queue',
        channelType: 'queue',
      },
      confidence: 0.97,
    },
    sourceKind: 'agent',
  });

  const candidates = await readCandidates(context);
  return {
    actualStatus: patchResult.resolution?.status ?? initial.status,
    actualFrontierReason: null,
    actualRelationType: candidates[0]?.relationType ?? null,
    candidateCount: candidates.length,
    patchStatus: patchResult.validationStatus,
    patchErrors: patchResult.errors,
    notes: candidates[0]?.objectId === queueId ? [] : ['resolved queue did not match expected object'],
  };
}

async function invalidPatchRejectedScenario(context: BenchmarkContext): Promise<ScenarioExecutionResult> {
  const intentId = generateId();
  await context.db.insert(interactionIntents).values({
    id: intentId,
    workspaceId: context.workspaceId,
    intentType: 'message_publish',
    sourceServiceId: context.serviceId,
    sourceFunctionId: context.functionId,
    intentHash: 'benchmark-invalid-patch-intent',
    anchorHash: 'benchmark-invalid-patch-anchor',
  });

  const resolution = await resolveInteractionIntentProof(context.db, {
    workspaceId: context.workspaceId,
    intentId,
  });
  const patchResult = await validateAndApplyProofPatch(context.db, {
    workspaceId: context.workspaceId,
    proofStateId: resolution.proofStateId,
    patchType: 'alias_binding',
    payload: { aliasKey: 'orders.topic' },
    sourceKind: 'agent',
  });
  const [state] = await context.db
    .select()
    .from(proofStates)
    .where(eq(proofStates.id, resolution.proofStateId));
  const [patch] = await context.db
    .select()
    .from(proofPatches)
    .where(eq(proofPatches.proofStateId, resolution.proofStateId));

  return {
    actualStatus: state?.status ?? resolution.status,
    actualFrontierReason: await readFrontierReason(context, resolution.proofStateId),
    actualRelationType: null,
    candidateCount: (await readCandidates(context)).length,
    patchStatus: patch?.validationStatus ?? patchResult.validationStatus,
    patchErrors: patchResult.errors,
    notes: [],
  };
}

const BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'http-closed-atomic',
    expectation: { status: 'CLOSED_ATOMIC', relationType: 'call', candidateCount: 1 },
    execute: httpClosedAtomicScenario,
  },
  {
    id: 'http-host-alias-frontier',
    expectation: { status: 'FRONTIER', frontierReason: 'HOST_ALIAS_UNRESOLVED', candidateCount: 0 },
    execute: httpHostAliasFrontierScenario,
  },
  {
    id: 'http-method-contradiction-rejected',
    expectation: { status: 'REJECTED', frontierReason: 'METHOD_CONTRADICTION', candidateCount: 0 },
    execute: httpMethodRejectedScenario,
  },
  {
    id: 'http-endpoint-ambiguous-frontier',
    expectation: { status: 'FRONTIER', frontierReason: 'ENDPOINT_MATCH_AMBIGUOUS', candidateCount: 0 },
    execute: httpEndpointAmbiguousScenario,
  },
  {
    id: 'db-read-closed-atomic',
    expectation: { status: 'CLOSED_ATOMIC', relationType: 'read', candidateCount: 1 },
    execute: dbReadClosedScenario,
  },
  {
    id: 'db-write-closed-atomic',
    expectation: { status: 'CLOSED_ATOMIC', relationType: 'write', candidateCount: 1 },
    execute: dbWriteClosedScenario,
  },
  {
    id: 'db-schema-ambiguous-frontier',
    expectation: { status: 'FRONTIER', frontierReason: 'DB_SCHEMA_AMBIGUOUS', candidateCount: 0 },
    execute: dbAmbiguousFrontierScenario,
  },
  {
    id: 'message-publish-closed-atomic',
    expectation: { status: 'CLOSED_ATOMIC', relationType: 'produce', candidateCount: 1 },
    execute: messagePublishClosedScenario,
  },
  {
    id: 'message-consume-patch-recovery',
    expectation: {
      status: 'CLOSED_ATOMIC',
      relationType: 'consume',
      candidateCount: 1,
      patchStatus: 'ACCEPTED',
    },
    execute: messageConsumePatchRecoveryScenario,
  },
  {
    id: 'invalid-patch-rejected',
    expectation: {
      status: 'FRONTIER',
      frontierReason: 'MESSAGE_TARGET_UNRESOLVED',
      candidateCount: 0,
      patchStatus: 'REJECTED',
    },
    execute: invalidPatchRejectedScenario,
  },
];

function buildScenarioReport(
  scenario: BenchmarkScenario,
  result: ScenarioExecutionResult,
): IntentProofBenchmarkScenarioReport {
  const notes = [...result.notes];
  const expected = scenario.expectation;
  const statusMatches = result.actualStatus === expected.status;
  const frontierMatches = (expected.frontierReason ?? null) === result.actualFrontierReason;
  const relationMatches = (expected.relationType ?? null) === result.actualRelationType;
  const candidateCountMatches = expected.candidateCount === result.candidateCount;
  const patchMatches = (expected.patchStatus ?? null) === result.patchStatus;

  if (!statusMatches) {
    notes.push(`expected status ${expected.status} but received ${result.actualStatus}`);
  }
  if (!frontierMatches) {
    notes.push(
      `expected frontier reason ${expected.frontierReason ?? 'null'} but received ${result.actualFrontierReason ?? 'null'}`,
    );
  }
  if (!relationMatches) {
    notes.push(
      `expected relation type ${expected.relationType ?? 'null'} but received ${result.actualRelationType ?? 'null'}`,
    );
  }
  if (!candidateCountMatches) {
    notes.push(`expected candidate count ${expected.candidateCount ?? 0} but received ${result.candidateCount}`);
  }
  if (!patchMatches) {
    notes.push(`expected patch status ${expected.patchStatus ?? 'null'} but received ${result.patchStatus ?? 'null'}`);
  }

  return {
    id: scenario.id,
    passed: notes.length === 0,
    expectedStatus: expected.status,
    actualStatus: result.actualStatus,
    expectedFrontierReason: expected.frontierReason ?? null,
    actualFrontierReason: result.actualFrontierReason,
    expectedRelationType: expected.relationType ?? null,
    actualRelationType: result.actualRelationType,
    patchStatus: result.patchStatus,
    patchErrors: result.patchErrors,
    notes,
  };
}

export function evaluateIntentProofBenchmarkReport(
  report: IntentProofBenchmarkReport,
  baseline: IntentProofBenchmarkBaseline,
) {
  const failures = [...report.failures];
  const { thresholds } = baseline;
  const { metrics } = report;

  if (metrics.scenarioPassRate < thresholds.minScenarioPassRate) {
    failures.push(
      `scenarioPassRate ${metrics.scenarioPassRate} fell below ${thresholds.minScenarioPassRate}`,
    );
  }
  if (metrics.candidateExpectationRate < thresholds.minCandidateExpectationRate) {
    failures.push(
      `candidateExpectationRate ${metrics.candidateExpectationRate} fell below ${thresholds.minCandidateExpectationRate}`,
    );
  }
  if (metrics.frontierExpectationRate < thresholds.minFrontierExpectationRate) {
    failures.push(
      `frontierExpectationRate ${metrics.frontierExpectationRate} fell below ${thresholds.minFrontierExpectationRate}`,
    );
  }
  if (metrics.rejectedExpectationRate < thresholds.minRejectedExpectationRate) {
    failures.push(
      `rejectedExpectationRate ${metrics.rejectedExpectationRate} fell below ${thresholds.minRejectedExpectationRate}`,
    );
  }
  if (metrics.acceptedPatchRate < thresholds.minAcceptedPatchRate) {
    failures.push(
      `acceptedPatchRate ${metrics.acceptedPatchRate} fell below ${thresholds.minAcceptedPatchRate}`,
    );
  }
  if (metrics.rejectedPatchRate < thresholds.minRejectedPatchRate) {
    failures.push(
      `rejectedPatchRate ${metrics.rejectedPatchRate} fell below ${thresholds.minRejectedPatchRate}`,
    );
  }
  if (report.failures.length > thresholds.maxFailureCount) {
    failures.push(`failureCount ${report.failures.length} exceeded ${thresholds.maxFailureCount}`);
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

export async function runIntentProofBenchmarkGate(): Promise<IntentProofBenchmarkReport> {
  const scenarioReports: IntentProofBenchmarkScenarioReport[] = [];
  const db = await createBenchmarkDb();

  for (const scenario of BENCHMARK_SCENARIOS) {
    const context = await createBenchmarkContext(db);
    const result = await scenario.execute(context);
    scenarioReports.push(buildScenarioReport(scenario, result));
  }

  const totalScenarios = scenarioReports.length;
  const passedScenarios = scenarioReports.filter((scenario) => scenario.passed).length;
  const candidateScenarios = scenarioReports.filter((scenario) => scenario.expectedRelationType !== null);
  const frontierScenarios = scenarioReports.filter((scenario) => scenario.expectedStatus === 'FRONTIER');
  const rejectedScenarios = scenarioReports.filter((scenario) => scenario.expectedStatus === 'REJECTED');
  const acceptedPatchScenarios = scenarioReports.filter((scenario) => scenario.patchStatus === 'ACCEPTED');
  const rejectedPatchScenarios = scenarioReports.filter((scenario) => scenario.patchStatus === 'REJECTED');

  const metrics: IntentProofBenchmarkMetrics = {
    totalScenarios,
    passedScenarios,
    scenarioPassRate: round(passedScenarios / totalScenarios),
    candidateExpectationRate: round(
      candidateScenarios.filter((scenario) => scenario.passed).length / Math.max(candidateScenarios.length, 1),
    ),
    frontierExpectationRate: round(
      frontierScenarios.filter((scenario) => scenario.passed).length / Math.max(frontierScenarios.length, 1),
    ),
    rejectedExpectationRate: round(
      rejectedScenarios.filter((scenario) => scenario.passed).length / Math.max(rejectedScenarios.length, 1),
    ),
    acceptedPatchRate: round(
      acceptedPatchScenarios.length / Math.max(BENCHMARK_SCENARIOS.filter((scenario) => scenario.expectation.patchStatus === 'ACCEPTED').length, 1),
    ),
    rejectedPatchRate: round(
      rejectedPatchScenarios.length / Math.max(BENCHMARK_SCENARIOS.filter((scenario) => scenario.expectation.patchStatus === 'REJECTED').length, 1),
    ),
  };

  return {
    version: 'intent-proof-benchmark-gate-v1',
    generatedAt: new Date().toISOString(),
    metrics,
    scenarios: scenarioReports,
    failures: scenarioReports.flatMap((scenario) => scenario.passed ? [] : [`${scenario.id}: ${scenario.notes.join('; ')}`]),
  };
}
