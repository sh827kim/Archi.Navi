import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  getDb,
  interactionIntents,
  objects,
  proofFrontiers,
  proofPatches,
  proofStates,
} from '@archi-navi/db';
import { NextResponse } from 'next/server';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function normalizeLookup(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId = normalizeLookup(url.searchParams.get('workspaceId'));
    const reason = normalizeLookup(url.searchParams.get('reason'));
    const sourceServiceId = normalizeLookup(url.searchParams.get('sourceServiceId'));

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const whereClauses = [eq(proofFrontiers.workspaceId, workspaceId)];
    if (reason) whereClauses.push(eq(proofFrontiers.frontierReason, reason));

    const frontiers = await db
      .select()
      .from(proofFrontiers)
      .where(and(...whereClauses))
      .orderBy(desc(proofFrontiers.priority), desc(proofFrontiers.updatedAt));

    if (frontiers.length === 0) {
      return NextResponse.json([]);
    }

    const proofStateIds = frontiers.map((row) => row.proofStateId);
    const states = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), inArray(proofStates.id, proofStateIds)));
    const stateById = new Map(states.map((row) => [row.id, row]));

    const filteredFrontiers = sourceServiceId
      ? frontiers.filter((row) => stateById.get(row.proofStateId)?.consumerServiceId === sourceServiceId)
      : frontiers;
    if (filteredFrontiers.length === 0) {
      return NextResponse.json([]);
    }

    const filteredStateIds = [...new Set(filteredFrontiers.map((row) => row.proofStateId))];
    const filteredStates = filteredStateIds
      .map((id) => stateById.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    const intentIds = [...new Set(filteredStates.map((row) => row.intentId))];
    const intents = intentIds.length > 0
      ? await db
        .select()
        .from(interactionIntents)
        .where(and(eq(interactionIntents.workspaceId, workspaceId), inArray(interactionIntents.id, intentIds)))
      : [];
    const intentById = new Map(intents.map((row) => [row.id, row]));

    const objectIds = [
      ...new Set(
        filteredStates.flatMap((state) => [
          state.consumerServiceId,
          state.sourceFunctionId,
          state.providerServiceId,
        ]).filter((id): id is string => Boolean(id)),
      ),
    ];
    const objectRows = objectIds.length > 0
      ? await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
      : [];
    const objectNameById = new Map(objectRows.map((row) => [row.id, row.name]));

    const patchRows = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), inArray(proofPatches.proofStateId, filteredStateIds)))
      .orderBy(desc(proofPatches.createdAt), desc(proofPatches.id));
    const latestPatchByProofStateId = new Map<string, (typeof patchRows)[number]>();
    for (const patch of patchRows) {
      if (!latestPatchByProofStateId.has(patch.proofStateId ?? '')) {
        latestPatchByProofStateId.set(patch.proofStateId ?? '', patch);
      }
    }

    const payload = filteredFrontiers.map((frontier) => {
      const state = stateById.get(frontier.proofStateId);
      const intent = state ? intentById.get(state.intentId) : null;
      const latestPatch = latestPatchByProofStateId.get(frontier.proofStateId);

      return {
        proofStateId: frontier.proofStateId,
        intentId: state?.intentId ?? null,
        intentType: intent?.intentType ?? state?.proofType ?? null,
        sourceServiceId: state?.consumerServiceId ?? null,
        sourceServiceName: state?.consumerServiceId ? objectNameById.get(state.consumerServiceId) ?? null : null,
        sourceFunctionId: state?.sourceFunctionId ?? null,
        sourceFunctionName: state?.sourceFunctionId ? objectNameById.get(state.sourceFunctionId) ?? null : null,
        providerServiceId: state?.providerServiceId ?? null,
        providerServiceName: state?.providerServiceId ? objectNameById.get(state.providerServiceId) ?? null : null,
        status: state?.status ?? null,
        frontierReason: frontier.frontierReason,
        frontierClass: frontier.frontierClass,
        retryStrategy: frontier.retryStrategy,
        priority: frontier.priority,
        detail: asRecord(frontier.detail),
        methodResolved: state?.methodResolved ?? null,
        externalPathResolved: state?.externalPathResolved ?? null,
        internalPathResolved: state?.internalPathResolved ?? null,
        confidence: state?.confidence ?? 0,
        latestPatch: latestPatch
          ? {
            id: latestPatch.id,
            patchType: latestPatch.patchType,
            validationStatus: latestPatch.validationStatus,
            sourceKind: latestPatch.sourceKind,
            createdAt: latestPatch.createdAt,
          }
          : null,
      };
    });

    return NextResponse.json(payload);
  } catch (error) {
    console.error('[GET /api/inference/frontiers]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
