/**
 * PATCH /api/inference/domain-candidates/:id — 도메인 후보 승인/거부
 * 승인 시 → object_domain_affinities에 확정 소속 upsert
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { approveDomainCandidate } from '@archi-navi/inference';

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

    const result = await approveDomainCandidate(db, id, body.status);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'candidate not found') {
      return NextResponse.json({ error: '도메인 후보를 찾을 수 없습니다' }, { status: 404 });
    }
    console.error('[PATCH /api/inference/domain-candidates/:id]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
