import { type NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, objects } from '@archi-navi/db';
import {
  createInferenceRun,
  executeInferenceRun,
  listInferenceRuns,
  normalizeInferenceRunModes,
  type InferenceSourceType,
} from '@archi-navi/inference';

interface InferenceRunRequestBody {
  workspaceId?: string;
  modes?: string[];
  codeEngine?: string;
  incremental?: boolean;
  triggerType?: string;
  maxAttempts?: number;
  idempotencyKey?: string;
  repoRoots?: string[];
  githubRepo?: string;
  githubOrg?: string;
  sources?: Array<{ type?: string; ref?: string; metadata?: Record<string, unknown> }>;
  useServiceMetadataPaths?: boolean;
}

function authorizeInferenceRunsRequest(req: NextRequest): NextResponse | null {
  const expectedToken = process.env['INFERENCE_RUNS_API_TOKEN']?.trim();
  if (!expectedToken) {
    console.error('[inference/runs] INFERENCE_RUNS_API_TOKEN is not configured');
    return NextResponse.json({ error: 'Inference run API is not configured' }, { status: 503 });
  }

  const authorization = req.headers.get('authorization');
  const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
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

async function collectSources(
  workspaceId: string,
  body: InferenceRunRequestBody,
): Promise<Array<{ type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>> {
  const sourceMap = new Map<string, { type: InferenceSourceType; ref: string; metadata?: Record<string, unknown> }>();

  const fromBody = body.sources ?? [];
  for (const source of fromBody) {
    if (!source?.type || !source?.ref) continue;
    if (!isSourceType(source.type)) continue;
    const ref = source.ref.trim();
    if (ref.length === 0) continue;
    sourceMap.set(`${source.type}:${ref}`, {
      type: source.type,
      ref,
      metadata: source.metadata,
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
    }
  }

  return Array.from(sourceMap.values());
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

    const modes = normalizeInferenceRunModes(body.modes);
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

    const db = await getDb();
    const run = await createInferenceRun(db, {
      workspaceId,
      modes,
      codeEngine: body.codeEngine,
      incremental: body.incremental,
      triggerType: body.triggerType,
      maxAttempts: body.maxAttempts,
      idempotencyKey: body.idempotencyKey,
      sources,
    });

    queueMicrotask(() => {
      void executeInferenceRun(db, { workspaceId, runId: run.id }).catch((error) => {
        console.error('[POST /api/inference/runs] executeInferenceRun failed', error);
      });
    });

    return NextResponse.json(
      {
        ok: true,
        runId: run.id,
        status: run.status,
        requestedModes: run.requestedModes,
        sourceSummary: run.sourceSummary,
      },
      { status: 202 },
    );
  } catch (error) {
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
    const items = await listInferenceRuns(db, { workspaceId, status: status ?? undefined, limit });
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    console.error('[GET /api/inference/runs]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
