/**
 * Relation Candidate 승인/거부 처리
 * 승인 시:
 * 1) object_relations에 확정 관계 생성(중복 시 기존 관계 재사용)
 * 2) relation_candidate_evidences를 relation_evidences로 승격
 */
import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  objectRelations,
  relationCandidates,
  relationCandidateEvidences,
  relationEvidences,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { accumulateRelationCandidateFeedback } from './feedbackLoop';

export interface ApproveRelationCandidateResult {
  success: boolean;
  status: 'APPROVED' | 'REJECTED';
  relationId?: string;
  promotedEvidenceCount: number;
}

export async function approveRelationCandidate(
  db: DbClient,
  candidateId: string,
  action: 'APPROVED' | 'REJECTED',
): Promise<ApproveRelationCandidateResult> {
  const reviewedAt = new Date();

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId))
      .limit(1);

    if (!candidate) {
      throw new Error('candidate not found');
    }

    const shouldAggregateFeedback = candidate.status === 'PENDING' || candidate.reviewedAt === null;

    await tx
      .update(relationCandidates)
      .set({ status: action, reviewedAt })
      .where(eq(relationCandidates.id, candidateId));

    if (shouldAggregateFeedback) {
      await accumulateRelationCandidateFeedback(tx, candidate, action);
    }

    if (action === 'REJECTED') {
      return {
        success: true,
        status: 'REJECTED' as const,
        promotedEvidenceCount: 0,
      };
    }

    const [insertedRelation] = await tx
      .insert(objectRelations)
      .values({
        id: generateId(),
        workspaceId: candidate.workspaceId,
        subjectObjectId: candidate.subjectObjectId,
        relationType: candidate.relationType,
        objectId: candidate.objectId,
        confidence: candidate.confidence,
        status: 'APPROVED',
        source: 'INFERRED',
        metadata: {
          ...(candidate.metadata as Record<string, unknown>),
          approvedFromCandidate: candidate.id,
        },
      })
      .onConflictDoNothing({
        target: [
          objectRelations.workspaceId,
          objectRelations.relationType,
          objectRelations.subjectObjectId,
          objectRelations.objectId,
          objectRelations.isDerived,
        ],
      })
      .returning({ id: objectRelations.id });

    let relationId = insertedRelation?.id;
    if (!relationId) {
      const [existingRelation] = await tx
        .select({ id: objectRelations.id })
        .from(objectRelations)
        .where(
          and(
            eq(objectRelations.workspaceId, candidate.workspaceId),
            eq(objectRelations.relationType, candidate.relationType),
            eq(objectRelations.subjectObjectId, candidate.subjectObjectId),
            eq(objectRelations.objectId, candidate.objectId),
            eq(objectRelations.isDerived, false),
          ),
        )
        .limit(1);

      if (!existingRelation) {
        throw new Error('approved relation not found');
      }
      relationId = existingRelation.id;
    }

    const candidateEvidenceRows = await tx
      .select({ evidenceId: relationCandidateEvidences.evidenceId })
      .from(relationCandidateEvidences)
      .where(
        and(
          eq(relationCandidateEvidences.workspaceId, candidate.workspaceId),
          eq(relationCandidateEvidences.candidateId, candidate.id),
        ),
      );

    let promotedEvidenceCount = 0;
    if (candidateEvidenceRows.length > 0) {
      const existingRows = await tx
        .select({ evidenceId: relationEvidences.evidenceId })
        .from(relationEvidences)
        .where(
          and(
            eq(relationEvidences.workspaceId, candidate.workspaceId),
            eq(relationEvidences.relationId, relationId),
          ),
        );
      const existingEvidenceIds = new Set(existingRows.map((row) => row.evidenceId));

      const missingEvidenceRows = candidateEvidenceRows.filter(
        (row) => !existingEvidenceIds.has(row.evidenceId),
      );

      if (missingEvidenceRows.length > 0) {
        await tx.insert(relationEvidences).values(
          missingEvidenceRows.map((row) => ({
            workspaceId: candidate.workspaceId,
            relationId,
            evidenceId: row.evidenceId,
          })),
        );
      }

      promotedEvidenceCount = missingEvidenceRows.length;
    }

    return {
      success: true,
      status: 'APPROVED' as const,
      relationId,
      promotedEvidenceCount,
    };
  });
}
