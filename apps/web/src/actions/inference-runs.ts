'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@archi-navi/db';
import {
  interactionIntents,
  objects,
  proofFrontiers,
  proofStates,
  proofSteps,
} from '@archi-navi/db';
import {
  listInferenceRuns,
  cancelInferenceRun,
  retryInferenceRun,
  executeInferenceRun,
  getInferenceRunDetail,
  type InferenceRunListItem,
} from '@archi-navi/inference';
import {
  extractInferencePipelineMeta,
  type InferencePipelineName,
} from '@/lib/inference-pipeline';

export interface DashboardInferenceRunItem {
  id: string;
  status: string;
  triggerType: string;
  pipeline: InferencePipelineName;
  pipelineVersion: string;
  requestedModes: string[];
  requestedCodeEngine: string | null;
  requestedIncremental: boolean;
  attemptCount: number;
  maxAttempts: number;
  sourceSummary: Record<string, number>;
  stats: Record<string, unknown>;
  warnings: string[];
  errors: Array<{ mode: string; message: string }>;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

function serializeRunItem(item: InferenceRunListItem): DashboardInferenceRunItem {
  const pipeline = extractInferencePipelineMeta(item.stats);
  return {
    id: item.id,
    status: item.status,
    triggerType: item.triggerType,
    pipeline: pipeline.name,
    pipelineVersion: pipeline.version,
    requestedModes: Array.isArray(item.requestedModes) ? (item.requestedModes as string[]) : [],
    requestedCodeEngine: item.requestedCodeEngine,
    requestedIncremental: item.requestedIncremental,
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    sourceSummary: (item.sourceSummary ?? {}) as Record<string, number>,
    stats: (item.stats ?? {}) as Record<string, unknown>,
    warnings: Array.isArray(item.warnings) ? (item.warnings as string[]) : [],
    errors: Array.isArray(item.errors)
      ? (item.errors as Array<{ mode: string; message: string }>)
      : [],
    errorMessage: item.errorMessage,
    startedAt: item.startedAt ? item.startedAt.toISOString() : null,
    finishedAt: item.finishedAt ? item.finishedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  };
}

export async function listDashboardInferenceRuns(input: {
  workspaceId: string;
  limit?: number;
}): Promise<DashboardInferenceRunItem[]> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return [];

  const db = await getDb();
  const items = await listInferenceRuns(db, {
    workspaceId,
    limit: Math.min(100, Math.max(1, input.limit ?? 30)),
  });

  return items.map(serializeRunItem);
}

export async function mutateDashboardInferenceRun(input: {
  workspaceId: string;
  runId: string;
  action: 'cancel' | 'retry';
}): Promise<{ canceled?: boolean; retried?: boolean; status?: string; reason?: string }> {
  const workspaceId = input.workspaceId.trim();
  const runId = input.runId.trim();
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!runId) throw new Error('runId is required');

  const db = await getDb();

  if (input.action === 'cancel') {
    return await cancelInferenceRun(db, { workspaceId, runId });
  }

  const result = await retryInferenceRun(db, { workspaceId, runId });
  if (result.retried) {
    queueMicrotask(() => {
      void executeInferenceRun(db, { workspaceId, runId }).catch((error) => {
        console.error('[mutateDashboardInferenceRun] retry executeInferenceRun failed', error);
      });
    });
  }
  return result;
}

