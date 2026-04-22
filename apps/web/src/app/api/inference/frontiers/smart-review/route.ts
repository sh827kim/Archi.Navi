import { and, eq, inArray } from 'drizzle-orm';
import {
  getDb,
  proofFrontiers,
  proofStates,
  smartProofLlmCalls,
} from '@archi-navi/db';
import {
  canAffordSmartBudgetCall,
  createSmartBudgetTracker,
  normalizeSmartProofConfig,
  recordSmartBudgetCall,
  resolveSmartAmbiguity,
} from '@archi-navi/inference';
import { NextResponse } from 'next/server';
import { createGenerateSmartResolutionFn, getInferenceModel } from '@/lib/inference-llm';

interface SmartFrontierReviewRequest {
  workspaceId?: string;
  proofStateId?: string;
  proofStateIds?: string[];
  smartProof?: boolean | Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asString(entry)).filter((entry) => entry.length > 0))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildRequestedSmartProof(input?: SmartFrontierReviewRequest['smartProof']) {
  const normalizedBase = normalizeSmartProofConfig(input ?? true);
  return normalizeSmartProofConfig({
    ...normalizedBase,
    enabled: true,
    categories: {
      ...normalizedBase.categories,
      ambiguityResolution: true,
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as SmartFrontierReviewRequest;
    const workspaceId = asString(body.workspaceId);
    const requestedProofStateId = asString(body.proofStateId);
    const requestedProofStateIds = asStringArray(body.proofStateIds);
    const requestedIds = [...new Set([
      ...(requestedProofStateId ? [requestedProofStateId] : []),
      ...requestedProofStateIds,
    ])];

    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
        { status: 400 },
      );
    }

    const db = await getDb();
    const requestedSmartProof = buildRequestedSmartProof(body.smartProof);
    const modelInfo = getInferenceModel(req);
    if (!modelInfo) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SMART_MODEL_NOT_CONFIGURED',
            message: 'Smart 재검토를 실행할 LLM 모델이 설정되지 않았습니다.',
          },
        },
        { status: 400 },
      );
    }

    const targetRows = await db
      .select({ proofStateId: proofFrontiers.proofStateId })
      .from(proofFrontiers)
      .innerJoin(proofStates, eq(proofStates.id, proofFrontiers.proofStateId))
      .where(
        and(
          eq(proofFrontiers.workspaceId, workspaceId),
          eq(proofFrontiers.frontierReason, 'PROVIDER_SERVICE_AMBIGUOUS'),
          eq(proofStates.status, 'FRONTIER'),
          ...(requestedIds.length > 0 ? [inArray(proofFrontiers.proofStateId, requestedIds)] : []),
        ),
      );

    if (requestedIds.length > 0 && targetRows.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: '요청한 proofStateId의 pending PROVIDER_SERVICE_AMBIGUOUS frontier를 찾지 못했습니다.',
          },
        },
        { status: 404 },
      );
    }

    const targetProofStateIds = [...new Set(targetRows.map((row) => row.proofStateId))];
    if (targetProofStateIds.length === 0) {
      return NextResponse.json({
        success: true,
        requestedSmartProof,
        summary: {
          targetCount: 0,
          attemptedCount: 0,
          resolvedCount: 0,
          reclassifiedCount: 0,
          promotedCount: 0,
          reclassificationCounts: {},
          acceptedCount: 0,
          pendingCount: 0,
          skippedCount: 0,
        },
        results: [],
        smartCallRecords: [],
      });
    }

    const generateFn = createGenerateSmartResolutionFn(modelInfo.model, modelInfo.modelName);
    let budget = createSmartBudgetTracker({
      maxCalls: requestedSmartProof.budget.maxLlmCallsPerRun,
      maxTokens: requestedSmartProof.budget.maxTotalTokensPerRun,
    });

    const results: Array<Awaited<ReturnType<typeof resolveSmartAmbiguity>>> = [];
    for (const proofStateId of targetProofStateIds) {
      if (!canAffordSmartBudgetCall(budget, requestedSmartProof.budget.maxInputTokensPerCall)) {
        results.push({
          proofStateId,
          frontierReason: 'PROVIDER_SERVICE_AMBIGUOUS',
          attempted: false,
          resolved: false,
          confidence: 0,
          reasoning: 'smart budget exhausted',
          decision: 'SKIPPED',
          patch: null,
          validationStatus: null,
          errors: ['SMART_BUDGET_EXHAUSTED'],
          resolution: null,
          llmCallId: null,
          tokensUsed: { input: 0, output: 0 },
        });
        continue;
      }

      const result = await resolveSmartAmbiguity(db, {
        workspaceId,
        proofStateId,
        config: requestedSmartProof,
        generateFn,
      });
      results.push(result);
      budget = recordSmartBudgetCall(budget, {
        inputTokens: result.tokensUsed.input,
        outputTokens: result.tokensUsed.output,
      });
    }

    const llmCallIds = results
      .map((result) => result.llmCallId)
      .filter((value): value is string => Boolean(value));
    const llmCalls = llmCallIds.length > 0
      ? await db
        .select({
          id: smartProofLlmCalls.id,
          proofStateId: smartProofLlmCalls.proofStateId,
          callCategory: smartProofLlmCalls.callCategory,
          accepted: smartProofLlmCalls.accepted,
          patchId: smartProofLlmCalls.patchId,
          inputTokens: smartProofLlmCalls.inputTokens,
          outputTokens: smartProofLlmCalls.outputTokens,
        })
        .from(smartProofLlmCalls)
        .where(and(eq(smartProofLlmCalls.workspaceId, workspaceId), inArray(smartProofLlmCalls.id, llmCallIds)))
      : [];

    const remainingRows = await db
      .select({ proofStateId: proofFrontiers.proofStateId })
      .from(proofFrontiers)
      .innerJoin(proofStates, eq(proofStates.id, proofFrontiers.proofStateId))
      .where(
        and(
          eq(proofFrontiers.workspaceId, workspaceId),
          eq(proofFrontiers.frontierReason, 'PROVIDER_SERVICE_AMBIGUOUS'),
          eq(proofStates.status, 'FRONTIER'),
          inArray(proofFrontiers.proofStateId, targetProofStateIds),
        ),
      );
    const remainingProofStateIds = [...new Set(remainingRows.map((row) => row.proofStateId))];

    const acceptedResults = results.filter((result) => result.validationStatus === 'ACCEPTED');
    const reclassificationCounts = acceptedResults.reduce<Record<string, number>>((acc, result) => {
      const patchType = asString(asRecord(result.patch)['patchType']);
      if (!patchType) return acc;
      acc[patchType] = (acc[patchType] ?? 0) + 1;
      return acc;
    }, {});
    const reclassifiedCount = acceptedResults.length;
    const promotedCount = results.filter((result) => (
      result.validationStatus === 'ACCEPTED'
      && asString(asRecord(result.resolution)['status']) === 'CLOSED_ATOMIC'
    )).length;

    const summary = {
      targetCount: targetProofStateIds.length,
      attemptedCount: results.filter((result) => result.attempted).length,
      resolvedCount: results.filter((result) => result.resolved).length,
      reclassifiedCount,
      promotedCount,
      reclassificationCounts,
      // Backward-compatible field. UI should present reclassification/promoted semantics instead.
      acceptedCount: acceptedResults.length,
      pendingCount: results.filter((result) => result.validationStatus === 'PENDING').length,
      skippedCount: results.filter((result) => result.decision === 'SKIPPED').length,
      budget,
    };

    return NextResponse.json({
      success: true,
      requestedSmartProof,
      summary,
      results,
      smartCallRecords: llmCalls,
      remainingProofStateIds,
    });
  } catch (error) {
    console.error('[POST /api/inference/frontiers/smart-review]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Frontier Smart 재검토 중 오류가 발생했습니다.',
        },
      },
      { status: 500 },
    );
  }
}
