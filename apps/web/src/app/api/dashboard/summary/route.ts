import { type NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import {
  getDb,
  objects,
  relationCandidates,
} from '@archi-navi/db';
import { listInferenceRuns } from '@archi-navi/inference';

function asCount(rows: Array<{ count: number | string | bigint | null }>): number {
  const value = rows[0]?.count;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId')?.trim();

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const [
      objectCountRows,
      serviceCountRows,
      domainCountRows,
      relationPendingRows,
      recentRuns,
    ] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(objects)
        .where(eq(objects.workspaceId, workspaceId)),
      db
        .select({ count: sql<number>`count(*)` })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service'))),
      db
        .select({ count: sql<number>`count(*)` })
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'domain'))),
      db
        .select({ count: sql<number>`count(*)` })
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.status, 'PENDING'),
          ),
        ),
      listInferenceRuns(db, { workspaceId, limit: 5 }),
    ]);

    return NextResponse.json({
      counts: {
        objects: asCount(objectCountRows),
        services: asCount(serviceCountRows),
        domains: asCount(domainCountRows),
        pendingRelations: asCount(relationPendingRows),
      },
      recentRuns: recentRuns.map((run) => ({
        id: run.id,
        status: run.status,
        triggerType: run.triggerType,
        requestedModes: Array.isArray(run.requestedModes) ? run.requestedModes : [],
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        errorMessage: run.errorMessage,
        sourceSummary: run.sourceSummary,
      })),
    });
  } catch (error) {
    console.error('[GET /api/dashboard/summary]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
