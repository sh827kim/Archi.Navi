import type { DbClient } from '@archi-navi/db';
import {
  codeCallEdges,
  objectDomainAffinities,
  objectGraphStats,
  objectRelations,
  objectRollups,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  relationEvidences,
} from '@archi-navi/db';
import { and, eq, inArray, or } from 'drizzle-orm';
import { asRecord } from './utils';

export interface MergeDbTableCandidateResult {
  success: true;
  sourceObjectId: string;
  targetObjectId: string;
  mergedRelationCount: number;
  mergedCandidateCount: number;
  mergedDomainAffinityCount: number;
  affectedDomainIds: string[];
}

export type DbTableMergeErrorCode =
  | 'CANDIDATE_NOT_FOUND'
  | 'INVALID_MERGE_CANDIDATE'
  | 'MERGE_TABLE_NOT_FOUND'
  | 'INVALID_MERGE_TABLE_TYPE'
  | 'MERGE_TABLE_DATABASE_MISMATCH'
  | 'INVALID_MERGE_DIRECTION'
  | 'MERGE_TABLE_NAME_MISMATCH';

export class DbTableMergeError extends Error {
  readonly code: DbTableMergeErrorCode;
  readonly status: number;

  constructor(code: DbTableMergeErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'DbTableMergeError';
    this.code = code;
    this.status = status;
  }
}

interface MergeContext {
  workspaceId: string;
  candidateId: string;
  sourceObjectId: string;
  targetObjectId: string;
}

type DbExecutor = Pick<DbClient, 'select' | 'insert' | 'update' | 'delete'>;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function tableBaseName(name: string, metadata: unknown): string {
  const meta = asRecord(metadata) ?? {};
  const table = meta['table'];
  if (typeof table === 'string' && table.trim().length > 0) {
    return table.trim().toLowerCase();
  }
  const normalized = name.trim().toLowerCase();
  return normalized.split('.').pop() ?? normalized;
}

function tableSchemaName(name: string, metadata: unknown): string | null {
  const meta = asRecord(metadata) ?? {};
  const schema = meta['schema'];
  if (typeof schema === 'string' && schema.trim().length > 0) {
    return schema.trim().toLowerCase();
  }
  const normalized = name.trim().toLowerCase();
  const parts = normalized.split('.');
  return parts.length === 2 && parts[0] ? parts[0] : null;
}

function mergeMetadata(
  existing: unknown,
  next: unknown,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(asRecord(existing) ?? {}),
    ...(asRecord(next) ?? {}),
    ...patch,
  };
}

async function mergeRelationEvidence(
  tx: DbExecutor,
  workspaceId: string,
  fromRelationId: string,
  toRelationId: string,
): Promise<void> {
  const rows = await tx
    .select({ evidenceId: relationEvidences.evidenceId })
    .from(relationEvidences)
    .where(
      and(
        eq(relationEvidences.workspaceId, workspaceId),
        eq(relationEvidences.relationId, fromRelationId),
      ),
    );
  if (rows.length === 0) return;

  await tx
    .insert(relationEvidences)
    .values(rows.map((row) => ({ workspaceId, relationId: toRelationId, evidenceId: row.evidenceId })))
    .onConflictDoNothing();
}

async function mergeCandidateEvidence(
  tx: DbExecutor,
  workspaceId: string,
  fromCandidateId: string,
  toCandidateId: string,
): Promise<void> {
  const rows = await tx
    .select({ evidenceId: relationCandidateEvidences.evidenceId })
    .from(relationCandidateEvidences)
    .where(
      and(
        eq(relationCandidateEvidences.workspaceId, workspaceId),
        eq(relationCandidateEvidences.candidateId, fromCandidateId),
      ),
    );
  if (rows.length === 0) return;

  await tx
    .insert(relationCandidateEvidences)
    .values(rows.map((row) => ({ workspaceId, candidateId: toCandidateId, evidenceId: row.evidenceId })))
    .onConflictDoNothing();
}

