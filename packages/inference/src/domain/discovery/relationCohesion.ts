/**
 * 관계 응집도 — 후보 멤버 객체의 outgoing/incoming 관계 중 후보 멤버 집합 내부로 향하는 비율을 계산한다.
 *
 * 결과는 각 멤버의 relationCohesion (0~1) 에 채워진다.
 * 관계가 0건인 객체는 cohesion 0 으로 둔다 — "같은 도메인에 묶여야 한다는 신호 자체가 없다" 는 의미.
 *
 * confidence 정의:
 *   confidence = 후보 평균 relationCohesion
 *   (후보 단위. UI 에 표시되는 후보 단위 신뢰도이며, 멤버별 cohesion 은 상세 검수용)
 */
import type { CandidateMemberScore, DiscoveryRelationInput } from './types';

export interface RelationCohesionInput {
    /** 후보 멤버 점수 (structuralClustering 산출물) — relationCohesion 은 0 으로 들어옴 */
    members: CandidateMemberScore[];
    relations: DiscoveryRelationInput[];
}

export interface RelationCohesionResult {
    members: CandidateMemberScore[];
    /** 후보 평균 응집도 (멤버 cohesion 평균) — confidence 후보값 */
    candidateConfidence: number;
}

/**
 * 후보 멤버 + 전체 관계 → 멤버별 cohesion 채워서 반환.
 */
export function computeRelationCohesion(input: RelationCohesionInput): RelationCohesionResult {
    const memberIds = new Set(input.members.map((m) => m.objectId));

    const enriched = input.members.map((member) => {
        const cohesion = computeMemberCohesion(member.objectId, memberIds, input.relations);
        return {
            ...member,
            relationCohesion: round3(cohesion),
        };
    });

    const total = enriched.reduce((sum, m) => sum + m.relationCohesion, 0);
    const avg = enriched.length === 0 ? 0 : total / enriched.length;

    return {
        members: enriched,
        candidateConfidence: round3(avg),
    };
}

function computeMemberCohesion(
    objectId: string,
    memberIds: Set<string>,
    relations: DiscoveryRelationInput[],
): number {
    let total = 0;
    let inner = 0;
    for (const rel of relations) {
        if (rel.subjectObjectId === objectId) {
            total += 1;
            if (memberIds.has(rel.objectId)) inner += 1;
        } else if (rel.objectId === objectId) {
            total += 1;
            if (memberIds.has(rel.subjectObjectId)) inner += 1;
        }
    }
    if (total === 0) return 0;
    return inner / total;
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
