import { and, eq } from 'drizzle-orm';
import { getDb, proofStates, relationCandidates } from '@archi-navi/db';
import { type ProofPatchType, validateAndApplyProofPatch } from '@archi-navi/inference';
import { NextResponse } from 'next/server';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const SUPPORTED_PATCH_TYPES: ProofPatchType[] = [
  'alias_binding',
  'provider_service_selection',
  'endpoint_disambiguation',
  'method_path_hint',
  'route_transform_patch',
];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ proofStateId: string }> },
) {
  try {
    const { proofStateId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      workspaceId?: string;
      patchType?: ProofPatchType;
      payload?: JsonRecord;
      applyMode?: 'apply' | 'defer';
    };
    const workspaceId = asString(body.workspaceId);
    const patchType = body.patchType;
    const payload = asRecord(body.payload);

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!proofStateId) {
      return NextResponse.json({ error: 'proofStateId is required' }, { status: 400 });
    }
    if (!patchType) {
      return NextResponse.json({ error: 'patchType is required' }, { status: 400 });
    }
    if (!SUPPORTED_PATCH_TYPES.includes(patchType)) {
      return NextResponse.json({ error: `unsupported patchType: ${patchType}` }, { status: 400 });
    }

    const db = await getDb();
    const [stateBefore] = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.id, proofStateId)))
      .limit(1);
    if (!stateBefore) {
      return NextResponse.json({ error: 'frontier proof state not found' }, { status: 404 });
    }

    const patchResult = await validateAndApplyProofPatch(db, {
      workspaceId,
      proofStateId,
      patchType,
      payload,
      sourceKind: 'manual',
      applyMode: body.applyMode === 'defer' ? 'defer' : 'apply',
    });

    const [stateAfter] = await db
      .select()
      .from(proofStates)
      .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.id, proofStateId)))
      .limit(1);

    const candidates = await db
      .select({ id: relationCandidates.id, metadata: relationCandidates.metadata })
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    const createdOrUpdatedCandidateIds = candidates
      .filter((candidate) => asString(asRecord(candidate.metadata)['proofStateId']) === proofStateId)
      .map((candidate) => candidate.id);

    return NextResponse.json({
      patchId: patchResult.patchId,
      validationStatus: patchResult.validationStatus,
      errors: patchResult.errors,
      resolution: patchResult.resolution,
      proofStatus: patchResult.resolution?.status ?? stateAfter?.status ?? stateBefore.status,
      createdOrUpdatedCandidateIds,
    });
  } catch (error) {
    console.error('[POST /api/inference/frontiers/:proofStateId/patch]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