async function mergeDomainAffinities(tx: DbExecutor, ctx: MergeContext): Promise<{
  mergedCount: number;
  affectedDomainIds: string[];
}> {
  const sourceRows = await tx
    .select({
      id: objectDomainAffinities.id,
      domainId: objectDomainAffinities.domainId,
      affinity: objectDomainAffinities.affinity,
      confidence: objectDomainAffinities.confidence,
      source: objectDomainAffinities.source,
    })
    .from(objectDomainAffinities)
    .where(
      and(
        eq(objectDomainAffinities.workspaceId, ctx.workspaceId),
        eq(objectDomainAffinities.objectId, ctx.sourceObjectId),
      ),
    );

  let mergedCount = 0;
  const affectedDomainIds = new Set<string>();
  for (const row of sourceRows) {
    affectedDomainIds.add(row.domainId);
    const [existing] = await tx
      .select({
        id: objectDomainAffinities.id,
        affinity: objectDomainAffinities.affinity,
        confidence: objectDomainAffinities.confidence,
      })
      .from(objectDomainAffinities)
      .where(
        and(
          eq(objectDomainAffinities.workspaceId, ctx.workspaceId),
          eq(objectDomainAffinities.objectId, ctx.targetObjectId),
          eq(objectDomainAffinities.domainId, row.domainId),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(objectDomainAffinities)
        .set({
          affinity: Math.max(existing.affinity, row.affinity),
          confidence: maxNullable(existing.confidence, row.confidence),
          updatedAt: new Date(),
        })
        .where(eq(objectDomainAffinities.id, existing.id));
      await tx.delete(objectDomainAffinities).where(eq(objectDomainAffinities.id, row.id));
    } else {
      await tx
        .update(objectDomainAffinities)
        .set({ objectId: ctx.targetObjectId, updatedAt: new Date() })
        .where(eq(objectDomainAffinities.id, row.id));
    }
    mergedCount += 1;
  }

  return { mergedCount, affectedDomainIds: Array.from(affectedDomainIds).sort() };
}

async function mergeObjectRelations(tx: DbExecutor, ctx: MergeContext): Promise<number> {
  const rows = await tx
    .select({
      id: objectRelations.id,
      relationType: objectRelations.relationType,
      subjectObjectId: objectRelations.subjectObjectId,
      objectId: objectRelations.objectId,
      isDerived: objectRelations.isDerived,
      confidence: objectRelations.confidence,
      metadata: objectRelations.metadata,
    })
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, ctx.workspaceId),
        or(
          eq(objectRelations.subjectObjectId, ctx.sourceObjectId),
          eq(objectRelations.objectId, ctx.sourceObjectId),
        ),
      ),
    );

  let mergedCount = 0;
  for (const row of rows) {
    const nextSubject =
      row.subjectObjectId === ctx.sourceObjectId ? ctx.targetObjectId : row.subjectObjectId;
    const nextObject = row.objectId === ctx.sourceObjectId ? ctx.targetObjectId : row.objectId;

    if (nextSubject === nextObject) {
      await tx.delete(objectRelations).where(eq(objectRelations.id, row.id));
      mergedCount += 1;
      continue;
    }

    const [existing] = await tx
      .select({
        id: objectRelations.id,
        confidence: objectRelations.confidence,
        metadata: objectRelations.metadata,
      })
      .from(objectRelations)
      .where(
        and(
          eq(objectRelations.workspaceId, ctx.workspaceId),
          eq(objectRelations.relationType, row.relationType),
          eq(objectRelations.subjectObjectId, nextSubject),
          eq(objectRelations.objectId, nextObject),
          eq(objectRelations.isDerived, row.isDerived),
        ),
      )
      .limit(1);

    if (existing && existing.id !== row.id) {
      await mergeRelationEvidence(tx, ctx.workspaceId, row.id, existing.id);
      await tx
        .update(objectRelations)
        .set({
          confidence: maxNullable(existing.confidence, row.confidence),
          metadata: mergeMetadata(existing.metadata, row.metadata, {
            mergedFromObjectIds: uniqueStrings([
              ...asStringArray(asRecord(existing.metadata)?.['mergedFromObjectIds']),
              ctx.sourceObjectId,
            ]),
          }),
        })
        .where(eq(objectRelations.id, existing.id));
      await tx.delete(objectRelations).where(eq(objectRelations.id, row.id));
    } else {
      await tx
        .update(objectRelations)
        .set({
          subjectObjectId: nextSubject,
          objectId: nextObject,
          metadata: mergeMetadata(row.metadata, null, {
            mergedFromObjectIds: uniqueStrings([
              ...asStringArray(asRecord(row.metadata)?.['mergedFromObjectIds']),
              ctx.sourceObjectId,
            ]),
          }),
        })
        .where(eq(objectRelations.id, row.id));
    }
    mergedCount += 1;
  }

  return mergedCount;
}

