import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { domainCandidates, objectDomainAffinities } from '@archi-navi/db';
import { accumulateDomainCandidateFeedback } from './feedbackLoop';

export interface ApproveDomainCandidateResult {
  success: boolean;
  status: 'APPROVED' | 'REJECTED';
  /** 승인 시 생성/갱신된 affinities 수 */
  affinityCount: number;
}

export async function approveDomainCandidate(
  db: DbClient,
  candidateId: string,
  action: 'APPROVED' | 'REJECTED',
): Promise<ApproveDomainCandidateResult> {
  const reviewedAt = new Date();

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(domainCandidates)
      .where(eq(domainCandidates.id, candidateId))
      .limit(1);

    if (!candidate) {
      throw new Error('candidate not found');
    }

    const shouldAggregateFeedback = candidate.status === 'PENDING' || candidate.reviewedAt === null;

    await tx
      .update(domainCandidates)
      .set({ status: action, reviewedAt })
      .where(eq(domainCandidates.id, candidateId));

    if (shouldAggregateFeedback) {
      await accumulateDomainCandidateFeedback(tx, candidate, action);
    }

    if (action === 'REJECTED') {
      return { success: true, status: 'REJECTED', affinityCount: 0 };
    }

    const affinityMap = (candidate.affinityMap ?? {}) as Record<string, number>;
    const entries = Object.entries(affinityMap);

    for (const [domainId, affinity] of entries) {
      await tx
        .insert(objectDomainAffinities)
        .values({
          workspaceId: candidate.workspaceId,
          objectId: candidate.objectId,
          domainId,
          affinity,
          confidence: candidate.purity,
          source: 'APPROVED_INFERENCE',
        })
        .onConflictDoUpdate({
          target: [
            objectDomainAffinities.workspaceId,
            objectDomainAffinities.objectId,
            objectDomainAffinities.domainId,
          ],
          set: {
            affinity: sql`excluded.affinity`,
            confidence: sql`excluded.confidence`,
            source: sql`excluded.source`,
            updatedAt: sql`now()`,
          },
        });
    }

    return { success: true, status: 'APPROVED', affinityCount: entries.length };
  });
}
