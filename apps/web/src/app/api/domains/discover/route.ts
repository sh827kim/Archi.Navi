/**
 * POST /api/domains/discover — Phase 1 도메인 발견 트리거 (수동, in-memory)
 * body: { workspaceId }
 * 응답: { success, data: { candidates: DomainCandidate[] } }
 *
 * 결정적 클러스터링 + 관계 응집도 + (LLM 키 있으면) LLM 검토.
 * 후보는 DB 에 저장되지 않음 — 사용자가 승인할 때만 별도 라우트가 영구화한다.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import {
    codeArtifacts,
    getDb,
    interactionIntents,
    objectRelations,
    objects,
} from '@archi-navi/db';
import { runDomainDiscovery } from '@archi-navi/inference';
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

function normalizeRequiredString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: Request) {
    try {
        const body = (await req.json()) as { workspaceId?: unknown };
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

        // 1. 객체 — domain 타입은 제외 (멤버 후보가 될 수 있는 service/function/topic 등만)
        const objectRows = await db
            .select({
                id: objects.id,
                objectType: objects.objectType,
                name: objects.name,
                displayName: objects.displayName,
                path: objects.path,
            })
            .from(objects)
            .where(eq(objects.workspaceId, workspaceId));

        const memberObjects: DiscoveryObjectInput[] = objectRows
            .filter((o) => o.objectType !== 'domain')
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
            messageTopicHints: Array.isArray(row.messageTopicHints)
                ? (row.messageTopicHints as string[])
                : [],
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

        return NextResponse.json({
            success: true,
            data: {
                candidates: result.candidates,
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
