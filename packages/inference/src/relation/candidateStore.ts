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
  getRawCandidateConfidence,
  stripCrossValidationMetadata,
} from './utils';

export interface SaveRelationCandidateParams {
  workspaceId: string;
  relationType: string;
  subjectObjectId: string;
  objectId: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export async function saveRelationCandidate(
  db: DbClient,
  params: SaveRelationCandidateParams,
  evidenceId: string,
): Promise<{ created: boolean }> {
  const { workspaceId, relationType, subjectObjectId, objectId, confidence, metadata } = params;

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
  if (pending) {
    const pendingRawConfidence = getRawCandidateConfidence(pending.confidence ?? 0, pending.metadata);
    const pendingMetadata = asRecord(pending.metadata) ?? {};

    if (confidence > pendingRawConfidence) {
      await db
        .update(relationCandidates)
        .set({
          confidence,
          metadata: stripCrossValidationMetadata(metadata),
        })
        .where(eq(relationCandidates.id, pending.id));
    } else if (Object.prototype.hasOwnProperty.call(pendingMetadata, 'crossValidation')) {
      await db
        .update(relationCandidates)
        .set({
          confidence: pendingRawConfidence,
          metadata: stripCrossValidationMetadata(metadata),
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
    confidence,
    metadata,
    status: 'PENDING',
  });
  await db.insert(relationCandidateEvidences).values({ workspaceId, candidateId, evidenceId });
  return { created: true };
}
