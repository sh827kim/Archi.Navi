import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import {
  getInferenceRunDetail,
  cancelInferenceRun,
  retryInferenceRun,
  executeInferenceRun,
} from '@archi-navi/inference';

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

/**
 * PATCH /api/inference/runs/:id — cancel 또는 retry
 * body: { action: 'cancel' | 'retry', workspaceId: string }
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const runId = id?.trim();
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      workspaceId?: string;
    };
    const workspaceId = body.workspaceId?.trim();

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!runId) {
      return NextResponse.json({ error: 'run id is required' }, { status: 400 });
    }

    const action = body.action?.trim();
    if (action !== 'cancel' && action !== 'retry') {
      return NextResponse.json(
        { error: 'action must be "cancel" or "retry"' },
        { status: 400 },
      );
    }

    const db = await getDb();

    if (action === 'cancel') {
      const result = await cancelInferenceRun(db, { workspaceId, runId });
      return NextResponse.json({ ok: true, ...result });
    }

    // retry
    const result = await retryInferenceRun(db, { workspaceId, runId });
    if (result.retried) {
      // 재시도 예약 성공 → 백그라운드 실행
      queueMicrotask(() => {
        void executeInferenceRun(db, { workspaceId, runId }).catch((error) => {
          console.error('[PATCH /api/inference/runs/:id] retry executeInferenceRun failed', error);
        });
      });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message.includes('찾을 수 없습니다')) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('[PATCH /api/inference/runs/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
