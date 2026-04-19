/**
 * 도메인 의미 추출용 신호 수집기 (순수 함수)
 * interaction_intents + object_relations 를 도메인 단위로 묶어 LLM 합성기 입력 형태로 정규화한다.
 */
import type { DomainSemanticEvidence } from '@archi-navi/shared';
import type {
    ActionCandidate,
    CollaboratorCandidate,
    CollectedSemanticSignals,
    CollectorInputs,
    CollectorIntentInput,
    DbAccessCandidate,
    EventCandidate,
} from './types';

/**
 * intent 의 evidence 배열을 통합 evidence 풀에 등록하고, 사용 가능한 id 목록을 반환한다.
 * 같은 (filePath, startLine, endLine) 조합은 dedupe 한다.
 */
function registerEvidences(
    pool: Map<string, DomainSemanticEvidence>,
    intent: CollectorIntentInput,
): string[] {
    const ids: string[] = [];
    for (const ev of intent.evidences) {
        if (!ev.filePath) continue;
        const key = `${ev.filePath}:${ev.lineStart ?? ''}-${ev.lineEnd ?? ''}`;
        let entry = pool.get(key);
        if (!entry) {
            entry = {
                id: `ev-${pool.size + 1}`,
                filePath: ev.filePath,
                ...(ev.lineStart != null ? { startLine: ev.lineStart } : {}),
                ...(ev.lineEnd != null ? { endLine: ev.lineEnd } : {}),
                ...(ev.excerpt ? { excerpt: ev.excerpt } : {}),
                sourceObjectId: intent.sourceObjectId,
            };
            pool.set(key, entry);
        }
        ids.push(entry.id);
    }
    return ids;
}

function buildHttpAction(intent: CollectorIntentInput, evidenceIds: string[]): ActionCandidate | null {
    const method = intent.methodHint?.toUpperCase();
    const path = intent.externalPathHint ?? intent.externalRoutePattern;
    if (!path && !method) return null;
    const name = [method ?? 'HTTP', path ?? '(unknown path)'].join(' ');
    return {
        name,
        trigger: 'http',
        ...(method ? { method } : {}),
        ...(path ? { path } : {}),
        sourceObjectId: intent.sourceObjectId,
        evidenceIds,
    };
}

function buildMessageEvents(
    intent: CollectorIntentInput,
    evidenceIds: string[],
    direction: 'publish' | 'consume',
): EventCandidate[] {
    const channels = [...intent.messageTopicHints, ...intent.messageQueueHints].filter((c) => c.length > 0);
    if (channels.length === 0) return [];
    return channels.map((channel) => ({
        name: channel,
        direction,
        channel,
        sourceObjectId: intent.sourceObjectId,
        evidenceIds,
    }));
}

/**
 * 같은 후보가 여러 intent 에서 반복될 때 evidenceIds 를 누적하기 위한 키 생성기.
 */
function actionKey(a: ActionCandidate): string {
    return `${a.trigger}|${a.method ?? ''}|${a.path ?? ''}|${a.channel ?? ''}|${a.sourceObjectId}`;
}
function eventKey(e: EventCandidate): string {
    return `${e.direction}|${e.channel}|${e.sourceObjectId}`;
}
function dbKey(d: DbAccessCandidate): string {
    return `${d.schema ?? ''}|${d.table}|${d.sourceObjectId}`;
}
function collabKey(c: CollaboratorCandidate): string {
    return `${c.targetObjectId}|${c.relationType}`;
}

function mergeUnique<T extends { evidenceIds: string[] }>(
    bucket: Map<string, T>,
    key: string,
    next: T,
): void {
    const existing = bucket.get(key);
    if (!existing) {
        bucket.set(key, next);
        return;
    }
    const merged = new Set([...existing.evidenceIds, ...next.evidenceIds]);
    existing.evidenceIds = [...merged];
}

export function collectDomainSemanticSignals(inputs: CollectorInputs): CollectedSemanticSignals {
    const memberIds = new Set(inputs.members.map((m) => m.id));
    const evidencePool = new Map<string, DomainSemanticEvidence>();

    const actionsBucket = new Map<string, ActionCandidate>();
    const eventsBucket = new Map<string, EventCandidate>();
    const collabsBucket = new Map<string, CollaboratorCandidate>();
    const dbBucket = new Map<string, DbAccessCandidate>();

    for (const intent of inputs.intents) {
        if (!memberIds.has(intent.sourceObjectId)) continue;
        const evidenceIds = registerEvidences(evidencePool, intent);

        switch (intent.intentType) {
            case 'http_gateway_route': {
                const action = buildHttpAction(intent, evidenceIds);
                if (action) mergeUnique(actionsBucket, actionKey(action), action);
                break;
            }
            case 'message_publish': {
                for (const ev of buildMessageEvents(intent, evidenceIds, 'publish')) {
                    mergeUnique(eventsBucket, eventKey(ev), ev);
                }
                break;
            }
            case 'message_consume': {
                for (const ev of buildMessageEvents(intent, evidenceIds, 'consume')) {
                    mergeUnique(eventsBucket, eventKey(ev), ev);
                }
                break;
            }
            case 'db_access': {
                for (const table of intent.dbTableHints) {
                    if (!table) continue;
                    const candidate: DbAccessCandidate = {
                        table,
                        schema: intent.dbSchemaHint,
                        sourceObjectId: intent.sourceObjectId,
                        evidenceIds,
                    };
                    mergeUnique(dbBucket, dbKey(candidate), candidate);
                }
                break;
            }
            default:
                break;
        }
    }

    for (const rel of inputs.relations) {
        const isMemberSubject = memberIds.has(rel.subjectObjectId);
        const isMemberObject = memberIds.has(rel.objectId);
        // 도메인 외부로 향하거나 외부에서 들어오는 관계만 협력으로 본다.
        // 내부(member→member) 는 도메인 응집을 나타낼 뿐 협력이 아님.
        if (isMemberSubject === isMemberObject) continue;

        const externalId = isMemberSubject ? rel.objectId : rel.subjectObjectId;
        const externalObj = inputs.objectsById[externalId];
        if (!externalObj) continue;

        const candidate: CollaboratorCandidate = {
            targetObjectId: externalObj.id,
            targetName: externalObj.displayName ?? externalObj.name,
            targetDomainId: externalObj.domainId,
            relationType: rel.relationType,
            reason: isMemberSubject
                ? `도메인 내 객체가 ${externalObj.name} 으로 ${rel.relationType} 관계를 가짐`
                : `${externalObj.name} 가 도메인 내 객체로 ${rel.relationType} 관계를 가짐`,
            evidenceIds: [],
        };
        mergeUnique(collabsBucket, collabKey(candidate), candidate);
    }

    return {
        domainId: inputs.domainId,
        domainName: inputs.domainName,
        members: inputs.members,
        actions: [...actionsBucket.values()],
        events: [...eventsBucket.values()],
        collaborators: [...collabsBucket.values()],
        dbAccesses: [...dbBucket.values()],
        evidence: [...evidencePool.values()],
    };
}
