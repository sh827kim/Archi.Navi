import { type NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, objects } from '@archi-navi/db';
import { buildUrn } from '@archi-navi/shared';

interface ReassignDbTablesRequest {
  workspaceId?: string;
  targetDatabaseId?: string;
  tableIds?: string[];
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as ReassignDbTablesRequest;
    const workspaceId = body.workspaceId;
    const targetDatabaseId = body.targetDatabaseId;
    const tableIds = Array.from(
      new Set((body.tableIds ?? []).filter((id) => typeof id === 'string' && id.length > 0)),
    );

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }
    if (!targetDatabaseId) {
      return NextResponse.json({ error: 'targetDatabaseId is required' }, { status: 400 });
    }
    if (tableIds.length === 0) {
      return NextResponse.json({ error: 'tableIds is required' }, { status: 400 });
    }

    const db = await getDb();
    const [targetDatabase] = await db
      .select({
        id: objects.id,
        urn: objects.urn,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.id, targetDatabaseId),
          eq(objects.objectType, 'database'),
        ),
      )
      .limit(1);

    if (!targetDatabase) {
      return NextResponse.json({ error: '대상 database를 찾을 수 없습니다.' }, { status: 404 });
    }

    const tables = await db
      .select({
        id: objects.id,
        name: objects.name,
        parentId: objects.parentId,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'db_table'),
          inArray(objects.id, tableIds),
        ),
      );

    if (tables.length === 0) {
      return NextResponse.json({ error: '이동할 db_table을 찾을 수 없습니다.' }, { status: 404 });
    }

    const targetParentTables = await db
      .select({ name: objects.name })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'db_table'),
          eq(objects.parentId, targetDatabaseId),
        ),
      );
    const existingTableNames = new Set(targetParentTables.map((row) => row.name.toLowerCase()));

    let movedCount = 0;
    const skippedTableIds: string[] = [];
    const targetDatabaseUrn =
      targetDatabase.urn && targetDatabase.urn.length > 0
        ? targetDatabase.urn
        : `database:${targetDatabase.id}`;

    for (const table of tables) {
      if (table.parentId === targetDatabaseId) {
        skippedTableIds.push(table.id);
        continue;
      }
      if (existingTableNames.has(table.name.toLowerCase())) {
        skippedTableIds.push(table.id);
        continue;
      }

      const nextUrn = buildUrn(workspaceId, 'storage', 'db_table', `${targetDatabaseUrn}:${table.name}`);
      await db
        .update(objects)
        .set({
          parentId: targetDatabaseId,
          urn: nextUrn,
          depth: 1,
        })
        .where(eq(objects.id, table.id));

      existingTableNames.add(table.name.toLowerCase());
      movedCount += 1;
    }

    return NextResponse.json({
      ok: true,
      requestedCount: tableIds.length,
      matchedCount: tables.length,
      movedCount,
      skippedTableIds,
    });
  } catch (error) {
    console.error('[PATCH /api/objects/db-tables/reassign]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
