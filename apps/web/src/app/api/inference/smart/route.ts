import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getDb, objects } from '@archi-navi/db';
import {
  buildEmptyProofEngineSummary,
  createInferenceRun,
  executeInferenceRun,
  getInferenceRunDetail,
  normalizeSmartProofConfig,
  type SmartProofConfig,
} from '@archi-navi/inference';
import { createGenerateSmartResolutionFn, getInferenceModel } from '@/lib/inference-llm';

interface SmartRunRequest {
  workspaceId?: string;
  repoRoots?: string[];
  useServiceMetadataPaths?: boolean;
  async?: boolean;
  analysisMode?: string;
  enableAgentPatches?: boolean;
  maxAgentFrontiers?: number;
  forceRescan?: boolean;
  smartProof?: boolean | SmartProofConfig;
}

function dedupeNestedRepoRoots(repoRoots: string[]) {
  const normalizedRoots = repoRoots
    .map((repoRoot) => repoRoot.replace(/\\/g, '/').replace(/\/+$/, ''))
    .sort((a, b) => a.length - b.length);

  const deduped: string[] = [];
  for (const repoRoot of normalizedRoots) {
    const covered = deduped.some((ancestor) => repoRoot === ancestor || repoRoot.startsWith(`${ancestor}/`));
    if (!covered) {
      deduped.push(repoRoot);
    }
  }

  return deduped;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function collectSmartRepoRoots(
  workspaceId: string,
  body: SmartRunRequest,
) {
  const db = await getDb();

  const providedRoots = (body.repoRoots ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  const discoveredRoots: string[] = [];

  if (body.useServiceMetadataPaths !== false) {
    const services = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

    for (const svc of services) {
      const meta = (svc.metadata ?? {}) as Record<string, unknown>;
      const rawPath = meta['scanPath'];
      if (typeof rawPath === 'string' && rawPath.trim().length > 0) {
        discoveredRoots.push(rawPath.trim());
      }
    }
  }

  const validRoots = dedupeNestedRepoRoots([...new Set([...providedRoots, ...discoveredRoots])]
    .map((repoRoot) => {
      try {
        return resolve(repoRoot);
      } catch {
        return repoRoot;
      }
    })
    .filter((repoRoot) => {
      try {
        return existsSync(repoRoot) && statSync(repoRoot).isDirectory();
      } catch {
        return false;
      }
    }));

  return { db, validRoots };
}

function extractProofSummary(detail: Awaited<ReturnType<typeof getInferenceRunDetail>>) {
  const stats = asRecord(detail.run.stats);
  const proofSummary = asRecord(stats?.['proofSummary']);
  if (proofSummary) {
    return withRequestedSmartMode(proofSummary, stats?.['requestedSmartProof'] as boolean | SmartProofConfig | undefined);
  }
  return withRequestedSmartMode(buildEmptyProofEngineSummary() as Record<string, unknown>, stats?.['requestedSmartProof'] as boolean | SmartProofConfig | undefined);
}

function withRequestedSmartMode(
  summary: Record<string, unknown>,
  smartProof: boolean | SmartProofConfig | undefined,
) {
  const normalized = normalizeSmartProofConfig(smartProof ?? true);
  const smartMode = summary['smartMode'];
  const smartModeRecord = smartMode && typeof smartMode === 'object' && !Array.isArray(smartMode)
    ? smartMode as Record<string, unknown>
    : {};

  return {
    ...summary,
    smartMode: {
      ...buildEmptyProofEngineSummary().smartMode,
      ...smartModeRecord,
      enabled: normalized.enabled,
    },
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId')?.trim();
    const runId = url.searchParams.get('runId')?.trim();

    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
        { status: 400 },
      );
    }
    if (!runId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'runId is required' } },
        { status: 400 },
      );
    }

    const db = await getDb();
    const detail = await getInferenceRunDetail(db, { workspaceId, runId });
    const proofSummary = extractProofSummary(detail);

    return NextResponse.json({
      success: true,
      engine: 'intent_proof',
      summary: proofSummary,
      run: detail.run,
      sources: detail.sources,
      events: detail.events,
      data: {
        summary: proofSummary,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('찾을 수 없습니다')) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: error.message } },
        { status: 404 },
      );
    }

    console.error('[GET /api/inference/smart]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Smart 추론 실행 상태 조회 중 오류가 발생했습니다.',
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as SmartRunRequest;
    const workspaceId = body.workspaceId?.trim();
    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId is required' } },
        { status: 400 },
      );
    }

    if (typeof body.analysisMode === 'string' && body.analysisMode.trim().length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'analysisMode is no longer supported; Smart runs now always use the proof engine contract.',
          },
        },
        { status: 400 },
      );
    }

    const { db, validRoots } = await collectSmartRepoRoots(workspaceId, body);
    if (validRoots.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NO_REPO_ROOTS',
            message: 'Smart 추론을 실행할 유효한 로컬 경로가 없습니다.',
          },
        },
        { status: 400 },
      );
    }

    const run = await createInferenceRun(db, {
      workspaceId,
      triggerType: 'INTENT_PROOF_ENGINE',
      modes: ['config', 'code'],
      incremental: body.forceRescan === true ? false : true,
      smartProof: body.smartProof ?? true,
      ...(body.enableAgentPatches !== undefined
        ? { enableAgentPatches: body.enableAgentPatches === true }
        : {}),
      ...(typeof body.maxAgentFrontiers === 'number'
        ? { maxAgentFrontiers: body.maxAgentFrontiers }
        : {}),
      sources: validRoots.map((repoRoot) => ({ type: 'local', ref: repoRoot })),
    });
    const normalizedSmartProof = normalizeSmartProofConfig(body.smartProof ?? true);
    const modelInfo = normalizedSmartProof.enabled ? getInferenceModel(req) : null;
    const smartGenerateFn = modelInfo
      ? createGenerateSmartResolutionFn(modelInfo.model, modelInfo.modelName)
      : undefined;

    if (body.async === true) {
      queueMicrotask(() => {
        void executeInferenceRun(db, {
          workspaceId,
          runId: run.id,
          ...(smartGenerateFn ? { smartGenerateFn } : {}),
        }).catch((error) => {
          console.error('[POST /api/inference/smart] async execute failed', error);
        });
      });

      const detail = await getInferenceRunDetail(db, { workspaceId, runId: run.id });
      const proofSummary = withRequestedSmartMode(extractProofSummary(detail) as Record<string, unknown>, body.smartProof);
      return NextResponse.json(
        {
          success: true,
          engine: 'intent_proof',
          queued: true,
          runId: run.id,
          summary: proofSummary,
          run: detail.run,
          sources: detail.sources,
        },
        { status: 202 },
      );
    }

    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      ...(smartGenerateFn ? { smartGenerateFn } : {}),
    });
    const proofSummary = withRequestedSmartMode(extractProofSummary(detail) as Record<string, unknown>, body.smartProof);

    return NextResponse.json({
      success: true,
      engine: 'intent_proof',
      summary: proofSummary,
      runId: run.id,
      run: detail.run,
      sources: detail.sources,
      events: detail.events,
      data: {
        summary: proofSummary,
        repoRoots: validRoots,
      },
    });
  } catch (error) {
    console.error('[POST /api/inference/smart]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Smart 추론 처리 중 오류가 발생했습니다.',
        },
      },
      { status: 500 },
    );
  }
}
