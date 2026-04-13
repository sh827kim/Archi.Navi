import { type NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, objects } from '@archi-navi/db';
import {
  buildEmptyProofEngineSummary,
  createInferenceRun,
  executeInferenceRun,
  normalizeSmartProofConfig,
  normalizeInferenceRunModes,
  type InferenceSourceType,
  type SmartProofConfig,
} from '@archi-navi/inference';
import { createGenerateSmartResolutionFn, getInferenceModel } from '@/lib/inference-llm';

interface RunInferenceRequest {
  workspaceId?: string;
  modes?: string[];
  transports?: string[];
  repoRoots?: string[];
  sources?: Array<{ type?: string; path?: string; ref?: string; metadata?: Record<string, unknown> }>;
  useServiceMetadataPaths?: boolean;
  incremental?: boolean;
  forceRescan?: boolean;
  codeEngine?: string;
  compatDeterministicCandidates?: boolean;
  enableAgentPatches?: boolean;
  maxAgentFrontiers?: number;
  smartProof?: boolean | SmartProofConfig;
  llmBoost?: {
    enabled?: boolean;
    codeIntentAnalysis?: boolean;
    generateExplanations?: boolean;
    maxCalls?: number;
  };
}

function withRequestedSmartMode(
  summary: Record<string, unknown>,
  smartProof: boolean | SmartProofConfig | undefined,
) {
  const normalized = normalizeSmartProofConfig(smartProof);
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

function isSourceType(value: string): value is InferenceSourceType {
  return value === 'local' || value === 'githubRepo' || value === 'githubOrg';
}

function normalizeLocalSources(
  sources: Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>,
): Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }> {
  const localSources = sources
    .filter((source) => source.type === 'local')
    .map((source) => ({
      ...source,
      normalizedRef: source.ref.replace(/\\/g, '/').replace(/\/+$/, ''),
    }))
    .sort((a, b) => a.normalizedRef.length - b.normalizedRef.length);

  const keptLocalSources: Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }> = [];
  const keptNormalizedRefs: string[] = [];

  for (const source of localSources) {
    const isCovered = keptNormalizedRefs.some(
      (keptRef) => source.normalizedRef === keptRef || source.normalizedRef.startsWith(`${keptRef}/`),
    );
    if (isCovered) continue;
    keptLocalSources.push({
      type: source.type,
      ref: source.ref,
      ...(source.metadata ? { metadata: source.metadata } : {}),
    });
    keptNormalizedRefs.push(source.normalizedRef);
  }

  const nonLocalSources = sources.filter((source) => source.type !== 'local');
  return [...keptLocalSources, ...nonLocalSources];
}

function normalizeRunModes(body: RunInferenceRequest) {
  if (Array.isArray(body.modes) && body.modes.length > 0) {
    return normalizeInferenceRunModes(body.modes);
  }

  const transportModes = new Set<string>();
  for (const transport of body.transports ?? []) {
    const normalized = transport.trim().toLowerCase();
    if (normalized === 'db') {
      transportModes.add('db');
      continue;
    }
    if (normalized === 'http' || normalized === 'message') {
      transportModes.add('config');
      transportModes.add('code');
    }
  }

  return normalizeInferenceRunModes(Array.from(transportModes));
}

async function collectSources(
  workspaceId: string,
  body: RunInferenceRequest,
): Promise<Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>> {
  const sourceMap = new Map<string, { type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>();

  for (const source of body.sources ?? []) {
    const sourceRef = source?.ref ?? source?.path;
    if (!source?.type || !sourceRef) continue;
    if (!isSourceType(source.type)) continue;
    const ref = sourceRef.trim();
    if (ref.length === 0) continue;
    sourceMap.set(`${source.type}:${ref}`, {
      type: source.type,
      ref,
      ...(source.metadata ? { metadata: source.metadata } : {}),
    });
  }

  for (const repoRoot of body.repoRoots ?? []) {
    const ref = repoRoot.trim();
    if (ref.length === 0) continue;
    sourceMap.set(`local:${ref}`, { type: 'local', ref });
  }

  if (body.useServiceMetadataPaths !== false) {
    const db = await getDb();
    const services = await db
      .select({ metadata: objects.metadata })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'service'),
        ),
      );

    for (const service of services) {
      const metadata = (service.metadata ?? {}) as Record<string, unknown>;
      const scanPath = typeof metadata['scanPath'] === 'string' ? metadata['scanPath'].trim() : '';
      if (scanPath.length === 0) continue;
      sourceMap.set(`local:${scanPath}`, { type: 'local', ref: scanPath });
    }
  }

  return normalizeLocalSources(Array.from(sourceMap.values()));
}

