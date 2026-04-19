import { type NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, objects } from '@archi-navi/db';
import {
  buildEmptyProofEngineSummary,
  createInferenceRun,
  executeInferenceRun,
  listInferenceRuns,
  normalizeSmartProofConfig,
  normalizeInferenceRunModes,
  type InferenceSourceType,
  type SmartProofConfig,
} from '@archi-navi/inference';
import {
  buildInferencePipelineMeta,
  decoratePipelineSummary,
  isInferencePipelineValidationError,
} from '@/lib/inference-pipeline';

interface InferenceRunRequestBody {
  workspaceId?: string;
  modes?: string[];
  transports?: string[];
  pipeline?: string;
  pipelineVersion?: string;
  codeEngine?: string;
  incremental?: boolean;
  forceRescan?: boolean;
  triggerType?: string;
  maxAttempts?: number;
  idempotencyKey?: string;
  repoRoots?: string[];
  githubRepo?: string;
  githubOrg?: string;
  sources?: Array<{ type?: string; path?: string; ref?: string; metadata?: Record<string, unknown> }>;
  useServiceMetadataPaths?: boolean;
  enableAgentPatches?: boolean;
  maxAgentFrontiers?: number;
  smartProof?: boolean | SmartProofConfig;
  compatDeterministicCandidates?: boolean;
}