/* ─── 상세 조회 ─── */
export interface DashboardInferenceRunDetail {
  run: DashboardInferenceRunItem;
  sources: Array<{
    id: string;
    sourceType: string;
    sourceRef: string;
    resolvedRepoRoot: string | null;
    status: string;
    message: string | null;
  }>;
  events: Array<{
    id: string;
    level: string;
    eventType: string;
    message: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  proofs: Array<{
    id: string;
    intentId: string;
    intentType: string;
    sourceServiceName: string | null;
    sourceFunctionName: string | null;
    parentProofStateId: string | null;
    childProofStateIds: string[];
    proofType: string;
    status: string;
    targetObjectName: string | null;
    targetObjectType: string | null;
    providerServiceName: string | null;
    methodResolved: string | null;
    externalPathResolved: string | null;
    internalPathResolved: string | null;
    routeChain: string[];
    ambiguityCount: number;
    contradictionCount: number;
    confidence: number;
    confidenceBreakdown: Record<string, unknown>;
    frontier: {
      frontierReason: string;
      frontierClass: string;
      retryStrategy: string;
      priority: number;
      detail: Record<string, unknown>;
    } | null;
    rejectedReason: string | null;
    steps: Array<{
      id: string;
      stepOrder: number;
      stepType: string;
      status: string;
      message: string | null;
      inputSnapshot: Record<string, unknown>;
      outputSnapshot: Record<string, unknown>;
    }>;
  }>;
}

export async function getDashboardInferenceRunDetail(input: {
  workspaceId: string;
  runId: string;
}): Promise<DashboardInferenceRunDetail | null> {
  const workspaceId = input.workspaceId.trim();
  const runId = input.runId.trim();
  if (!workspaceId || !runId) return null;

  try {
    const db = await getDb();
    const detail = await getInferenceRunDetail(db, { workspaceId, runId });
    const runIntentRows = await db
      .select({
        id: interactionIntents.id,
        intentType: interactionIntents.intentType,
        sourceServiceId: interactionIntents.sourceServiceId,
        sourceFunctionId: interactionIntents.sourceFunctionId,
      })
      .from(interactionIntents)
      .where(
        and(
          eq(interactionIntents.workspaceId, workspaceId),
          eq(interactionIntents.updatedRunId, runId),
        ),
      );
    const intentIds = runIntentRows.map((row) => row.id);

    const proofRows = intentIds.length > 0
      ? await db
        .select()
        .from(proofStates)
        .where(
          and(
            eq(proofStates.workspaceId, workspaceId),
            inArray(proofStates.intentId, intentIds),
          ),
        )
        .orderBy(proofStates.createdAt)
      : [];
    const proofIds = proofRows.map((row) => row.id);
    const [frontierRows, stepRows] = proofIds.length > 0
      ? await Promise.all([
        db
          .select()
          .from(proofFrontiers)
          .where(
            and(
              eq(proofFrontiers.workspaceId, workspaceId),
              inArray(proofFrontiers.proofStateId, proofIds),
            ),
          ),
        db
          .select()
          .from(proofSteps)
          .where(inArray(proofSteps.proofStateId, proofIds))
          .orderBy(proofSteps.proofStateId, proofSteps.stepOrder),
      ])
      : [[], []];

    const objectIds = [
      ...new Set([
        ...runIntentRows.map((row) => row.sourceServiceId),
        ...runIntentRows.map((row) => row.sourceFunctionId).filter((value): value is string => Boolean(value)),
        ...proofRows.map((row) => row.providerServiceId).filter((value): value is string => Boolean(value)),
        ...proofRows.map((row) => row.targetObjectId).filter((value): value is string => Boolean(value)),
      ]),
    ];
    const objectRows = objectIds.length > 0
      ? await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(
          and(
            eq(objects.workspaceId, workspaceId),
            inArray(objects.id, objectIds),
          ),
        )
      : [];
    const objectNameById = new Map(objectRows.map((row) => [row.id, row.name]));
    const intentById = new Map(runIntentRows.map((row) => [row.id, row]));
    const frontierByProofId = new Map(frontierRows.map((row) => [row.proofStateId, row]));
    const stepsByProofId = new Map<string, typeof stepRows>();
    for (const step of stepRows) {
      const list = stepsByProofId.get(step.proofStateId) ?? [];
      list.push(step);
      stepsByProofId.set(step.proofStateId, list);
    }
    const childProofIdsByParent = new Map<string, string[]>();
    for (const proof of proofRows) {
      if (!proof.parentProofStateId) continue;
      const list = childProofIdsByParent.get(proof.parentProofStateId) ?? [];
      list.push(proof.id);
      childProofIdsByParent.set(proof.parentProofStateId, list);
    }

    return {
      run: serializeRunItem(detail.run),
      sources: detail.sources.map((s) => ({
        id: s.id,
        sourceType: s.sourceType,
        sourceRef: s.sourceRef,
        resolvedRepoRoot: s.resolvedRepoRoot,
        status: s.status,
        message: s.message,
      })),
      events: detail.events.map((e) => ({
        id: e.id,
        level: e.level,
        eventType: e.eventType,
        message: e.message,
        payload: (e.payload ?? {}) as Record<string, unknown>,
        createdAt: e.createdAt.toISOString(),
      })),
      proofs: proofRows.map((proof) => {
        const intent = intentById.get(proof.intentId);
        const frontier = frontierByProofId.get(proof.id);
        return {
          id: proof.id,
          intentId: proof.intentId,
          intentType: intent?.intentType ?? proof.proofType,
          sourceServiceName: intent?.sourceServiceId ? objectNameById.get(intent.sourceServiceId) ?? null : null,
          sourceFunctionName: intent?.sourceFunctionId ? objectNameById.get(intent.sourceFunctionId) ?? null : null,
          parentProofStateId: proof.parentProofStateId,
          childProofStateIds: childProofIdsByParent.get(proof.id) ?? [],
          proofType: proof.proofType,
          status: proof.status,
          targetObjectName: proof.targetObjectId ? objectNameById.get(proof.targetObjectId) ?? null : null,
          targetObjectType: proof.targetObjectType,
          providerServiceName: proof.providerServiceId ? objectNameById.get(proof.providerServiceId) ?? null : null,
          methodResolved: proof.methodResolved,
          externalPathResolved: proof.externalPathResolved,
          internalPathResolved: proof.internalPathResolved,
          routeChain: Array.isArray(proof.routeChain) ? (proof.routeChain as string[]) : [],
          ambiguityCount: proof.ambiguityCount,
          contradictionCount: proof.contradictionCount,
          confidence: proof.confidence,
          confidenceBreakdown: ((proof as unknown as { confidenceBreakdown?: Record<string, unknown> }).confidenceBreakdown ?? {}) as Record<string, unknown>,
          frontier: frontier
            ? {
              frontierReason: frontier.frontierReason,
              frontierClass: frontier.frontierClass,
              retryStrategy: frontier.retryStrategy,
              priority: frontier.priority,
              detail: (frontier.detail ?? {}) as Record<string, unknown>,
            }
            : null,
          rejectedReason: proof.rejectedReason,
          steps: (stepsByProofId.get(proof.id) ?? []).map((step) => ({
            id: step.id,
            stepOrder: step.stepOrder,
            stepType: step.stepType,
            status: step.status,
            message: step.message ?? null,
            inputSnapshot: (step.inputSnapshot ?? {}) as Record<string, unknown>,
            outputSnapshot: (step.outputSnapshot ?? {}) as Record<string, unknown>,
          })),
        };
      }),
    };
  } catch {
    return null;
  }
}
