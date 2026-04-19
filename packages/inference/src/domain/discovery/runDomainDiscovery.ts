/**
 * Phase 1 도메인 발견 오케스트레이터.
 * 결정적 클러스터링 → 관계 응집도 → LLM 검토 → primary/secondary 결정 순으로 후보를 풍부화한다.
 *
 * 점수 규칙 (witty-roaming-pudding 계획서):
 *  - affinity   = (pathPrefixMatch + routePrefixMatch + topicPrefixMatch + nameTokenJaccard) / 4
 *  - confidence = relationCohesion (멤버 단위)
 *  - 멤버 채택 임계값: affinity ≥ 0.25
 *  - 한 객체가 여러 후보에서 0.25 이상이면 affinity 가장 높은 곳을 primary
 *  - secondary 는 affinity ≥ 0.5 일 때만 함께 보존
 *
 * LLM reviewer 가 주입되지 않으면 review 는 null 로 둔다 (테스트/오프라인 발견).
 */
import { computeRelationCohesion } from './relationCohesion';
import { reviewDomainCandidate } from './llmReviewer';
import type { GenerateDomainReviewFn } from './llmReviewer';
import { runStructuralClustering } from './structuralClustering';
import type {
    CandidateMemberScore,
    DiscoveryInputs,
    DomainCandidate,
} from './types';

export const SECONDARY_AFFINITY_THRESHOLD = 0.5;

export interface RunDomainDiscoveryArgs {
    inputs: DiscoveryInputs;
    /** LLM 검토를 건너뛰려면 undefined 로 호출 */
    review?: GenerateDomainReviewFn;
}

export interface RunDomainDiscoveryResult {
    candidates: DomainCandidate[];
}

export async function runDomainDiscovery(
    args: RunDomainDiscoveryArgs,
): Promise<RunDomainDiscoveryResult> {
    // 1. 결정적 클러스터링 — affinity 만 채워진 초기 멤버 집합
    const { candidates: structural } = runStructuralClustering(args.inputs);

    // 2. primary/secondary 결정 — 후보별 멤버 목록 1차 확정
    //    cohesion 은 아직 계산하지 않는다. 최종 멤버 집합이 확정된 뒤 계산해야
    //    "내부 관계 비율" 이 후보의 실제 멤버를 기준으로 맞춰진다.
    const primaryByObject = new Map<string, { slug: string; affinity: number }>();
    for (const cand of structural) {
        for (const member of cand.members) {
            const current = primaryByObject.get(member.objectId);
            if (!current || member.affinity > current.affinity) {
                primaryByObject.set(member.objectId, { slug: cand.slug, affinity: member.affinity });
            }
        }
    }

    const filtered = structural
        .map((cand) => {
            const members: CandidateMemberScore[] = cand.members.filter((member) => {
                const primary = primaryByObject.get(member.objectId);
                if (!primary) return false;
                if (primary.slug === cand.slug) return true;
                // secondary: affinity ≥ 0.5 일 때만 보존
                return member.affinity >= SECONDARY_AFFINITY_THRESHOLD;
            });
            return { ...cand, members };
        })
        .filter((cand) => cand.members.length > 0);

    // 3. 관계 응집도 계산 — 최종 멤버 집합 기준으로 cohesion 채움
    const finalCandidates: DomainCandidate[] = filtered.map((cand) => {
        const { members } = computeRelationCohesion({
            members: cand.members,
            relations: args.inputs.relations,
        });
        return {
            id: cand.slug,
            autoName: cand.autoName,
            signals: cand.signals,
            members,
            review: null,
        } satisfies DomainCandidate;
    });

    // 4. LLM 검토 (선택) — 후보별 호출은 독립적으로 격리한다.
    //    한 후보의 provider 오류(타임아웃/rate-limit/invalid key 등)가 결정적 발견 결과 전체를
    //    날리지 않도록, 실패한 후보만 review = null 로 두고 나머지는 정상 채움.
    if (args.review) {
        const generate = args.review;
        const objectNameById = buildObjectNameLookup(args.inputs);
        const allIds = finalCandidates.map((c) => c.id);
        for (const cand of finalCandidates) {
            try {
                cand.review = await reviewDomainCandidate(
                    {
                        candidate: {
                            slug: cand.id,
                            autoName: cand.autoName,
                            signals: cand.signals,
                            members: cand.members,
                        },
                        objectNameById,
                        siblingCandidateIds: allIds,
                    },
                    generate,
                );
            } catch (error) {
                console.warn(
                    `[runDomainDiscovery] LLM review failed for candidate "${cand.id}", continuing without review`,
                    error,
                );
                cand.review = null;
            }
        }
    }

    return { candidates: finalCandidates };
}

function buildObjectNameLookup(inputs: DiscoveryInputs): Map<string, string> {
    const map = new Map<string, string>();
    for (const obj of inputs.objects) {
        map.set(obj.id, obj.displayName ?? obj.name);
    }
    return map;
}
