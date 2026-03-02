import {
  evidences,
  objectDomainAffinities,
  objectRelations,
  objectRollupProvenances,
  objects,
  relationEvidences,
  type DbClient,
} from '@archi-navi/db';
import { and, eq, inArray } from 'drizzle-orm';

export type ContributorGroupBy =
  | 'targetCompound'
  | 'relationType'
  | 'sourceAtomic'
  | 'targetAtomic';
export type ContributorScopeMode = 'SUBTREE' | 'GLOBAL';

const DEFAULT_DOMAIN_AFFINITY_THRESHOLD = 0.2;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_EXCLUDED_RELATION_TYPES = ['expose'];

type ObjectSnapshot = {
  id: string;
  parentId: string | null;
  path: string;
  name: string;
  displayName: string | null;
  objectType: string;
};

export type ContributorEvidenceItem = {
  id: string;
  evidenceType: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  excerpt: string | null;
};

export type ContributorRelation = {
  relationId: string;
  relationType: string;
  confidence: number | null;
  sourceAtomicId: string;
  sourceAtomicLabel: string;
  sourceCompoundId: string;
  sourceCompoundLabel: string;
  targetAtomicId: string;
  targetAtomicLabel: string;
  targetCompoundId: string;
  targetCompoundLabel: string;
  evidenceCount: number;
  evidences: ContributorEvidenceItem[];
};

export interface ContributorQueryResult {
  summary: {
    totalCount: number;
    byRelationType: Record<string, number>;
  };
  groups: Array<{
    groupKey: string;
    weight: number;
    relations: ContributorRelation[];
  }>;
  scopeMode: ContributorScopeMode;
  pageInfo: {
    limit: number;
    hasNext: boolean;
    nextCursor: string | null;
  };
}

export interface ContributorQueryInput {
  workspaceId: string;
  sourceCompoundId: string;
  targetCompoundId: string;
  rollupId?: string | null;
  groupBy?: ContributorGroupBy;
  scopeMode?: ContributorScopeMode;
  domainAffinityThreshold?: number | null;
  relationTypes?: string[] | null;
  limit?: number | null;
  cursor?: string | null;
  excludedRelationTypes?: string[] | null;
}

function normalizeGroupBy(value: string | null | undefined): ContributorGroupBy {
  if (value === 'sourceAtomic') return 'sourceAtomic';
  if (value === 'targetAtomic') return 'targetAtomic';
  if (value === 'relationType') return 'relationType';
  return 'targetCompound';
}

function normalizeScopeMode(value: string | null | undefined): ContributorScopeMode {
  if (value === 'GLOBAL') return 'GLOBAL';
  return 'SUBTREE';
}

function normalizeDomainAffinityThreshold(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DOMAIN_AFFINITY_THRESHOLD;
  return Math.min(1, Math.max(0, Number(value)));
}

function normalizeRelationTypes(value: string[] | null | undefined): string[] {
  if (!value) return [];
  return value.map((v) => v.trim()).filter((v) => v.length > 0);
}

function normalizeLimit(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(value))));
}

