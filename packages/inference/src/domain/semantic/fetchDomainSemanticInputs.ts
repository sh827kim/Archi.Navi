/**
 * 도메인 의미 합성에 필요한 원시 신호를 DB 에서 읽어 CollectorInputs 로 변환한다.
 * 읽기 전용. 쓰기 책임은 상위 오케스트레이터가 진다.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
    evidences,
    interactionIntents,
    objectDomainAffinities,
    objectRelations,
    objects,
} from '@archi-navi/db';
import type {
    CollectorInputs,
    CollectorIntentInput,
    CollectorMemberInput,
    CollectorOtherObject,
    CollectorRelationInput,
} from './types';

export interface FetchDomainSemanticInputsArgs {
    workspaceId: string;
    domainId: string;
}

export class DomainNotFoundError extends Error {
    constructor(domainId: string) {
        super(`domain object not found: ${domainId}`);
    }
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

/**
 * 특정 객체의 "대표 도메인 id" 를 affinity 기준으로 찾는다.
 * 도메인 자체 객체(objectType === 'domain') 는 대표 도메인이 자기 자신이 아닐 수 있어 별도 처리하지 않고
 * objectDomainAffinities 에서 가장 큰 affinity 를 고른다.
 */
function pickPrimaryDomain(affinities: Array<{ objectId: string; domainId: string; affinity: number }>): Map<string, string> {
    const best = new Map<string, { domainId: string; affinity: number }>();
    for (const row of affinities) {
        const prev = best.get(row.objectId);
        if (!prev || row.affinity > prev.affinity) {
            best.set(row.objectId, { domainId: row.domainId, affinity: row.affinity });
        }
    }
    const result = new Map<string, string>();
    for (const [objectId, entry] of best.entries()) {
        result.set(objectId, entry.domainId);
    }
    return result;
}

