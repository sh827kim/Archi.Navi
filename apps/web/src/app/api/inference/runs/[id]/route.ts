import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { getInferenceRunDetail } from '@archi-navi/inference';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
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
