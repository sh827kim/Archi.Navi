import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  inferenceRunEvents,
  inferenceRuns,
  inferenceRunSources,
} from '@archi-navi/db';
import {
  executeSmartPipeline,
  getInferenceRunDetail,
  type CallExtractionResult,
  type ConfigAnalysisResult,
  type SmartAtomicAgentStep,
  type SmartAtomicAnalysisMode,
} from '@archi-navi/inference';

interface SmartSummaryBuilderInput {
  phase1?: {
    openApi?: unknown;
    bootstrapEndpointCount?: number;
  };
  phase2: {
    analyzedServiceCount: number;
    servicePairCount?: number;
  };
  phase3: {
    analysisMode?: SmartAtomicAnalysisMode;
    analyzedServiceCount: number;
    candidateCount: number;
    atomicCandidateCount?: number;
    serviceFallbackCount?: number;
    deepInspectionCount?: number;
    agentEscalatedPairCount?: number;
    agentRecoveredAtomicCount?: number;
    agentFailedPairCount?: number;
    agentToolUsageSummary?: unknown;
    deepInspectionTrace?: unknown;
    fallbackReasonBreakdown?: unknown;
  };
}

async function appendRunEvent(
  db: DbClient,
  input: {
    workspaceId: string;
    runId: string;
    level?: 'INFO' | 'WARN' | 'ERROR';
    eventType: string;
    message: string;
    payload?: Record<string, unknown>;
  },
) {
  await db.insert(inferenceRunEvents).values({
    workspaceId: input.workspaceId,
    runId: input.runId,
    level: input.level ?? 'INFO',
    eventType: input.eventType,
    message: input.message,
    payload: input.payload ?? {},
  });
}

export async function executeQueuedSmartInferenceRun(input: {
  db: DbClient;
  workspaceId: string;
  runId: string;
  repoRoots: string[];
  modelName: string;
  buildSummary: (result: SmartSummaryBuilderInput) => Record<string, unknown>;
  generateConfigAnalysis: (prompt: string) => Promise<ConfigAnalysisResult>;
  generateCallExtraction: (prompt: string) => Promise<CallExtractionResult>;
  generateAgentStep: (prompt: string) => Promise<SmartAtomicAgentStep>;
  analysisMode: SmartAtomicAnalysisMode;
}) {
  const runRows = await input.db
    .select()
    .from(inferenceRuns)
    .where(
      and(
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.id, input.runId),
      ),
    )
    .limit(1);

  const run = runRows[0];
  if (!run || run.status !== 'QUEUED' || run.triggerType !== 'SMART_PIPELINE') {
    return;
  }

  const claimedRows = await input.db
    .update(inferenceRuns)
    .set({
      status: 'RUNNING',
      attemptCount: run.attemptCount + 1,
      startedAt: new Date(),
      updatedAt: new Date(),
      errorMessage: null,
    })
    .where(
      and(
        eq(inferenceRuns.workspaceId, input.workspaceId),
        eq(inferenceRuns.id, input.runId),
        eq(inferenceRuns.status, 'QUEUED'),
      ),
    )
    .returning({ id: inferenceRuns.id });

  if (!claimedRows[0]) {
    return;
  }

  await input.db
    .update(inferenceRunSources)
    .set({
      status: 'RUNNING',
      resolvedRepoRoot: null,
      message: 'Smart pipeline 준비 중',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inferenceRunSources.workspaceId, input.workspaceId),
        eq(inferenceRunSources.runId, input.runId),
      ),
    );

  const sourceRows = await input.db
    .select({ id: inferenceRunSources.id, sourceRef: inferenceRunSources.sourceRef })
    .from(inferenceRunSources)
    .where(
      and(
        eq(inferenceRunSources.workspaceId, input.workspaceId),
        eq(inferenceRunSources.runId, input.runId),
      ),
    );

  for (const source of sourceRows) {
    await input.db
      .update(inferenceRunSources)
      .set({
        status: 'RUNNING',
        resolvedRepoRoot: source.sourceRef,
        message: 'Smart pipeline 실행 중',
        updatedAt: new Date(),
      })
      .where(eq(inferenceRunSources.id, source.id));
  }

  await appendRunEvent(input.db, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    eventType: 'RUN_STARTED',
    message: 'Smart inference run이 시작되었습니다.',
    payload: {
      repoRootCount: input.repoRoots.length,
      model: input.modelName,
    },
  });

  try {
    const pipelineResult = await executeSmartPipeline(input.db, {
      workspaceId: input.workspaceId,
      repoRoots: input.repoRoots,
      generateConfigAnalysis: input.generateConfigAnalysis,
      generateCallExtraction: input.generateCallExtraction,
      generateAgentStep: input.generateAgentStep,
      atomicAnalysisMode: input.analysisMode,
    });
    const smartSummary = input.buildSummary(pipelineResult);

    await input.db
      .update(inferenceRunSources)
      .set({
        status: 'SUCCEEDED',
        message: 'Smart pipeline 완료',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inferenceRunSources.workspaceId, input.workspaceId),
          eq(inferenceRunSources.runId, input.runId),
        ),
      );

    await input.db
      .update(inferenceRuns)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        updatedAt: new Date(),
        warnings: [],
        errors: [],
        errorMessage: null,
        stats: {
          smartSummary,
          model: input.modelName,
          repoRoots: input.repoRoots,
          totalDurationMs: pipelineResult.totalDurationMs,
        },
      })
      .where(
        and(
          eq(inferenceRuns.workspaceId, input.workspaceId),
          eq(inferenceRuns.id, input.runId),
        ),
      );

    await appendRunEvent(input.db, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      eventType: 'RUN_COMPLETED',
      message: 'Smart inference run이 완료되었습니다.',
      payload: {
        summary: smartSummary,
        model: input.modelName,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown smart pipeline error';

    await input.db
      .update(inferenceRunSources)
      .set({
        status: 'FAILED',
        message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inferenceRunSources.workspaceId, input.workspaceId),
          eq(inferenceRunSources.runId, input.runId),
        ),
      );

    await input.db
      .update(inferenceRuns)
      .set({
        status: 'FAILED',
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorMessage: message,
        warnings: [],
        errors: [{ mode: 'smart', message }],
      })
      .where(
        and(
          eq(inferenceRuns.workspaceId, input.workspaceId),
          eq(inferenceRuns.id, input.runId),
        ),
      );

    await appendRunEvent(input.db, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      level: 'ERROR',
      eventType: 'RUN_FAILED',
      message: `Smart inference run 실패: ${message}`,
      payload: { model: input.modelName },
    });
  }
}

export async function getSmartInferenceRunDetail(input: {
  db: DbClient;
  workspaceId: string;
  runId: string;
}) {
  const detail = await getInferenceRunDetail(input.db, {
    workspaceId: input.workspaceId,
    runId: input.runId,
  });

  if (detail.run.triggerType !== 'SMART_PIPELINE') {
    throw new Error(`Smart inference run을 찾을 수 없습니다: ${input.runId}`);
  }

  const stats =
    detail.run.stats && typeof detail.run.stats === 'object' && !Array.isArray(detail.run.stats)
      ? detail.run.stats as Record<string, unknown>
      : {};
  const summary =
    stats.smartSummary && typeof stats.smartSummary === 'object' && !Array.isArray(stats.smartSummary)
      ? stats.smartSummary as Record<string, unknown>
      : null;

  return {
    detail,
    summary,
  };
}
