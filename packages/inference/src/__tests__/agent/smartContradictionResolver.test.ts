import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestDb,
  inferenceRuns,
  interactionIntents,
  objects,
  proofPatches,
  proofStates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  buildSmartContradictionPrompt,
  loadSmartContradictionCandidates,
} from '@/agent/smartContradictionResolver';

const workspaceId = generateId();

describe('smart contradiction resolver', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({
      id: workspaceId,
      name: 'smart-contradiction-test',
    });
  });

  it('prompt는 low-confidence closed proof review 문맥을 포함해야 한다', () => {
    const prompt = buildSmartContradictionPrompt({
      proofStateId: 'proof-1',
      intentId: 'intent-1',
      intentType: 'http_call',
      sourceServiceId: 'svc-source',
      sourceServiceName: 'gateway',
      targetObjectId: 'endpoint-1',
      targetObjectType: 'api_endpoint',
      targetObjectName: 'GET /orders/{id}',
      methodHint: 'GET',
      externalPathHint: '/orders/123',
      hostHint: 'ORDER_API',
      configKeys: ['client.orders.url'],
      confidence: 0.42,
      confidenceBreakdown: { finalConfidence: 0.42 },
      contradictionCount: 0,
      ambiguityCount: 1,
    });

    expect(prompt).toContain('patchType=contradiction_challenge');
    expect(prompt).toContain('Proof confidence: 0.420');
    expect(prompt).toContain('Target object: GET /orders/{id}');
  });

  it('candidate loader는 low-confidence CLOSED_ATOMIC proof만 고르고 accepted challenge는 제외해야 한다', async () => {
    const runId = generateId();
    const sourceServiceId = generateId();
    const targetObjectId = generateId();
    const lowIntentId = generateId();
    const highIntentId = generateId();
    const challengedIntentId = generateId();
    const lowProofStateId = generateId();
    const highProofStateId = generateId();
    const challengedProofStateId = generateId();

    await db.insert(inferenceRuns).values({
      id: runId,
      workspaceId,
      triggerType: 'MANUAL',
      status: 'SUCCEEDED',
      requestedModes: ['config'],
      requestedIncremental: false,
      sourceSummary: {},
      stats: {},
      warnings: [],
      errors: [],
    });
    await db.insert(objects).values([
      {
        id: sourceServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: '/gateway',
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: targetObjectId,
        workspaceId,
        objectType: 'api_endpoint',
        category: 'INTERFACE',
        granularity: 'ATOMIC',
        name: 'GET /orders/{id}',
        path: '/orders/{id}',
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);
    await db.insert(interactionIntents).values([
      {
        id: lowIntentId,
        workspaceId,
        updatedRunId: runId,
        intentType: 'http_call',
        sourceServiceId,
        methodHint: 'GET',
        externalPathHint: '/orders/123',
        hostHint: 'ORDER_API',
        configKeys: ['client.orders.url'],
        intentHash: 'intent-low',
        anchorHash: 'anchor-low',
      },
      {
        id: highIntentId,
        workspaceId,
        updatedRunId: runId,
        intentType: 'http_call',
        sourceServiceId,
        methodHint: 'GET',
        externalPathHint: '/orders/456',
        hostHint: 'ORDER_API',
        configKeys: ['client.orders.url'],
        intentHash: 'intent-high',
        anchorHash: 'anchor-high',
      },
      {
        id: challengedIntentId,
        workspaceId,
        updatedRunId: runId,
        intentType: 'http_call',
        sourceServiceId,
        methodHint: 'GET',
        externalPathHint: '/orders/789',
        hostHint: 'ORDER_API',
        configKeys: ['client.orders.url'],
        intentHash: 'intent-challenged',
        anchorHash: 'anchor-challenged',
      },
    ]);
    await db.insert(proofStates).values([
      {
        id: lowProofStateId,
        workspaceId,
        intentId: lowIntentId,
        proofType: 'http_call',
        status: 'CLOSED_ATOMIC',
        consumerServiceId: sourceServiceId,
        targetObjectId,
        targetObjectType: 'api_endpoint',
        confidence: 0.41,
      },
      {
        id: highProofStateId,
        workspaceId,
        intentId: highIntentId,
        proofType: 'http_call',
        status: 'CLOSED_ATOMIC',
        consumerServiceId: sourceServiceId,
        targetObjectId,
        targetObjectType: 'api_endpoint',
        confidence: 0.88,
      },
      {
        id: challengedProofStateId,
        workspaceId,
        intentId: challengedIntentId,
        proofType: 'http_call',
        status: 'CLOSED_ATOMIC',
        consumerServiceId: sourceServiceId,
        targetObjectId,
        targetObjectType: 'api_endpoint',
        confidence: 0.3,
      },
    ]);
    await db.insert(proofPatches).values({
      id: generateId(),
      workspaceId,
      proofStateId: challengedProofStateId,
      patchType: 'contradiction_challenge',
      payload: {
        challengeReasons: ['LOW_CONFIDENCE_FALSE_POSITIVE'],
        expectedAction: 'reopen_frontier',
      },
      sourceKind: 'smart_agent',
      validationStatus: 'ACCEPTED',
    });

    const candidates = await loadSmartContradictionCandidates(db, {
      workspaceId,
      runId,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.proofStateId).toBe(lowProofStateId);
    expect(candidates[0]?.targetObjectName).toBe('GET /orders/{id}');
    const patches = await db.select().from(proofPatches).where(eq(proofPatches.workspaceId, workspaceId));
    expect(patches).toHaveLength(1);
  });
});