function decodeCursor(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = Number.parseInt(decoded, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function resolveCompoundId(objectMap: Map<string, ObjectSnapshot>, objectId: string): string {
  let current = objectMap.get(objectId);
  if (!current) return objectId;

  while (current.parentId) {
    const parent = objectMap.get(current.parentId);
    if (!parent) break;
    current = parent;
  }

  return current.id;
}

function resolveSubtreeIds(allObjects: ObjectSnapshot[], rootId: string): Set<string> {
  const root = allObjects.find((obj) => obj.id === rootId);
  if (!root) return new Set([rootId]);
  const prefix = `${root.path}/`;
  return new Set(
    allObjects
      .filter((obj) => obj.id === root.id || obj.path.startsWith(prefix))
      .map((obj) => obj.id),
  );
}

function expandServiceSubtreeIds(
  allObjects: ObjectSnapshot[],
  serviceIds: Set<string>,
): Set<string> {
  if (serviceIds.size === 0) return new Set();

  const serviceRoots = allObjects.filter((obj) => serviceIds.has(obj.id));
  const servicePrefixes = serviceRoots.map((obj) => `${obj.path}/`);
  const result = new Set<string>(serviceRoots.map((obj) => obj.id));

  for (const obj of allObjects) {
    if (servicePrefixes.some((prefix) => obj.path.startsWith(prefix))) {
      result.add(obj.id);
    }
  }

  return result;
}

function resolveScopeIds(
  allObjects: ObjectSnapshot[],
  rootId: string,
  affinityRows: Array<{ objectId: string; domainId: string; affinity: number }>,
  domainAffinityThreshold: number,
): Set<string> {
  const root = allObjects.find((obj) => obj.id === rootId);
  if (!root) return new Set([rootId]);

  if (root.objectType !== 'domain') {
    return resolveSubtreeIds(allObjects, rootId);
  }

  const domainServiceIds = new Set(
    affinityRows
      .filter((row) => row.domainId === rootId && row.affinity >= domainAffinityThreshold)
      .map((row) => row.objectId),
  );
  const expanded = expandServiceSubtreeIds(allObjects, domainServiceIds);
  expanded.add(rootId);
  return expanded;
}

export async function queryContributors(
  db: DbClient,
  input: ContributorQueryInput,
): Promise<ContributorQueryResult> {
  const workspaceId = input.workspaceId;
  const sourceCompoundId = input.sourceCompoundId;
  const targetCompoundId = input.targetCompoundId;

  if (!workspaceId || !sourceCompoundId || !targetCompoundId) {
    throw new Error('workspaceId, sourceCompoundId, targetCompoundId는 필수입니다');
  }

  const groupBy = normalizeGroupBy(input.groupBy);
  const scopeMode = normalizeScopeMode(input.scopeMode);
  const domainAffinityThreshold = normalizeDomainAffinityThreshold(input.domainAffinityThreshold);
  const relationTypes = normalizeRelationTypes(input.relationTypes);
  const excludedTypes = new Set(
    normalizeRelationTypes(input.excludedRelationTypes ?? DEFAULT_EXCLUDED_RELATION_TYPES),
  );
  const limit = normalizeLimit(input.limit);
  const startOffset = decodeCursor(input.cursor);

  const allObjects = await db
    .select({
      id: objects.id,
      parentId: objects.parentId,
      path: objects.path,
      name: objects.name,
      displayName: objects.displayName,
      objectType: objects.objectType,
    })
    .from(objects)
    .where(eq(objects.workspaceId, workspaceId));

  const objectMap = new Map(allObjects.map((obj) => [obj.id, obj]));
  const affinityRows = await db
    .select({
      objectId: objectDomainAffinities.objectId,
      domainId: objectDomainAffinities.domainId,
      affinity: objectDomainAffinities.affinity,
    })
    .from(objectDomainAffinities)
    .where(eq(objectDomainAffinities.workspaceId, workspaceId));

  const sourceScopeIds = resolveScopeIds(
    allObjects,
    sourceCompoundId,
    affinityRows,
    domainAffinityThreshold,
  );
  const targetScopeIds = resolveScopeIds(
    allObjects,
    targetCompoundId,
    affinityRows,
    domainAffinityThreshold,
  );

  const rollupId =
    input.rollupId && input.rollupId.startsWith('rollup-')
      ? input.rollupId.slice('rollup-'.length)
      : input.rollupId;

  let relationRows =
    rollupId
      ? await db
          .select({
            id: objectRelations.id,
            relationType: objectRelations.relationType,
            confidence: objectRelations.confidence,
            subjectObjectId: objectRelations.subjectObjectId,
            objectId: objectRelations.objectId,
          })
          .from(objectRollupProvenances)
          .innerJoin(
            objectRelations,
            and(
              eq(objectRollupProvenances.workspaceId, objectRelations.workspaceId),
              eq(objectRollupProvenances.baseRelationId, objectRelations.id),
            ),
          )
          .where(
            and(
              eq(objectRollupProvenances.workspaceId, workspaceId),
              eq(objectRollupProvenances.rollupId, rollupId),
              eq(objectRelations.status, 'APPROVED'),
            ),
          )
      : [];

  if (relationRows.length === 0) {
    if (targetScopeIds.size === 0) {
      return {
        summary: { totalCount: 0, byRelationType: {} },
        groups: [],
        scopeMode,
        pageInfo: { limit, hasNext: false, nextCursor: null },
      };
    }

    const baseConditions = [
      eq(objectRelations.workspaceId, workspaceId),
      eq(objectRelations.status, 'APPROVED'),
      eq(objectRelations.isDerived, false),
      inArray(objectRelations.objectId, [...targetScopeIds]),
    ] as const;

    relationRows = await db
      .select({
        id: objectRelations.id,
        relationType: objectRelations.relationType,
        confidence: objectRelations.confidence,
        subjectObjectId: objectRelations.subjectObjectId,
        objectId: objectRelations.objectId,
      })
      .from(objectRelations)
      .where(
        scopeMode === 'SUBTREE'
          ? and(
              ...baseConditions,
              inArray(objectRelations.subjectObjectId, [...sourceScopeIds]),
            )
          : and(...baseConditions),
      );
  }

  relationRows = relationRows.filter((row) => {
    if (!targetScopeIds.has(row.objectId)) return false;
    if (excludedTypes.has(row.relationType)) return false;
    if (scopeMode === 'GLOBAL') return true;
    return sourceScopeIds.has(row.subjectObjectId);
  });

  if (relationTypes.length > 0) {
    relationRows = relationRows.filter((row) => relationTypes.includes(row.relationType));
  }

  const uniqueById = new Map(relationRows.map((row) => [row.id, row]));
  const dedupedRows = [...uniqueById.values()];

  if (dedupedRows.length === 0) {
    return {
      summary: { totalCount: 0, byRelationType: {} },
      groups: [],
      scopeMode,
      pageInfo: { limit, hasNext: false, nextCursor: null },
    };
  }

  const relationIds = dedupedRows.map((row) => row.id);

  const evidenceRows = await db
    .select({
      relationId: relationEvidences.relationId,
      evidenceId: evidences.id,
      evidenceType: evidences.evidenceType,
      filePath: evidences.filePath,
      lineStart: evidences.lineStart,
      lineEnd: evidences.lineEnd,
      excerpt: evidences.excerpt,
    })
    .from(relationEvidences)
    .innerJoin(
      evidences,
      and(
        eq(relationEvidences.workspaceId, evidences.workspaceId),
        eq(relationEvidences.evidenceId, evidences.id),
      ),
    )
    .where(
      and(
        eq(relationEvidences.workspaceId, workspaceId),
        inArray(relationEvidences.relationId, relationIds),
      ),
    );

  const evidenceByRelationId = new Map<string, ContributorEvidenceItem[]>();
  for (const row of evidenceRows) {
    const list = evidenceByRelationId.get(row.relationId) ?? [];
    list.push({
      id: row.evidenceId,
      evidenceType: row.evidenceType,
      filePath: row.filePath,
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      excerpt: row.excerpt,
    });
    evidenceByRelationId.set(row.relationId, list);
  }

  const relations: ContributorRelation[] = dedupedRows.map((row) => {
    const sourceAtomic = objectMap.get(row.subjectObjectId);
    const targetAtomic = objectMap.get(row.objectId);

    const sourceCompoundResolvedId = resolveCompoundId(objectMap, row.subjectObjectId);
    const targetCompoundResolvedId = resolveCompoundId(objectMap, row.objectId);
    const sourceCompound = objectMap.get(sourceCompoundResolvedId);
    const targetCompound = objectMap.get(targetCompoundResolvedId);
    const relationEvs = evidenceByRelationId.get(row.id) ?? [];

    return {
      relationId: row.id,
      relationType: row.relationType,
      confidence: row.confidence,
      sourceAtomicId: row.subjectObjectId,
      sourceAtomicLabel: sourceAtomic?.displayName ?? sourceAtomic?.name ?? row.subjectObjectId,
      sourceCompoundId: sourceCompoundResolvedId,
      sourceCompoundLabel:
        sourceCompound?.displayName ?? sourceCompound?.name ?? sourceCompoundResolvedId,
      targetAtomicId: row.objectId,
      targetAtomicLabel: targetAtomic?.displayName ?? targetAtomic?.name ?? row.objectId,
      targetCompoundId: targetCompoundResolvedId,
      targetCompoundLabel:
        targetCompound?.displayName ?? targetCompound?.name ?? targetCompoundResolvedId,
      evidenceCount: relationEvs.length,
      evidences: relationEvs,
    };
  });

  const byRelationType: Record<string, number> = {};
  const groups = new Map<string, { groupKey: string; weight: number; relations: ContributorRelation[] }>();

  for (const relation of relations) {
    byRelationType[relation.relationType] = (byRelationType[relation.relationType] ?? 0) + 1;
    let key: string;
    if (groupBy === 'relationType') key = relation.relationType;
    else if (groupBy === 'sourceAtomic') key = relation.sourceAtomicLabel;
    else if (groupBy === 'targetAtomic') key = relation.targetAtomicLabel;
    else key = relation.targetCompoundLabel;

    const existing = groups.get(key) ?? { groupKey: key, weight: 0, relations: [] };
    existing.weight += 1;
    existing.relations.push(relation);
    groups.set(key, existing);
  }

  const grouped = [...groups.values()]
    .sort((a, b) => b.weight - a.weight)
    .map((group) => ({
      groupKey: group.groupKey,
      weight: group.weight,
      relations: group.relations,
    }));

  const pagedGroups = grouped.slice(startOffset, startOffset + limit);
  const nextOffset = startOffset + limit;
  const hasNext = nextOffset < grouped.length;

  return {
    summary: {
      totalCount: relations.length,
      byRelationType,
    },
    groups: pagedGroups,
    scopeMode,
    pageInfo: {
      limit,
      hasNext,
      nextCursor: hasNext ? encodeCursor(nextOffset) : null,
    },
  };
}
