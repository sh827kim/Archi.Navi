import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  functionSummaries,
  interactionIntents,
  objects,
  proofFrontiers,
  proofStates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import {
  isSmartSummaryEnhancementCandidate,
  loadSmartSummaryEnhancementCandidates,
} from '@/agent/smartSummaryEnhancer';

const workspaceId = '00000000-0000-0000-0000-000000000121';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

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
    category: input.category ?? (input.objectType === 'function' ? 'CODE' : 'COMPUTE'),
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

describe('smartSummaryEnhancer', () => {
  let db: TestDb;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `archi-navi-summary-enhancer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'smart-summary-enhancer-test' });
  });

  afterEach(async () => {
    const client = (db as { $client?: { end?: () => Promise<void> } } | undefined)?.$client;
    if (client?.end) {
      await client.end();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('selection predicate는 legacy + weak signal + low completeness가 동시에 충족될 때만 true 여야 한다', () => {
    expect(isSmartSummaryEnhancementCandidate({
      extractionStrategy: 'legacy_edges_fallback',
      summaryCompleteness: 0.25,
      flags: { truncated: true },
    })).toBe(true);
    expect(isSmartSummaryEnhancementCandidate({
      extractionStrategy: 'mixed_signals',
      summaryCompleteness: 0.4,
      flags: { dynamicPath: true },
    })).toBe(false);
    expect(isSmartSummaryEnhancementCandidate({
      extractionStrategy: 'legacy_edges_fallback',
      summaryCompleteness: 0.4,
      flags: {},
    })).toBe(false);
    expect(isSmartSummaryEnhancementCandidate({
      extractionStrategy: 'legacy_edges_fallback',
      summaryCompleteness: 0.95,
      flags: { dynamicHost: true },
    })).toBe(false);
  });

  it('candidate loader는 조건 충족 function summary만 선별하고 snippet을 싣는다', async () => {
    const serviceId = await insertObject(db, { objectType: 'service', name: 'gateway' });
    const selectedFilePath = join(tempDir, 'selected.ts');
    writeFileSync(
      selectedFilePath,
      [
        'export async function selectedClient() {',
        "  return fetch('/api/orders/1');",
        '}',
      ].join('\n'),
      'utf-8',
    );
    const selectedFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'selectedClient',
      parentId: serviceId,
      metadata: { sourceFilePath: selectedFilePath, startLine: 1, endLine: 3 },
    });
    const ignoredFunctionId = await insertObject(db, {
      objectType: 'function',
      name: 'ignoredClient',
      parentId: serviceId,
      metadata: { sourceFilePath: selectedFilePath, startLine: 1, endLine: 3 },
    });

    const selectedIntentId = generateId();
    const ignoredIntentId = generateId();
    const selectedProofStateId = generateId();
    const ignoredProofStateId = generateId();

    await db.insert(interactionIntents).values([
      {
        id: selectedIntentId,
        workspaceId,
        intentType: 'http_call',
        sourceServiceId: serviceId,
        sourceFunctionId: selectedFunctionId,
        sourceFilePath: selectedFilePath,
        methodHint: 'GET',
        externalPathHint: '/api/orders/1',
        hostHint: 'ORDER_SERVICE',
        intentHash: 'selected-intent',
        anchorHash: 'selected-anchor',
      },
      {
        id: ignoredIntentId,
        workspaceId,
        intentType: 'http_call',
        sourceServiceId: serviceId,
        sourceFunctionId: ignoredFunctionId,
        sourceFilePath: selectedFilePath,
        methodHint: 'GET',
        externalPathHint: '/api/catalog/1',
        hostHint: 'CATALOG_SERVICE',
        intentHash: 'ignored-intent',
        anchorHash: 'ignored-anchor',
      },
    ]);

    await db.insert(proofStates).values([
      {
        id: selectedProofStateId,
        workspaceId,
        intentId: selectedIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        sourceFunctionId: selectedFunctionId,
        methodResolved: 'GET',
        externalPathResolved: '/api/orders/1',
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
      {
        id: ignoredProofStateId,
        workspaceId,
        intentId: ignoredIntentId,
        proofType: 'http_call',
        status: 'FRONTIER',
        consumerServiceId: serviceId,
        sourceFunctionId: ignoredFunctionId,
        methodResolved: 'GET',
        externalPathResolved: '/api/catalog/1',
        routeChain: [],
        slotState: {},
        ambiguityCount: 0,
        contradictionCount: 0,
        confidence: 0.3,
        frontierCode: 'HOST_ALIAS_UNRESOLVED',
      },
    ]);

    await db.insert(proofFrontiers).values([
      {
        proofStateId: selectedProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {},
      },
      {
        proofStateId: ignoredProofStateId,
        workspaceId,
        frontierReason: 'HOST_ALIAS_UNRESOLVED',
        frontierClass: 'ALIAS',
        retryStrategy: 'agent_patch',
        detail: {},
      },
    ]);

    await db.insert(functionSummaries).values([
      {
        id: generateId(),
        workspaceId,
        functionId: selectedFunctionId,
        serviceId,
        summaryVersion: 1,
        summaryKind: 'http',
        outboundHttp: null,
        outboundDb: null,
        outboundMessage: null,
        callChainHints: [],
        aliasHints: [],
        signalSources: ['legacy_edge'],
        provenanceEvidenceIds: [],
        extractionStrategy: 'legacy_edges_fallback',
        unresolvedReasons: ['HOST_ALIAS_UNRESOLVED'],
        summaryCompleteness: 0.25,
        flags: { truncated: true },
        confidence: 0.4,
        sourceHash: 'summary-selected',
        status: 'ACTIVE',
      },
      {
        id: generateId(),
        workspaceId,
        functionId: ignoredFunctionId,
        serviceId,
        summaryVersion: 1,
        summaryKind: 'http',
        outboundHttp: { method: 'GET', path: '/api/catalog/{id}' },
        outboundDb: null,
        outboundMessage: null,
        callChainHints: [],
        aliasHints: [],
        signalSources: ['ast'],
        provenanceEvidenceIds: [],
        extractionStrategy: 'ast_primary',
        unresolvedReasons: [],
        summaryCompleteness: 0.95,
        flags: {},
        confidence: 0.9,
        sourceHash: 'summary-ignored',
        status: 'ACTIVE',
      },
    ]);

    const candidates = await loadSmartSummaryEnhancementCandidates(db, {
      workspaceId,
      proofStateIds: [selectedProofStateId, ignoredProofStateId],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.functionId).toBe(selectedFunctionId);
    expect(candidates[0]?.snippet).toContain("fetch('/api/orders/1')");
    expect(candidates[0]?.snippetSource).toContain(selectedFilePath);

    const activeSummaries = await db
      .select()
      .from(functionSummaries)
      .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.status, 'ACTIVE')));
    expect(activeSummaries).toHaveLength(2);
  });
});
