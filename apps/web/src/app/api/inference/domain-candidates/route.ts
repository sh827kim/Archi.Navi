/**
 * GET /api/inference/domain-candidates — 도메인 후보 목록 조회
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { domainCandidates, objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';

interface DomainFeedbackMetadata {
  key: string;
  track: 'TRACK_A';
  primaryDomainId: string;
  purityBucket: 'LOW' | 'MEDIUM' | 'HIGH';
  basePurity: number;
  adjustment: number;
  adjustedPurity: number;
  applied: boolean;
  sampleCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asDomainFeedbackMetadata(value: unknown): DomainFeedbackMetadata | null {
  const record = asRecord(value);
  if (!record) return null;

  const key = typeof record['key'] === 'string' ? record['key'] : null;
  const track = record['track'] === 'TRACK_A' ? 'TRACK_A' : null;
  const primaryDomainId = typeof record['primaryDomainId'] === 'string'
    ? record['primaryDomainId']
    : null;
  const purityBucket = record['purityBucket'];
  if (
    !key
    || !track
    || !primaryDomainId
    || (purityBucket !== 'LOW' && purityBucket !== 'MEDIUM' && purityBucket !== 'HIGH')
  ) {
    return null;
  }

  return {
    key,
    track,
    primaryDomainId,
    purityBucket,
    basePurity: isFiniteNumber(record['basePurity']) ? record['basePurity'] : 0,
    adjustment: isFiniteNumber(record['adjustment']) ? record['adjustment'] : 0,
    adjustedPurity: isFiniteNumber(record['adjustedPurity']) ? record['adjustedPurity'] : 0,
    applied: typeof record['applied'] === 'boolean' ? record['applied'] : false,
    sampleCount: isFiniteNumber(record['sampleCount'])
      ? Math.max(0, Math.round(record['sampleCount']))
      : 0,
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const status = searchParams.get('status') ?? 'PENDING';

    const db = await getDb();

    // 도메인 후보 조회
    const candidates = await db
      .select()
      .from(domainCandidates)
      .where(
        and(
          eq(domainCandidates.workspaceId, workspaceId),
          eq(domainCandidates.status, status as 'PENDING' | 'APPROVED' | 'REJECTED'),
        ),
      )
      .limit(100);

    // Object 이름 맵 (service + domain)
    const allObjects = await db
      .select({ id: objects.id, displayName: objects.displayName, name: objects.name })
      .from(objects)
      .where(eq(objects.workspaceId, workspaceId));
    const objMap = new Map(
      allObjects.map((o: { id: string; displayName: string | null; name: string }) => [
        o.id,
        o.displayName ?? o.name,
      ]),
    );

    // 응답 변환
    const result = candidates.map((c: typeof candidates[0]) => {
      const signals = asRecord(c.signals);
      return {
        id: c.id,
        objectId: c.objectId,
        objectName: objMap.get(c.objectId) ?? c.objectId,
        primaryDomainId: c.primaryDomainId ?? null,
        primaryDomainName: c.primaryDomainId ? (objMap.get(c.primaryDomainId) ?? c.primaryDomainId) : null,
        purity: c.purity,
        affinityMap: c.affinityMap as Record<string, number>,
        signals: c.signals,
        domainFeedback: asDomainFeedbackMetadata(signals?.feedback),
        status: c.status,
        createdAt: c.createdAt,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/inference/domain-candidates]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