async function mergeRelationCandidates(tx: DbExecutor, ctx: MergeContext): Promise<number> {
  const rows = await tx
    .select({
      id: relationCandidates.id,
      relationType: relationCandidates.relationType,
      subjectObjectId: relationCandidates.subjectObjectId,
      objectId: relationCandidates.objectId,
      status: relationCandidates.status,
      confidence: relationCandidates.confidence,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, ctx.workspaceId),
        or(
          eq(relationCandidates.subjectObjectId, ctx.sourceObjectId),
          eq(relationCandidates.objectId, ctx.sourceObjectId),
        ),
      ),
    );

  let mergedCount = 0;
  const reviewedAt = new Date();
  for (const row of rows) {
    if (row.id === ctx.candidateId) {
      await tx
        .update(relationCandidates)
        .set({
          subjectObjectId: ctx.targetObjectId,
          objectId: ctx.targetObjectId,
          status: 'APPROVED',
          reviewedAt,
          metadata: mergeMetadata(row.metadata, null, {
            approvedAsHardMerge: true,
            originalSubjectObjectId: ctx.sourceObjectId,
            targetObjectId: ctx.targetObjectId,
          }),
        })
        .where(eq(relationCandidates.id, row.id));
      mergedCount += 1;
      continue;
    }

    if (row.relationType === 'same_db_table') {
      await tx
        .update(relationCandidates)
        .set({
          subjectObjectId: ctx.targetObjectId,
          objectId: ctx.targetObjectId,
          status: 'REJECTED',
          reviewedAt,
          metadata: mergeMetadata(row.metadata, null, {
            staleReason: 'db_table_hard_merged',
            mergedByCandidateId: ctx.candidateId,
            originalSubjectObjectId: row.subjectObjectId,
            originalObjectId: row.objectId,
          }),
        })
        .where(eq(relationCandidates.id, row.id));
      mergedCount += 1;
      continue;
    }

    const nextSubject =
      row.subjectObjectId === ctx.sourceObjectId ? ctx.targetObjectId : row.subjectObjectId;
    const nextObject = row.objectId === ctx.sourceObjectId ? ctx.targetObjectId : row.objectId;

    if (nextSubject === nextObject) {
      await tx.delete(relationCandidates).where(eq(relationCandidates.id, row.id));
      mergedCount += 1;
      continue;
    }

    const [existing] = await tx
      .select({
        id: relationCandidates.id,
        confidence: relationCandidates.confidence,
        metadata: relationCandidates.metadata,
      })
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, ctx.workspaceId),
          eq(relationCandidates.relationType, row.relationType),
          eq(relationCandidates.subjectObjectId, nextSubject),
          eq(relationCandidates.objectId, nextObject),
          eq(relationCandidates.status, row.status),
        ),
      )
      .limit(1);

    if (existing && existing.id !== row.id) {
      await mergeCandidateEvidence(tx, ctx.workspaceId, row.id, existing.id);
      await tx
        .update(relationCandidates)
        .set({
          confidence: Math.max(existing.confidence, row.confidence),
          metadata: mergeMetadata(existing.metadata, row.metadata, {
            mergedFromObjectIds: uniqueStrings([
              ...asStringArray(asRecord(existing.metadata)?.['mergedFromObjectIds']),
              ctx.sourceObjectId,
            ]),
          }),
        })
        .where(eq(relationCandidates.id, existing.id));
      await tx.delete(relationCandidates).where(eq(relationCandidates.id, row.id));
    } else {
      await tx
        .update(relationCandidates)
        .set({
          subjectObjectId: nextSubject,
          objectId: nextObject,
          metadata: mergeMetadata(row.metadata, null, {
            mergedFromObjectIds: uniqueStrings([
              ...asStringArray(asRecord(row.metadata)?.['mergedFromObjectIds']),
              ctx.sourceObjectId,
            ]),
          }),
        })
        .where(eq(relationCandidates.id, row.id));
    }
    mergedCount += 1;
  }

  return mergedCount;
}

async function clearSourceRollupReferences(tx: DbExecutor, ctx: MergeContext): Promise<void> {
  await tx
    .delete(objectRollups)
    .where(
      and(
        eq(objectRollups.workspaceId, ctx.workspaceId),
        or(
          eq(objectRollups.subjectObjectId, ctx.sourceObjectId),
          eq(objectRollups.objectId, ctx.sourceObjectId),
        ),
      ),
    );

  await tx
    .delete(objectGraphStats)
    .where(
      and(
        eq(objectGraphStats.workspaceId, ctx.workspaceId),
        eq(objectGraphStats.objectId, ctx.sourceObjectId),
      ),
    );
}

