import type { DbClient } from '@archi-navi/db';
import {
  objectRelations,
  relationCandidateEvidences,
  relationCandidates,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { and, eq, or } from 'drizzle-orm';
import {
  asRecord,
  getBaseCandidateConfidence,
  getPreCrossValidationConfidence,
  stripCrossValidationMetadata,
} from './utils';
import { applyFeedbackToRelationCandidateInput } from './feedbackLoop';

export interface SaveRelationCandidateParams {
  workspaceId: string;
  relationType: string;
  subjectObjectId: string;
  objectId: string;
  confidence: number;
  metadata: Record<string, unknown>;
  generationMode?: 'compat_deterministic';
}

function mergeSpecializedRelationMetadata(
  nextMetadata: Record<string, unknown>,
  currentMetadata: unknown,
): Record<string, unknown> {
  const merged = { ...stripCrossValidationMetadata(nextMetadata) };
  const existing = asRecord(stripCrossValidationMetadata(currentMetadata)) ?? {};

  if (!Object.prototype.hasOwnProperty.call(merged, 'framework') && existing.framework) {
    merged.framework = existing.framework;
  }
  if (!Object.prototype.hasOwnProperty.call(merged, 'language') && existing.language) {
    merged.language = existing.language;
  }

  return merged;
}

function hasSpecializationDelta(
  currentMetadata: unknown,
  nextMetadata: Record<string, unknown>,
): boolean {
  const current = asRecord(stripCrossValidationMetadata(currentMetadata)) ?? {};
  return current.framework !== nextMetadata.framework || current.language !== nextMetadata.language;
}

export async function saveRelationCandidate(
  db: DbClient,
  params: SaveRelationCandidateParams,
  evidenceId: string,
): Promise<{ created: boolean }> {
  const {
    workspaceId,
    relationType,
    subjectObjectId,
    objectId,
    confidence,
    metadata,
    generationMode,
  } = params;
  const candidateMetadata = generationMode
    ? {
        ...metadata,
        generationMode,
      }
    : metadata;

  const manualRelation = await db
    .select({ id: objectRelations.id })
    .from(objectRelations)
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objectRelations.relationType, relationType),
        eq(objectRelations.subjectObjectId, subjectObjectId),
        eq(objectRelations.objectId, objectId),
        eq(objectRelations.source, 'MANUAL'),
      ),
    )
    .limit(1);
  if (manualRelation.length > 0) return { created: false };

  const existingCandidates = await db
    .select({
      id: relationCandidates.id,
      status: relationCandidates.status,
      confidence: relationCandidates.confidence,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, workspaceId),
        eq(relationCandidates.relationType, relationType),
        eq(relationCandidates.subjectObjectId, subjectObjectId),
        eq(relationCandidates.objectId, objectId),
        or(
          eq(relationCandidates.status, 'PENDING'),
          eq(relationCandidates.status, 'APPROVED'),
        ),
      ),
    );

  const approved = existingCandidates.find((candidate) => candidate.status === 'APPROVED');
  if (approved) return { created: false };

  const pending = existingCandidates.find((candidate) => candidate.status === 'PENDING');
  const effectiveMetadata = pending
    ? mergeSpecializedRelationMetadata(candidateMetadata, pending.metadata)
    : candidateMetadata;
  const adjustedParams = await applyFeedbackToRelationCandidateInput(db, {
    ...params,
    metadata: effectiveMetadata,
  });
  if (pending) {
    const pendingBaseConfidence = getBaseCandidateConfidence(pending.confidence ?? 0, pending.metadata);
    const pendingMetadata = asRecord(pending.metadata) ?? {};
    const specializationChanged = hasSpecializationDelta(pending.metadata, effectiveMetadata);

    if (confidence >= pendingBaseConfidence) {
      await db
        .update(relationCandidates)
        .set({
          confidence: adjustedParams.confidence,
          metadata: stripCrossValidationMetadata(adjustedParams.metadata),
        })
        .where(eq(relationCandidates.id, pending.id));
    } else if (specializationChanged) {
      const recomputedPending = await applyFeedbackToRelationCandidateInput(db, {
        ...params,
        confidence: pendingBaseConfidence,
        metadata: effectiveMetadata,
      });
      await db
        .update(relationCandidates)
        .set({
          confidence: recomputedPending.confidence,
          metadata: stripCrossValidationMetadata(recomputedPending.metadata),
        })
        .where(eq(relationCandidates.id, pending.id));
    } else if (Object.prototype.hasOwnProperty.call(pendingMetadata, 'crossValidation')) {
      await db
        .update(relationCandidates)
        .set({
          confidence: getPreCrossValidationConfidence(pending.confidence ?? 0, pending.metadata),
          metadata: stripCrossValidationMetadata(pending.metadata),
        })
        .where(eq(relationCandidates.id, pending.id));
    }

    await db
      .insert(relationCandidateEvidences)
      .values({ workspaceId, candidateId: pending.id, evidenceId })
      .onConflictDoNothing();
    return { created: false };
  }

  const candidateId = generateId();
  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType,
    subjectObjectId,
    objectId,
    confidence: adjustedParams.confidence,
    metadata: adjustedParams.metadata,
    status: 'PENDING',
  });
  await db.insert(relationCandidateEvidences).values({ workspaceId, candidateId, evidenceId });
  return { created: true };
}