function buildLlmBoostResult(body: RunInferenceRequest) {
  const enabled = body.llmBoost?.enabled === true;
  const codeIntentAnalysisEnabled = body.llmBoost?.codeIntentAnalysis !== false;

  return {
    request: {
      enabled,
      codeIntentAnalysis: codeIntentAnalysisEnabled,
      generateExplanations: body.llmBoost?.generateExplanations === true,
      requestedMaxCalls: typeof body.llmBoost?.maxCalls === 'number' ? body.llmBoost.maxCalls : null,
    },
    modelConfigured: false,
    effectiveMaxCalls: 0,
    skippedReason: enabled ? 'DISABLED_IN_PROOF_ENGINE' : 'DISABLED',
    codeIntentAnalysis: {
      scannedCount: 0,
      generatedCount: 0,
      skippedCount: 0,
      callCount: 0,
      errorCount: 0,
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as RunInferenceRequest;
    const workspaceId = body.workspaceId?.trim();
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const modes = normalizeRunModes(body);
    const sources = await collectSources(workspaceId, body);
    const requiresRunnableSource = modes.includes('config') || modes.includes('code');
    const hasRunnableSource = sources.some(
      (source) => source.type === 'local' || source.type === 'githubRepo' || source.type === 'githubOrg',
    );

    if (requiresRunnableSource && !hasRunnableSource) {
      return NextResponse.json(
        {
          error: 'config/code 실행에는 최소 1개의 source(local/githubRepo/githubOrg)가 필요합니다.',
          details: { modes, sourceCount: sources.length },
        },
        { status: 400 },
      );
    }

    const normalizedSmartProof = normalizeSmartProofConfig(body.smartProof);
    const modelInfo = normalizedSmartProof.enabled ? getInferenceModel(req) : null;
    if (normalizedSmartProof.enabled && !modelInfo) {
      return NextResponse.json(
        {
          error: 'smartProof가 활성화되었지만 사용할 LLM 모델이 설정되지 않았습니다.',
        },
        { status: 400 },
      );
    }

    const db = await getDb();
    const run = await createInferenceRun(db, {
      workspaceId,
      modes,
      ...(body.codeEngine != null ? { codeEngine: body.codeEngine } : {}),
      ...(body.compatDeterministicCandidates !== undefined
        ? { compatDeterministicCandidates: body.compatDeterministicCandidates === true }
        : {}),
      incremental: body.forceRescan === true ? false : body.incremental !== false,
      triggerType: 'INTENT_PROOF_ENGINE',
      ...(body.smartProof !== undefined ? { smartProof: body.smartProof } : {}),
      ...(body.enableAgentPatches !== undefined
        ? { enableAgentPatches: body.enableAgentPatches === true }
        : {}),
      ...(typeof body.maxAgentFrontiers === 'number'
        ? { maxAgentFrontiers: body.maxAgentFrontiers }
        : {}),
      sources,
    });
    const smartGenerateFn = modelInfo
      ? createGenerateSmartResolutionFn(modelInfo.model, modelInfo.modelName)
      : undefined;
    const detail = await executeInferenceRun(db, {
      workspaceId,
      runId: run.id,
      ...(smartGenerateFn ? { smartGenerateFn } : {}),
    });
    const runStats = (detail.run.stats ?? {}) as Record<string, unknown>;
    const rawProofSummary = (runStats['proofSummary'] ?? buildEmptyProofEngineSummary()) as unknown as Record<string, unknown>;
    const proofSummary = withRequestedSmartMode(rawProofSummary, body.smartProof);
    const frontierAgent = (runStats['frontierAgent'] ?? null) as Record<string, unknown> | null;
    const requestedAgentPatches = (runStats['requestedAgentPatches'] ?? {
      enabled: body.enableAgentPatches === true,
      maxFrontiers: typeof body.maxAgentFrontiers === 'number' ? body.maxAgentFrontiers : null,
    }) as Record<string, unknown>;
    const llmBoost = buildLlmBoostResult(body);

    return NextResponse.json({
      ok: detail.run.status !== 'FAILED',
      engine: proofSummary['engine'] ?? 'intent_proof',
      runId: detail.run.id,
      run: detail.run,
      sources: detail.sources,
      events: detail.events,
      summary: proofSummary,
      results: {
        config: runStats['config'] ?? null,
        code: runStats['code'] ?? null,
        db: runStats['db'] ?? null,
        bootstrap: runStats['bootstrap'] ?? null,
        proofResolution: runStats['proofResolution'] ?? null,
        summary: runStats['summary'] ?? null,
        frontierAgent,
        requestedAgentPatches,
        requestedSmartProof: normalizeSmartProofConfig(body.smartProof),
      },
      warnings: detail.run.warnings,
      errors: detail.run.errors,
      llmBoost,
    });
  } catch (error) {
    console.error('[POST /api/inference/run]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
