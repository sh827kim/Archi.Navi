/**
 * POST /api/domains/discover — Phase 1 도메인 발견 트리거 (수동, in-memory)
 * body: { workspaceId }
 * 응답: { success, data: { candidates: DomainCandidate[] } }
 *
 * 결정적 클러스터링 + 관계 응집도 + (LLM 키 있으면) LLM 검토.
 * 후보는 DB 에 저장되지 않음 — 사용자가 승인할 때만 별도 라우트가 영구화한다.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
    codeArtifacts,
    getDb,
    interactionIntents,
    objectRelations,
    objects,
} from '@archi-navi/db';
import {
    computeImplementingServices,
    runDomainDiscovery,
} from '@archi-navi/inference';
import { OBJECT_TYPES } from '@archi-navi/shared';
import type {
    DiscoveryCodeArtifactInput,
    DiscoveryInputs,
    DiscoveryIntentInput,
    DiscoveryObjectInput,
    DiscoveryRelationInput,
} from '@archi-navi/inference';
import {
    createGenerateDomainReviewFn,
    getInferenceModel,
} from '@/lib/inference-llm';

const DISCOVERY_PREREQUISITE_OBJECT_TYPES = OBJECT_TYPES.filter(
    (objectType) => objectType !== 'service' && objectType !== 'domain',
);

function normalizeRequiredString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

export async function POST(req: Request) {
    try {
        let parsedBody: unknown;
        try {
            parsedBody = await req.json();
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    error: { code: 'BAD_REQUEST', message: '유효한 JSON body 가 필요합니다.' },
                },
                { status: 400 },
            );
        }
        if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
            return NextResponse.json(
                {
                    success: false,
                    error: { code: 'BAD_REQUEST', message: '요청 body 는 JSON object 여야 합니다.' },
                },
                { status: 400 },
            );
        }
        const body = parsedBody as { workspaceId?: unknown };
        const workspaceId = normalizeRequiredString(body.workspaceId);
        if (!workspaceId) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'BAD_REQUEST',
                        message: 'workspaceId 는 공백이 아닌 문자열이어야 합니다.',
                    },
                },
                { status: 400 },
            );
        }

        const db = await getDb();

        // Precondition — 초기 scan 만 돌리고 inference 를 안 돌리면 service row 만 존재한다.
        // 이 상태에서 service 를 제외하면 후보 풀이 비어버리므로 명시적으로 실패시켜
        // 사용자에게 원인을 안내한다.
        const nonServiceCountRows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(objects)
            .where(
                and(
                    eq(objects.workspaceId, workspaceId),
                    inArray(objects.objectType, DISCOVERY_PREREQUISITE_OBJECT_TYPES),
                ),
            );
        if ((nonServiceCountRows[0]?.count ?? 0) === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'PREREQUISITE_NOT_MET',
                        message: '도메인 발견 전에 inference 를 먼저 실행해주세요.',
                        hint: { route: '/inference-runs' },
                    },
                },
                { status: 400 },
            );
        }

        // 1. 객체 — domain/service 타입은 제외
        //    domain: 논리 단위이므로 멤버 후보가 될 수 없음
        //    service: 물리 구현 매체이므로 도메인 멤버가 아님
        const objectRows = await db
            .select({
                id: objects.id,
                objectType: objects.objectType,
                name: objects.name,
                displayName: objects.displayName,
                path: objects.path,
                parentId: objects.parentId,  // 서비스 계층 추적을 위해 추가
            })
            .from(objects)
            .where(eq(objects.workspaceId, workspaceId));

        const memberObjects: DiscoveryObjectInput[] = objectRows
            .filter((o) => o.objectType !== 'domain' && o.objectType !== 'service')
            .map((o) => ({
                id: o.id,
                objectType: o.objectType,
                name: o.name,
                displayName: o.displayName,
                path: o.path,
            }));

        // 2. 인텐트 — externalPath/route/topic 신호용
        //    CLOSED_ATOMIC 상태만 신뢰할 수 있음. NEW/RESOLVING/FRONTIER 는 미해결 추론,
        //    REJECTED 는 명시적으로 제거된 신호이므로 도메인 클러스터링 입력에 제외.
        const intentRows = await db
            .select({
                sourceServiceId: interactionIntents.sourceServiceId,
                sourceFunctionId: interactionIntents.sourceFunctionId,
                intentType: interactionIntents.intentType,
                externalPathHint: interactionIntents.externalPathHint,
                externalRoutePattern: interactionIntents.externalRoutePattern,
                messageTopicHints: interactionIntents.messageTopicHints,
            })
            .from(interactionIntents)
            .where(
                and(
                    eq(interactionIntents.workspaceId, workspaceId),
                    eq(interactionIntents.status, 'CLOSED_ATOMIC'),
                ),
            );

        const intentInputs: DiscoveryIntentInput[] = intentRows.map((row) => ({
            sourceObjectId: row.sourceFunctionId ?? row.sourceServiceId,
            intentType: row.intentType,
            externalPathHint: row.externalPathHint,
            externalRoutePattern: row.externalRoutePattern,
            messageTopicHints: asStringArray(row.messageTopicHints),
        }));

        // 3. 관계 — APPROVED 만 사용
        const relationRows = await db
            .select({
                subjectObjectId: objectRelations.subjectObjectId,
                objectId: objectRelations.objectId,
                relationType: objectRelations.relationType,
            })
            .from(objectRelations)
            .where(
                and(
                    eq(objectRelations.workspaceId, workspaceId),
                    eq(objectRelations.status, 'APPROVED'),
                ),
            );

        const relationInputs: DiscoveryRelationInput[] = relationRows;

        // 4. codeArtifacts — 패키지/파일 신호 (현재는 입력만, 향후 확장)
        const artifactRows = await db
            .select({
                ownerObjectId: codeArtifacts.ownerObjectId,
                packageName: codeArtifacts.packageName,
                filePath: codeArtifacts.filePath,
            })
            .from(codeArtifacts)
            .where(eq(codeArtifacts.workspaceId, workspaceId));

        const artifactInputs: DiscoveryCodeArtifactInput[] = artifactRows.map((a) => ({
            ownerObjectId: a.ownerObjectId,
            packageName: a.packageName,
            filePath: a.filePath,
        }));

        const discoveryInputs: DiscoveryInputs = {
            workspaceId,
            objects: memberObjects,
            intents: intentInputs,
            relations: relationInputs,
            codeArtifacts: artifactInputs,
        };

        // LLM 검토는 키가 있을 때만 수행. 없으면 review = null 인 후보 반환.
        const modelInfo = getInferenceModel(req);
        const review = modelInfo
            ? createGenerateDomainReviewFn(modelInfo.model, modelInfo.modelName)
            : undefined;

        const result = await runDomainDiscovery({
            inputs: discoveryInputs,
            ...(review ? { review } : {}),
        });

        // 각 candidate 에 implementingServices derived 필드 추가
        // — 멤버 id 집합 기준으로 어느 service 가 구현체인지 집계.
        // 입력 변환(pure 함수용 shape)은 candidate 수와 무관하므로 루프 밖에서 1회.

        // 전체 후보를 스캔해 객체별 primary candidate id 를 결정.
        // runDomainDiscovery 가 이미 primary + secondary(affinity ≥ 0.5) 섞인 members 를 반환하므로,
        // implementingServices 계산에서는 secondary 를 제외해야 한다.
        // (secondary 를 포함하면 같은 service 자식이 여러 후보에서 카운트돼 confidence 과대계산)
        const primaryByObject = new Map<string, { candId: string; affinity: number }>();
        for (const cand of result.candidates) {
            for (const m of cand.members) {
                const cur = primaryByObject.get(m.objectId);
                if (!cur || m.affinity > cur.affinity) {
                    primaryByObject.set(m.objectId, { candId: cand.id, affinity: m.affinity });
                }
            }
        }

        const implServiceObjects = objectRows.map((o) => ({
            id: o.id,
            parentId: o.parentId,
            objectType: o.objectType,
            name: o.name,
        }));
        const candidatesWithImpl = result.candidates.map((cand) => {
            // affinity 최강인 후보에게만 귀속된 primary 멤버 id 만 수집
            const primaryMemberIds = new Set<string>();
            for (const m of cand.members) {
                if (primaryByObject.get(m.objectId)?.candId === cand.id) {
                    primaryMemberIds.add(m.objectId);
                }
            }
            return {
                ...cand,
                implementingServices: computeImplementingServices({
                    objects: implServiceObjects,
                    memberIds: primaryMemberIds,
                }),
            };
        });

        return NextResponse.json({
            success: true,
            data: {
                candidates: candidatesWithImpl,
                llmReviewed: Boolean(modelInfo),
            },
        });
    } catch (error) {
        console.error('[POST /api/domains/discover]', error);
        return NextResponse.json(
            {
                success: false,
                error: { code: 'INTERNAL_ERROR', message: '도메인 발견 중 오류가 발생했습니다.' },
            },
            { status: 500 },
        );
    }
}
