import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import {
  DbTableMergeError,
  mergeImplicitSchemaDbTableCandidate,
} from '@archi-navi/inference';
import {
  applyRollupChanges,
  createDomainAffinityChangedEvent,
} from '@/lib/rollup-change-events';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = asRecord(await req.json());
    const workspaceId = asNonEmptyString(body?.workspaceId);
    const candidateId = asNonEmptyString(body?.candidateId);

    if (!workspaceId || !candidateId) {
      return NextResponse.json(
        { error: 'workspaceId와 candidateId가 필요합니다' },
        { status: 400 },
      );
    }

    const db = await getDb();
    const result = await mergeImplicitSchemaDbTableCandidate(db, { workspaceId, candidateId });
    const rollupEvents = result.affectedDomainIds.flatMap((domainId) => [
      createDomainAffinityChangedEvent(result.sourceObjectId, domainId),
      createDomainAffinityChangedEvent(result.targetObjectId, domainId),
    ]);

    let warning: string | undefined;
    try {
      await applyRollupChanges(db, workspaceId, rollupEvents);
    } catch (error) {
      warning = 'ROLLUP_REFRESH_FAILED';
      console.warn('[POST /api/db-tables/merge-candidate] rollup refresh failed', error);
    }

    return NextResponse.json({
      ...result,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    if (error instanceof DbTableMergeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error('[POST /api/db-tables/merge-candidate]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