function authorizeInferenceRunsRequest(req: NextRequest): NextResponse | null {
  const expectedToken = process.env['INFERENCE_RUNS_API_TOKEN']?.trim();
  if (!expectedToken) {
    console.error('[inference/runs] INFERENCE_RUNS_API_TOKEN is not configured');
    return NextResponse.json({ error: 'Inference run API is not configured' }, { status: 503 });
  }

  const authorization = req.headers.get('authorization');
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = bearerMatch?.[1]?.trim() ?? null;
  const headerToken = req.headers.get('x-inference-runs-token')?.trim();
  const providedToken = bearerToken ?? headerToken;

  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

function isSourceType(value: string): value is InferenceSourceType {
  return value === 'local' || value === 'githubRepo' || value === 'githubOrg';
}

function normalizeLocalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isStrictAncestorPath(ancestor: string, child: string): boolean {
  if (ancestor.length === 0 || child.length === 0) return false;
  if (ancestor === child) return false;
  return child.startsWith(`${ancestor}/`);
}

function normalizeLocalSources(
  sources: Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>,
  serviceScanPaths: string[] = [],
): Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }> {
  const servicePathSet = new Set(serviceScanPaths.map(normalizeLocalPath));
  const localSources = sources
    .filter((source) => source.type === 'local')
    .map((source) => ({
      ...source,
      normalizedRef: normalizeLocalPath(source.ref),
    }))
    .filter((source) =>
      servicePathSet.has(source.normalizedRef)
      || !serviceScanPaths.some((scanPath) => isStrictAncestorPath(source.normalizedRef, normalizeLocalPath(scanPath))),
    )
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

async function collectSources(
  workspaceId: string,
  body: InferenceRunRequestBody,
): Promise<Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>> {
  const sourceMap = new Map<string, { type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>();
  const serviceScanPaths: string[] = [];

  const fromBody = body.sources ?? [];
  for (const source of fromBody) {
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

  if (typeof body.githubRepo === 'string' && body.githubRepo.trim().length > 0) {
    const ref = body.githubRepo.trim();
    sourceMap.set(`githubRepo:${ref}`, { type: 'githubRepo', ref });
  }
  if (typeof body.githubOrg === 'string' && body.githubOrg.trim().length > 0) {
    const ref = body.githubOrg.trim();
    sourceMap.set(`githubOrg:${ref}`, { type: 'githubOrg', ref });
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
      serviceScanPaths.push(scanPath);
    }
  }

  return normalizeLocalSources(Array.from(sourceMap.values()), serviceScanPaths);
}

function normalizeRunModes(body: InferenceRunRequestBody) {
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

export async function POST(req: NextRequest) {
  try {
    const authError = authorizeInferenceRunsRequest(req);
    if (authError) return authError;

    const body = (await req.json().catch(() => ({}))) as InferenceRunRequestBody;
    const workspaceId = body.workspaceId?.trim();
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const modes = normalizeRunModes(body);
    const sources = await collectSources(workspaceId, body);
    const pipeline = buildInferencePipelineMeta(body.pipeline, body.compatDeterministicCandidates);

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

    const db = await getDb();
    const runInput = {
      workspaceId,
      modes,
      ...(body.codeEngine != null ? { codeEngine: body.codeEngine } : {}),
      incremental: body.forceRescan === true ? false : body.incremental !== false,
      triggerType: body.triggerType ?? 'INTENT_PROOF_ENGINE',
      ...(body.smartProof !== undefined ? { smartProof: body.smartProof } : {}),
      ...(body.maxAttempts != null ? { maxAttempts: body.maxAttempts } : {}),
      ...(body.idempotencyKey != null ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.enableAgentPatches !== undefined
        ? { enableAgentPatches: body.enableAgentPatches === true }
        : {}),
      ...(typeof body.maxAgentFrontiers === 'number'
        ? { maxAgentFrontiers: body.maxAgentFrontiers }
        : {}),
      sources,
      pipeline: pipeline.name,
      pipelineVersion: pipeline.version,
    } as Parameters<typeof createInferenceRun>[1] & {
      pipeline?: string;
      pipelineVersion?: string;
    };
    const run = await createInferenceRun(db, runInput);

    queueMicrotask(() => {
      void executeInferenceRun(db, { workspaceId, runId: run.id })
        .catch((error) => {
          console.error('[POST /api/inference/runs] executeInferenceRun failed', error);
        });
    });

    const requestedSmartProof = normalizeSmartProofConfig(body.smartProof);
    const proofSummary = decoratePipelineSummary(
      {
        ...buildEmptyProofEngineSummary(),
        smartMode: {
          ...buildEmptyProofEngineSummary().smartMode,
          enabled: requestedSmartProof.enabled,
        },
      },
      pipeline,
    );
    const requestedAgentPatches = {
      enabled: body.enableAgentPatches === true,
      maxFrontiers: typeof body.maxAgentFrontiers === 'number' ? body.maxAgentFrontiers : null,
    };
    const frontierAgent = {
      attemptedFrontierCount: 0,
      proposedPatchCount: 0,
      appliedPatchCount: 0,
      rejectedPatchCount: 0,
      skippedReason: requestedAgentPatches.enabled ? 'PENDING_RUN' : 'DISABLED',
    };

    return NextResponse.json(
      {
        ok: true,
        engine: proofSummary.engine,
        pipeline: pipeline.name,
        pipelineVersion: pipeline.version,
        requestedPipeline: {
          name: pipeline.name,
          version: pipeline.version,
        },
        effectivePipeline: {
          name: pipeline.name,
          version: pipeline.version,
        },
        runId: run.id,
        status: run.status,
        requestedModes: run.requestedModes,
        sourceSummary: run.sourceSummary,
        summary: proofSummary,
        results: {
          config: null,
          code: null,
          db: null,
          proofResolution: null,
          frontierAgent,
          requestedAgentPatches,
          requestedSmartProof,
          requestedPipeline: {
            name: pipeline.name,
            version: pipeline.version,
          },
          effectivePipeline: {
            name: pipeline.name,
            version: pipeline.version,
          },
        },
      },
      { status: 202 },
    );
  } catch (error) {
    if (isInferencePipelineValidationError(error)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[POST /api/inference/runs]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const authError = authorizeInferenceRunsRequest(req);
    if (authError) return authError;

    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId')?.trim();
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const status = url.searchParams.get('status')?.trim();
    const rawLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;

    const db = await getDb();
    const items = await listInferenceRuns(db, { workspaceId, ...(status ? { status } : {}), limit });
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    console.error('[GET /api/inference/runs]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
