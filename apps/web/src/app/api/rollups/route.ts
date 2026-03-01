/**
 * GET /api/rollups — Roll-up 그래프 데이터 조회 (React Flow용 변환)
 * POST /api/rollups — Roll-up 재빌드 실행
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import { objectRollups, objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { getActiveGeneration, rebuildRollups } from '@archi-navi/core';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    const level = searchParams.get('level') ?? 'SERVICE_TO_SERVICE';

    const db = await getDb();

    // 활성 Generation 번호 조회 (number | null)
    const genVersion = await getActiveGeneration(db, workspaceId);
    if (!genVersion) {
      return NextResponse.json({ nodes: [], edges: [] });
    }

    // 롤업 엣지 조회
    const rollupEdges = await db
      .select()
      .from(objectRollups)
      .where(
        and(
          eq(objectRollups.workspaceId, workspaceId),
          eq(objectRollups.generationVersion, genVersion),
          eq(objectRollups.rollupLevel, level),
        ),
      );

    if (rollupEdges.length === 0) {
      return NextResponse.json({ nodes: [], edges: [] });
    }

    // 관련 Object ID 수집
    const objectIds = new Set<string>();
    for (const edge of rollupEdges) {
      objectIds.add(edge.subjectObjectId);
      objectIds.add(edge.objectId);
    }

    // Object 이름 조회
    const allObjects = await db
      .select({
        id: objects.id,
        name: objects.name,
        displayName: objects.displayName,
        objectType: objects.objectType,
      })
      .from(objects)
      .where(eq(objects.workspaceId, workspaceId));

    type ObjInfo = { name: string; displayName: string | null; objectType: string };
    const objectMap = new Map<string, ObjInfo>(
      allObjects.map((o: { id: string; name: string; displayName: string | null; objectType: string }) => [
        o.id,
        { name: o.name, displayName: o.displayName, objectType: o.objectType },
      ]),
    );

    // React Flow 형식으로 변환
    const nodes = [...objectIds].map((id) => {
      const obj = objectMap.get(id);
      return {
        id,
        label: obj?.displayName ?? obj?.name ?? id,
        objectType: obj?.objectType ?? 'unknown',
      };
    });

    const edges = rollupEdges.map((e: typeof rollupEdges[0]) => ({
      id: e.id,
      source: e.subjectObjectId,
      target: e.objectId,
      relationType: e.relationType,
      rollupLevel: e.rollupLevel,
      label: level.split('_TO_')[0]?.toLowerCase() ?? 'edge',
      weight: e.edgeWeight,
      confidence: e.confidence,
    }));

    return NextResponse.json({ nodes, edges });
  } catch (error) {
    console.error('[GET /api/rollups]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { workspaceId?: string };
    const workspaceId = body.workspaceId;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const generationVersion = await rebuildRollups(db, workspaceId);

    return NextResponse.json({
      ok: true,
      workspaceId,
      generationVersion,
    });
  } catch (error) {
    console.error('[POST /api/rollups]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
