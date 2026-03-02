import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@archi-navi/db';
import {
  queryContributors,
  type ContributorGroupBy,
  type ContributorScopeMode,
} from '@archi-navi/core';

function parseGroupBy(value: string | null): ContributorGroupBy {
  if (value === 'sourceAtomic') return 'sourceAtomic';
  if (value === 'targetAtomic') return 'targetAtomic';
  if (value === 'relationType') return 'relationType';
  return 'targetCompound';
}

function parseScopeMode(value: string | null): ContributorScopeMode {
  if (value === 'GLOBAL') return 'GLOBAL';
  return 'SUBTREE';
}

function parseDomainAffinityThreshold(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseRelationTypes(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseLimit(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const workspaceId = searchParams.get('workspaceId');
    const sourceCompoundId = searchParams.get('sourceCompoundId');
    const targetCompoundId = searchParams.get('targetCompoundId');

    if (!workspaceId || !sourceCompoundId || !targetCompoundId) {
      return NextResponse.json(
        { error: 'workspaceId, sourceCompoundId, targetCompoundId는 필수입니다' },
        { status: 400 },
      );
    }

    const db = await getDb();
    const result = await queryContributors(db, {
      workspaceId,
      sourceCompoundId,
      targetCompoundId,
      rollupId: searchParams.get('rollupId'),
      groupBy: parseGroupBy(searchParams.get('groupBy')),
      scopeMode: parseScopeMode(searchParams.get('scopeMode')),
      domainAffinityThreshold: parseDomainAffinityThreshold(searchParams.get('domainAffinityThreshold')),
      relationTypes: parseRelationTypes(searchParams.get('relationTypes')),
      limit: parseLimit(searchParams.get('limit')),
      cursor: searchParams.get('cursor'),
      excludedRelationTypes: ['expose'],
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[GET /api/mapping/contributors]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
