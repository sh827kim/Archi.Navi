import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { getInferenceRunDetail } from '@archi-navi/inference';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function authorizeInferenceRunsRequest(req: NextRequest): NextResponse | null {
  const expectedToken = process.env['INFERENCE_RUNS_API_TOKEN']?.trim();
  if (!expectedToken) {
    console.error('[inference/runs/:id] INFERENCE_RUNS_API_TOKEN is not configured');
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

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const authError = authorizeInferenceRunsRequest(req);
    if (authError) return authError;

    const { id } = await context.params;
    const runId = id?.trim();
    const workspaceId = new URL(req.url).searchParams.get('workspaceId')?.trim();

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!runId) {
      return NextResponse.json({ error: 'run id is required' }, { status: 400 });
    }

    const db = await getDb();
    const detail = await getInferenceRunDetail(db, { workspaceId, runId });
    return NextResponse.json({ ok: true, ...detail });
  } catch (error) {
    if (error instanceof Error && error.message.includes('찾을 수 없습니다')) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('[GET /api/inference/runs/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
