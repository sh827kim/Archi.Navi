import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  getDb,
  interactionIntents,
  objects,
  proofFrontiers,
  proofPatches,
  proofStates,
  proofSteps,
} from '@archi-navi/db';
import { NextResponse } from 'next/server';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeLookup(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const PATCHABLE_REASON_MAP: Record<string, string[]> = {
  CONFIG_BINDING_MISSING: ['alias_binding'],
  HOST_ALIAS_UNRESOLVED: ['alias_binding'],
  PATH_ONLY_TARGET_UNRESOLVED: ['alias_binding'],
  PROVIDER_SERVICE_AMBIGUOUS: ['provider_service_selection'],
  ENDPOINT_MATCH_AMBIGUOUS: ['endpoint_disambiguation'],
  PROVIDER_ENDPOINT_NOT_FOUND: ['method_path_hint'],
  METHOD_UNKNOWN: ['method_path_hint'],
  PATH_TEMPLATE_UNKNOWN: ['method_path_hint'],
  ROUTE_FAMILY_DERIVATION_EMPTY: ['route_transform_patch'],
  ROUTE_TO_ENDPOINT_COMPOSITION_FAILED: ['route_transform_patch'],
};

function normalizeIntentType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ proofStateId: string }> },
) {
  try {
    const { proofStateId } = await params;
    const url = new URL(req.url);
    const workspaceId = normalizeLookup(url.searchParams.get('workspaceId'));
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!proofStateId) {
      return NextResponse.json({ error: 'proofStateId is required' }, { status: 400 });
    }

    const db = await getDb();
    const [state] = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.id, proofStateId)))
      .limit(1);
    if (!state) {
      return NextResponse.json({ error: 'frontier proof state not found' }, { status: 404 });
    }

    const [frontier] = await db
      .select()
      .from(proofFrontiers)
      .where(and(eq(proofFrontiers.workspaceId, workspaceId), eq(proofFrontiers.proofStateId, proofStateId)))
      .limit(1);
    if (!frontier) {
      return NextResponse.json({ error: 'frontier not found' }, { status: 404 });
    }

    const [intent] = await db
      .select()
      .from(interactionIntents)
      .where(and(eq(interactionIntents.workspaceId, workspaceId), eq(interactionIntents.id, state.intentId)))
      .limit(1);

    const [latestPatch] = await db
      .select()
      .from(proofPatches)
      .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.proofStateId, proofStateId)))
      .orderBy(desc(proofPatches.createdAt), desc(proofPatches.id))
      .limit(1);

    const steps = await db
      .select()
      .from(proofSteps)
      .where(eq(proofSteps.proofStateId, proofStateId))
      .orderBy(desc(proofSteps.stepOrder))
      .limit(20);

    const detail = asRecord(frontier.detail);
    const candidateProviderIds = asStringArray(detail['candidateProviderIds']);
    const candidateEndpointIds = [
      ...new Set([
        ...asStringArray(detail['candidateObjectIds']),
        ...asStringArray(asRecord(detail['endpointCandidateSet'])['objectIds']),
      ]),
    ];
    const sourceServiceTokens = [
      normalizeLookup(intent?.targetServiceHint),
      normalizeLookup(intent?.providerHint),
      normalizeLookup(intent?.hostHint),
      ...asStringArray(detail['hostHints']).map((item) => item.trim()),
    ]
      .map((item) => item.toLowerCase())
      .filter((item) => item.length > 0);

    const [candidateServices, candidateEndpoints] = await Promise.all([
      candidateProviderIds.length > 0
        ? db
          .select({ id: objects.id, name: objects.name, objectType: objects.objectType, parentId: objects.parentId })
          .from(objects)
          .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, candidateProviderIds)))
        : Promise.resolve([]),
      candidateEndpointIds.length > 0
        ? db
          .select({ id: objects.id, name: objects.name, objectType: objects.objectType, parentId: objects.parentId })
          .from(objects)
          .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, candidateEndpointIds)))
        : Promise.resolve([]),
    ]);

    const serviceSuggestions = await db
      .select({ id: objects.id, name: objects.name, objectType: objects.objectType, parentId: objects.parentId })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')))
      .limit(1000);
    const suggestedServices = sourceServiceTokens.length === 0
      ? serviceSuggestions.slice(0, 20)
      : serviceSuggestions
        .filter((service) => {
          const normalizedName = service.name.toLowerCase();
          return sourceServiceTokens.some((token) => normalizedName.includes(token));
        })
        .slice(0, 20);

    const patchableActions = [...(PATCHABLE_REASON_MAP[frontier.frontierReason] ?? [])];
    if (
      frontier.frontierReason === 'PATH_TEMPLATE_UNKNOWN'
      && normalizeIntentType(intent?.intentType) === 'http_gateway_route'
    ) {
      patchableActions.push('route_transform_patch');
    }
    const sourceService = state.consumerServiceId
      ? (await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, state.consumerServiceId)))
        .limit(1))[0] ?? null
      : null;
    const sourceFunction = state.sourceFunctionId
      ? (await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, state.sourceFunctionId)))
        .limit(1))[0] ?? null
      : null;
    const providerService = state.providerServiceId
      ? (await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, state.providerServiceId)))
        .limit(1))[0] ?? null
      : null;

    return NextResponse.json({
      proofStateId,
      status: state.status,
      intentId: state.intentId,
      intentType: intent?.intentType ?? state.proofType,
      sourceServiceId: sourceService?.id ?? state.consumerServiceId,
      sourceServiceName: sourceService?.name ?? null,
      sourceFunctionId: sourceFunction?.id ?? state.sourceFunctionId,
      sourceFunctionName: sourceFunction?.name ?? null,
      providerServiceId: providerService?.id ?? state.providerServiceId,
      providerServiceName: providerService?.name ?? null,
      frontierReason: frontier.frontierReason,
      frontierClass: frontier.frontierClass,
      retryStrategy: frontier.retryStrategy,
      priority: frontier.priority,
      confidence: state.confidence,
      detail,
      methodResolved: state.methodResolved,
      externalPathResolved: state.externalPathResolved,
      internalPathResolved: state.internalPathResolved,
      latestPatch: latestPatch
        ? {
          id: latestPatch.id,
          patchType: latestPatch.patchType,
          validationStatus: latestPatch.validationStatus,
          sourceKind: latestPatch.sourceKind,
          createdAt: latestPatch.createdAt,
        }
        : null,
      patchableActions,
      candidateServices,
      candidateEndpoints,
      suggestedServices,
      recentProofSteps: steps.map((step) => ({
        id: step.id,
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        status: step.status,
        message: step.message,
        inputSnapshot: asRecord(step.inputSnapshot),
        outputSnapshot: asRecord(step.outputSnapshot),
      })),
    });
  } catch (error) {
    console.error('[GET /api/inference/frontiers/:proofStateId]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
