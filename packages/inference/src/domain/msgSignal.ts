/**
 * Message 시그널 추출기
 * topic object의 네이밍 패턴을 분석하고 producer/consumer 결합도를 계산하여
 * 서비스별 msgScore(도메인별 원시 점수)를 반환한다.
 *
 * 설계 참조: docs/03-inference-engine.md §3.3 Message Signals
 */
import { eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects, objectRelations, relationCandidates } from '@archi-navi/db';
import { matchDomainByPrefix } from '../db/dbSchemaSignal';

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 토픽 이름에서 도메인 prefix 추출
 * 구분자 우선순위: '.' → '-' → '_'
 *
 * 예시:
 *   order.created   → order
 *   order-created   → order
 *   order_created   → order
 *   orders          → orders (구분자 없으면 전체)
 */
export function extractTopicPrefix(topicName: string): string {
    const separators = ['.', '-', '_'];
    for (const sep of separators) {
        const idx = topicName.indexOf(sep);
        if (idx > 0) return topicName.substring(0, idx);
    }
    return topicName;
}

// ─── 메인 함수 ────────────────────────────────────────────────────────────────

/**
 * 서비스가 produce/consume하는 토픽들의 네이밍 패턴과 결합도를 분석하여
 * 각 도메인에 대한 원시 점수(raw count)를 반환한다.
 *
 * 알고리즘:
 * 1. 승인된(object_relations) + 대기 중인(relation_candidates) produce/consume 관계 조회
 * 2. 각 토픽명에서 prefix 추출 → 도메인 매칭 → 점수 누적
 * 3. 같은 도메인에서 produce + consume 양방향 참여 시 결합도 가산점(+0.5)
 *
 * @param db - DB 클라이언트
 * @param serviceId - 서비스 object ID
 * @param domains - 도메인 목록
 * @param workspaceId - 워크스페이스 ID
 * @returns domainId → raw score 맵
 */
export async function computeMsgScores(
    db: DbClient,
    serviceId: string,
    domains: { id: string; name: string }[],
    workspaceId: string,
): Promise<Record<string, number>> {
    if (domains.length === 0) return {};

    // 1a. 승인된 produce/consume 관계 조회
    const approvedRelations = await db
        .select({
            objectId: objectRelations.objectId,
            relationType: objectRelations.relationType,
        })
        .from(objectRelations)
        .where(
            and(
                eq(objectRelations.workspaceId, workspaceId),
                eq(objectRelations.subjectObjectId, serviceId),
                inArray(objectRelations.relationType, ['produce', 'consume']),
            ),
        );

    // 1b. 대기 중인 produce/consume 후보 조회
    const pendingRelations = await db
        .select({
            objectId: relationCandidates.objectId,
            relationType: relationCandidates.relationType,
        })
        .from(relationCandidates)
        .where(
            and(
                eq(relationCandidates.workspaceId, workspaceId),
                eq(relationCandidates.subjectObjectId, serviceId),
                inArray(relationCandidates.relationType, ['produce', 'consume']),
                eq(relationCandidates.status, 'PENDING'),
            ),
        );

    // 2. relationType별 topicId 집합 구성
    const produceTopicIds = new Set<string>();
    const consumeTopicIds = new Set<string>();

    for (const r of [...approvedRelations, ...pendingRelations]) {
        if (r.relationType === 'produce') produceTopicIds.add(r.objectId);
        else consumeTopicIds.add(r.objectId);
    }

    const allTopicIds = [...new Set([...produceTopicIds, ...consumeTopicIds])];
    if (allTopicIds.length === 0) return {};

    // 3. 토픽 object 조회 (topic 타입만 필터)
    const topics = await db
        .select({ id: objects.id, name: objects.name })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.objectType, 'topic'),
                inArray(objects.id, allTopicIds),
            ),
        );

    if (topics.length === 0) return {};

    // 4. 토픽명 prefix → 도메인 매칭 + 점수 누적
    const scores: Record<string, number> = {};
    // 결합도 계산을 위한 도메인별 방향 추적
    const domainHasProduce: Record<string, boolean> = {};
    const domainHasConsume: Record<string, boolean> = {};

    for (const topic of topics) {
        const prefix = extractTopicPrefix(topic.name);
        const domainId = matchDomainByPrefix(prefix, domains);
        if (!domainId) continue;

        scores[domainId] = (scores[domainId] ?? 0) + 1;

        if (produceTopicIds.has(topic.id)) domainHasProduce[domainId] = true;
        if (consumeTopicIds.has(topic.id)) domainHasConsume[domainId] = true;
    }

    // 5. Producer/Consumer 결합도 가산점
    // 같은 도메인에 produce + consume 양방향으로 참여하면 결합도가 높으므로 +0.5
    for (const domainId of Object.keys(scores)) {
        if (domainHasProduce[domainId] && domainHasConsume[domainId]) {
            scores[domainId] = (scores[domainId] ?? 0) + 0.5;
        }
    }

    return scores;
}
