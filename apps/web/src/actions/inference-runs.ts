'use server';

import { getDb } from '@archi-navi/db';
import {
  listInferenceRuns,
  cancelInferenceRun,
  retryInferenceRun,
  executeInferenceRun,
  getInferenceRunDetail,
  type InferenceRunListItem,
} from '@archi-navi/inference';

export interface DashboardInferenceRunItem {
  id: string;
  status: string;
  triggerType: string;
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
  return {
    id: item.id,
    status: item.status,
    triggerType: item.triggerType,
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
    createdAt: string;
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
        createdAt: e.createdAt.toISOString(),
      })),
    };
  } catch {
    return null;
  }
}
