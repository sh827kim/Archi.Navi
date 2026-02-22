/**
 * Domain Candidate 승인/거부 처리
 * 승인 시 → object_domain_affinities upsert (APPROVED_INFERENCE)
 * 거부 시 → status = REJECTED, 추가 처리 없음
 */
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { domainCandidates, objectDomainAffinities } from '@archi-navi/db';

export interface ApproveDomainCandidateResult {
    success: boolean;
    status: 'APPROVED' | 'REJECTED';
    /** 승인 시 생성/갱신된 affinities 수 */
    affinityCount: number;
}

/**
 * Domain Candidate 승인/거부
 * @param db DB 클라이언트
 * @param candidateId domain_candidates.id
 * @param action 'APPROVED' | 'REJECTED'
 */
export async function approveDomainCandidate(
    db: DbClient,
    candidateId: string,
    action: 'APPROVED' | 'REJECTED',
): Promise<ApproveDomainCandidateResult> {
    // 후보 조회
    const [candidate] = await db
        .select()
        .from(domainCandidates)
        .where(eq(domainCandidates.id, candidateId))
        .limit(1);

    if (!candidate) {
        throw new Error('candidate not found');
    }

    const reviewedAt = new Date();

    // 상태 업데이트
    await db
        .update(domainCandidates)
        .set({ status: action, reviewedAt })
        .where(eq(domainCandidates.id, candidateId));

    // 거부 시 종료
    if (action === 'REJECTED') {
        return { success: true, status: 'REJECTED', affinityCount: 0 };
    }

    // 승인: affinityMap → object_domain_affinities upsert
    const affinityMap = (candidate.affinityMap ?? {}) as Record<string, number>;
    const entries = Object.entries(affinityMap);

    if (entries.length === 0) {
        return { success: true, status: 'APPROVED', affinityCount: 0 };
    }

    const purity = candidate.purity;

    for (const [domainId, affinity] of entries) {
        await db
            .insert(objectDomainAffinities)
            .values({
                workspaceId: candidate.workspaceId,
                objectId: candidate.objectId,
                domainId,
                affinity,
                confidence: purity,
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
}