export async function mergeImplicitSchemaDbTableCandidate(
  db: DbClient,
  params: { workspaceId: string; candidateId: string },
): Promise<MergeDbTableCandidateResult> {
  const { workspaceId, candidateId } = params;

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(relationCandidates)
      .where(and(eq(relationCandidates.workspaceId, workspaceId), eq(relationCandidates.id, candidateId)))
      .limit(1);
    if (!candidate) {
      throw new DbTableMergeError('CANDIDATE_NOT_FOUND', 'candidate not found', 404);
    }
    if (candidate.status !== 'PENDING' || candidate.relationType !== 'same_db_table') {
      throw new DbTableMergeError('INVALID_MERGE_CANDIDATE', 'invalid merge candidate');
    }

    const tableRows = await tx
      .select({
        id: objects.id,
        name: objects.name,
        objectType: objects.objectType,
        parentId: objects.parentId,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          inArray(objects.id, [candidate.subjectObjectId, candidate.objectId]),
        ),
      );
    const byId = new Map(tableRows.map((row) => [row.id, row]));
    const source = byId.get(candidate.subjectObjectId);
    const target = byId.get(candidate.objectId);
    if (!source || !target) {
      throw new DbTableMergeError('MERGE_TABLE_NOT_FOUND', 'merge table not found', 404);
    }
    if (source.objectType !== 'db_table' || target.objectType !== 'db_table') {
      throw new DbTableMergeError('INVALID_MERGE_TABLE_TYPE', 'invalid merge table type');
    }
    if (!source.parentId || source.parentId !== target.parentId) {
      throw new DbTableMergeError(
        'MERGE_TABLE_DATABASE_MISMATCH',
        'merge table database mismatch',
      );
    }
    const sourceSchema = tableSchemaName(source.name, source.metadata);
    const targetSchema = tableSchemaName(target.name, target.metadata);
    if (sourceSchema || !targetSchema) {
      throw new DbTableMergeError('INVALID_MERGE_DIRECTION', 'invalid merge direction');
    }
    if (tableBaseName(source.name, source.metadata) !== tableBaseName(target.name, target.metadata)) {
      throw new DbTableMergeError('MERGE_TABLE_NAME_MISMATCH', 'merge table name mismatch');
    }

    const sourceMeta = asRecord(source.metadata) ?? {};
    const targetMeta = asRecord(target.metadata) ?? {};
    const observedByServiceIds = uniqueStrings([
      ...asStringArray(targetMeta['observedByServiceIds']),
      ...asStringArray(sourceMeta['observedByServiceIds']),
    ]);
    const mergedObjectIds = uniqueStrings([
      ...asStringArray(targetMeta['mergedObjectIds']),
      ...asStringArray(sourceMeta['mergedObjectIds']),
      source.id,
    ]);
    const implicitTableAliases = uniqueStrings([
      ...asStringArray(targetMeta['implicitTableAliases']),
      source.name,
      ...(typeof sourceMeta['table'] === 'string' ? [sourceMeta['table']] : []),
    ]);

    await tx
      .update(objects)
      .set({
        metadata: {
          ...targetMeta,
          observedByServiceIds,
          mergedObjectIds,
          implicitTableAliases,
          hardMergedFromObjectId: source.id,
        },
        updatedAt: new Date(),
      })
      .where(eq(objects.id, target.id));

    const domainResult = await mergeDomainAffinities(tx, {
      workspaceId,
      candidateId,
      sourceObjectId: source.id,
      targetObjectId: target.id,
    });
    const mergedRelationCount = await mergeObjectRelations(tx, {
      workspaceId,
      candidateId,
      sourceObjectId: source.id,
      targetObjectId: target.id,
    });
    const mergedCandidateCount = await mergeRelationCandidates(tx, {
      workspaceId,
      candidateId,
      sourceObjectId: source.id,
      targetObjectId: target.id,
    });

    await tx
      .update(codeCallEdges)
      .set({ calleeOwnerObjectId: target.id })
      .where(
        and(
          eq(codeCallEdges.workspaceId, workspaceId),
          eq(codeCallEdges.calleeOwnerObjectId, source.id),
        ),
      );

    await clearSourceRollupReferences(tx, {
      workspaceId,
      candidateId,
      sourceObjectId: source.id,
      targetObjectId: target.id,
    });

    await tx.delete(objects).where(and(eq(objects.workspaceId, workspaceId), eq(objects.id, source.id)));

    return {
      success: true,
      sourceObjectId: source.id,
      targetObjectId: target.id,
      mergedRelationCount,
      mergedCandidateCount,
      mergedDomainAffinityCount: domainResult.mergedCount,
      affectedDomainIds: domainResult.affectedDomainIds,
    };
  });
}
