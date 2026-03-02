/**
 * PATCH /api/inference/domain-candidates/:id — 도메인 후보 승인/거부
 * 승인 시 → object_domain_affinities에 확정 소속 upsert
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb, domainCandidates } from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { approveDomainCandidate } from '@archi-navi/inference';
import { applyRollupChanges, createDomainAffinityChangedEvent } from '@/lib/rollup-change-events';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { status: 'APPROVED' | 'REJECTED' };

    if (!['APPROVED', 'REJECTED'].includes(body.status)) {
      return NextResponse.json(
        { error: 'status는 APPROVED 또는 REJECTED 이어야 합니다' },
        { status: 400 },
      );
    }

    const db = await getDb();
    const [candidate] = await db
      .select({
        workspaceId: domainCandidates.workspaceId,
        objectId: domainCandidates.objectId,
        primaryDomainId: domainCandidates.primaryDomainId,
        affinityMap: domainCandidates.affinityMap,
      })
      .from(domainCandidates)
      .where(eq(domainCandidates.id, id))
      .limit(1);

    if (!candidate) {
      return NextResponse.json({ error: '도메인 후보를 찾을 수 없습니다' }, { status: 404 });
    }

    const result = await approveDomainCandidate(db, id, body.status);

    if (body.status === 'APPROVED') {
      const affinityMap = (candidate.affinityMap ?? {}) as Record<string, number>;
      const fallbackDomainId = Object.keys(affinityMap)[0] ?? 'unknown-domain';
      const domainId = candidate.primaryDomainId ?? fallbackDomainId;

      await applyRollupChanges(db, candidate.workspaceId, [
        createDomainAffinityChangedEvent(candidate.objectId, domainId),
      ]);
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'candidate not found') {
      return NextResponse.json({ error: '도메인 후보를 찾을 수 없습니다' }, { status: 404 });
    }
    console.error('[PATCH /api/inference/domain-candidates/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