export async function fetchDomainSemanticInputs(
    db: DbClient,
    args: FetchDomainSemanticInputsArgs,
): Promise<CollectorInputs> {
    const { workspaceId, domainId } = args;

    // 1) 도메인 객체 조회
    const domainRows = await db
        .select({ id: objects.id, name: objects.name, displayName: objects.displayName })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.id, domainId),
                eq(objects.objectType, 'domain'),
            ),
        )
        .limit(1);
    const domainObj = domainRows[0];
    if (!domainObj) throw new DomainNotFoundError(domainId);

    // 2) 멤버 객체: objectDomainAffinities.domainId = domainId
    const memberLinks = await db
        .select({ objectId: objectDomainAffinities.objectId })
        .from(objectDomainAffinities)
        .where(
            and(
                eq(objectDomainAffinities.workspaceId, workspaceId),
                eq(objectDomainAffinities.domainId, domainId),
            ),
        );
    const memberIdList = [...new Set(memberLinks.map((r) => r.objectId))];

    let members: CollectorMemberInput[] = [];
    if (memberIdList.length > 0) {
        const memberRows = await db
            .select({
                id: objects.id,
                name: objects.name,
                displayName: objects.displayName,
                objectType: objects.objectType,
                description: objects.description,
            })
            .from(objects)
            .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, memberIdList)));
        members = memberRows.map((r) => ({
            id: r.id,
            name: r.name,
            displayName: r.displayName,
            objectType: r.objectType,
            description: r.description,
        }));
    }
    const memberIdSet = new Set(members.map((m) => m.id));

    // 3) 멤버가 발신한 intents + 그들의 evidences
    let intents: CollectorIntentInput[] = [];
    if (memberIdSet.size > 0) {
        const intentRows = await db
            .select({
                id: interactionIntents.id,
                sourceServiceId: interactionIntents.sourceServiceId,
                sourceFunctionId: interactionIntents.sourceFunctionId,
                sourceFilePath: interactionIntents.sourceFilePath,
                intentType: interactionIntents.intentType,
                methodHint: interactionIntents.methodHint,
                externalPathHint: interactionIntents.externalPathHint,
                externalRoutePattern: interactionIntents.externalRoutePattern,
                dbTableHints: interactionIntents.dbTableHints,
                dbSchemaHint: interactionIntents.dbSchemaHint,
                messageTopicHints: interactionIntents.messageTopicHints,
                messageQueueHints: interactionIntents.messageQueueHints,
                messageBrokerKind: interactionIntents.messageBrokerKind,
                evidenceIds: interactionIntents.evidenceIds,
            })
            .from(interactionIntents)
            .where(
                and(
                    eq(interactionIntents.workspaceId, workspaceId),
                    inArray(interactionIntents.sourceServiceId, [...memberIdSet]),
                ),
            );

        const allEvidenceIds = [
            ...new Set(intentRows.flatMap((r) => asStringArray(r.evidenceIds))),
        ];
        const evidenceById = new Map<string, {
            id: string;
            filePath: string | null;
            lineStart: number | null;
            lineEnd: number | null;
            excerpt: string | null;
        }>();
        if (allEvidenceIds.length > 0) {
            const evRows = await db
                .select({
                    id: evidences.id,
                    filePath: evidences.filePath,
                    lineStart: evidences.lineStart,
                    lineEnd: evidences.lineEnd,
                    excerpt: evidences.excerpt,
                })
                .from(evidences)
                .where(
                    and(
                        eq(evidences.workspaceId, workspaceId),
                        inArray(evidences.id, allEvidenceIds),
                    ),
                );
            for (const ev of evRows) evidenceById.set(ev.id, ev);
        }

        intents = intentRows.map((row) => ({
            id: row.id,
            sourceObjectId: row.sourceServiceId,
            sourceFunctionId: row.sourceFunctionId,
            sourceFilePath: row.sourceFilePath,
            intentType: row.intentType,
            methodHint: row.methodHint,
            externalPathHint: row.externalPathHint,
            externalRoutePattern: row.externalRoutePattern,
            dbTableHints: asStringArray(row.dbTableHints),
            dbSchemaHint: row.dbSchemaHint,
            messageTopicHints: asStringArray(row.messageTopicHints),
            messageQueueHints: asStringArray(row.messageQueueHints),
            messageBrokerKind: row.messageBrokerKind,
            evidences: asStringArray(row.evidenceIds).flatMap((id) => {
                const ev = evidenceById.get(id);
                if (!ev) return [];
                return [{
                    filePath: ev.filePath,
                    lineStart: ev.lineStart,
                    lineEnd: ev.lineEnd,
                    excerpt: ev.excerpt,
                }];
            }),
        }));
    }

    // 4) 멤버와 연결된 relations (양방향)
    let relations: CollectorRelationInput[] = [];
    if (memberIdSet.size > 0) {
        const memberIdsArr = [...memberIdSet];
        const relationRows = await db
            .select({
                id: objectRelations.id,
                subjectObjectId: objectRelations.subjectObjectId,
                objectId: objectRelations.objectId,
                relationType: objectRelations.relationType,
            })
            .from(objectRelations)
            .where(
                and(
                    eq(objectRelations.workspaceId, workspaceId),
                    or(
                        inArray(objectRelations.subjectObjectId, memberIdsArr),
                        inArray(objectRelations.objectId, memberIdsArr),
                    ),
                ),
            );
        relations = relationRows.map((r) => ({
            id: r.id,
            subjectObjectId: r.subjectObjectId,
            objectId: r.objectId,
            relationType: r.relationType,
        }));
    }

    // 5) objectsById lookup: members + relation 상대편
    const externalIds = new Set<string>();
    for (const rel of relations) {
        if (!memberIdSet.has(rel.subjectObjectId)) externalIds.add(rel.subjectObjectId);
        if (!memberIdSet.has(rel.objectId)) externalIds.add(rel.objectId);
    }

    const objectsById: Record<string, CollectorOtherObject> = {};
    for (const m of members) {
        objectsById[m.id] = {
            id: m.id,
            name: m.name,
            displayName: m.displayName,
            objectType: m.objectType,
            domainId, // 멤버는 이 도메인 소속
        };
    }

    if (externalIds.size > 0) {
        const extIdsArr = [...externalIds];
        const extRows = await db
            .select({
                id: objects.id,
                name: objects.name,
                displayName: objects.displayName,
                objectType: objects.objectType,
            })
            .from(objects)
            .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, extIdsArr)));

        const affinityRows = await db
            .select({
                objectId: objectDomainAffinities.objectId,
                domainId: objectDomainAffinities.domainId,
                affinity: objectDomainAffinities.affinity,
            })
            .from(objectDomainAffinities)
            .where(
                and(
                    eq(objectDomainAffinities.workspaceId, workspaceId),
                    inArray(objectDomainAffinities.objectId, extIdsArr),
                ),
            );
        const primaryDomainByObject = pickPrimaryDomain(affinityRows);

        for (const row of extRows) {
            objectsById[row.id] = {
                id: row.id,
                name: row.name,
                displayName: row.displayName,
                objectType: row.objectType,
                domainId: primaryDomainByObject.get(row.id) ?? null,
            };
        }
    }

    return {
        domainId,
        domainName: domainObj.displayName ?? domainObj.name,
        members,
        intents,
        relations,
        objectsById,
    };
}
