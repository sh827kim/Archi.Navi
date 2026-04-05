import type { DbClient } from '@archi-navi/db';
import {
  buildEmptyProofEngineSummary,
  executeInferenceRun,
  getInferenceRunDetail,
} from '@archi-navi/inference';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function executeQueuedSmartInferenceRun(input: {
  db: DbClient;
  workspaceId: string;
  runId: string;
}) {
  return executeInferenceRun(input.db, {
    workspaceId: input.workspaceId,
    runId: input.runId,
  });
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

  if (detail.run.triggerType !== 'INTENT_PROOF_ENGINE') {
    throw new Error(`Smart inference run을 찾을 수 없습니다: ${input.runId}`);
  }

  const stats = asRecord(detail.run.stats);
  const summary = asRecord(stats?.proofSummary) ?? buildEmptyProofEngineSummary();

  return {
    detail,
    summary,
  };
}
