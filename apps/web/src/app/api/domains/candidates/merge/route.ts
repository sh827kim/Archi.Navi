/**
 * POST /api/domains/candidates/merge — discovery 후보 승인 전 수동 병합
 *
 * 발견 후보는 아직 DB 에 저장되지 않는 in-memory 결과이므로, 이 API 는 영속화하지 않는다.
 * 대신 후보 payload 를 검증하고, 중복 멤버/신호/구현 서비스 요약을 병합한 후보를 반환한다.
 * 반환된 후보는 기존 /api/domains/approve 로 승인된다.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, objects } from '@archi-navi/db';

interface CandidateMemberPayload {
    objectId: string;
    pathPrefixMatch: 0 | 1;
    routePrefixMatch: 0 | 1;
    topicPrefixMatch: 0 | 1;
    nameTokenJaccard: number;
    codeFamilyMatch: 0 | 1;
    tableFamilyMatch: 0 | 1;
    seedSources: string[];
    affinity: number;
    relationCohesion: number;
    objectName?: string | undefined;
    objectDisplayName?: string | null | undefined;
    objectPath?: string | undefined;
    objectType?: string | undefined;
}

interface CandidateSignalsPayload {
    topPathPrefix?: string | null;
    topRoutePrefix?: string | null;
    topTopicPrefix?: string | null;
    topCodeFamily?: string | null;
    topTableFamily?: string | null;
    seedSourceSummary?: Array<{ source: string; value: string }>;
}

interface ImplementingServicePayload {
    serviceObjectId: string;
    serviceName: string;
    childInDomain: number;
    childTotal: number;
    confidence: number;
}

interface MergeCandidatePayload {
    id: string;
    autoName: string;
    signals?: CandidateSignalsPayload;
    members: CandidateMemberPayload[];
    implementingServices?: ImplementingServicePayload[];
}

interface MergeRequestBody {
    workspaceId?: unknown;
    name?: unknown;
    candidates?: unknown;
}

function normalizeRequiredString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isValidScore(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isBinaryMatch(value: unknown): value is 0 | 1 {
    return value === 0 || value === 1;
}

function isMemberPayload(value: unknown): value is CandidateMemberPayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
        normalizeRequiredString(record.objectId) !== null
        && isBinaryMatch(record.pathPrefixMatch)
        && isBinaryMatch(record.routePrefixMatch)
        && isBinaryMatch(record.topicPrefixMatch)
        && isValidScore(record.nameTokenJaccard)
        && isBinaryMatch(record.codeFamilyMatch)
        && isBinaryMatch(record.tableFamilyMatch)
        && Array.isArray(record.seedSources)
        && record.seedSources.every((item) => typeof item === 'string')
        && isValidScore(record.affinity)
        && isValidScore(record.relationCohesion)
    );
}

function isCandidatePayload(value: unknown): value is MergeCandidatePayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
        normalizeRequiredString(record.id) !== null
        && typeof record.autoName === 'string'
        && Array.isArray(record.members)
        && record.members.every(isMemberPayload)
    );
}

function collectInvalidCandidateIndexes(values: unknown[]): number[] {
    const invalidIndexes: number[] = [];
    values.forEach((value, index) => {
        if (!isCandidatePayload(value)) invalidIndexes.push(index);
    });
    return invalidIndexes;
}

function maxBinary(a: 0 | 1, b: 0 | 1): 0 | 1 {
    return a === 1 || b === 1 ? 1 : 0;
}

function mergeMembers(candidates: MergeCandidatePayload[]): CandidateMemberPayload[] {
    const byObjectId = new Map<string, CandidateMemberPayload>();

    for (const candidate of candidates) {
        for (const member of candidate.members) {
            const objectId = member.objectId.trim();
            const existing = byObjectId.get(objectId);
            if (!existing) {
                byObjectId.set(objectId, {
                    ...member,
                    objectId,
                    seedSources: uniqueStrings(member.seedSources),
                });
                continue;
            }

            byObjectId.set(objectId, {
                ...existing,
                pathPrefixMatch: maxBinary(existing.pathPrefixMatch, member.pathPrefixMatch),
                routePrefixMatch: maxBinary(existing.routePrefixMatch, member.routePrefixMatch),
                topicPrefixMatch: maxBinary(existing.topicPrefixMatch, member.topicPrefixMatch),
                codeFamilyMatch: maxBinary(existing.codeFamilyMatch, member.codeFamilyMatch),
                tableFamilyMatch: maxBinary(existing.tableFamilyMatch, member.tableFamilyMatch),
                nameTokenJaccard: Math.max(existing.nameTokenJaccard, member.nameTokenJaccard),
                affinity: Math.max(existing.affinity, member.affinity),
                relationCohesion: Math.max(existing.relationCohesion, member.relationCohesion),
                seedSources: uniqueStrings([...existing.seedSources, ...member.seedSources]),
                objectName: existing.objectName ?? member.objectName,
                objectDisplayName: existing.objectDisplayName ?? member.objectDisplayName,
                objectPath: existing.objectPath ?? member.objectPath,
                objectType: existing.objectType ?? member.objectType,
            });
        }
    }

    return Array.from(byObjectId.values()).sort((a, b) => {
        if (b.affinity !== a.affinity) return b.affinity - a.affinity;
        return a.objectId.localeCompare(b.objectId);
    });
}

function mergeSignals(candidates: MergeCandidatePayload[]): Required<CandidateSignalsPayload> {
    const seedSummary: Array<{ source: string; value: string }> = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        for (const seed of candidate.signals?.seedSourceSummary ?? []) {
            if (typeof seed.source !== 'string' || typeof seed.value !== 'string') continue;
            const key = `${seed.source}:${seed.value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            seedSummary.push({ source: seed.source, value: seed.value });
        }
    }

    return {
        topPathPrefix: firstSignal(candidates, 'topPathPrefix'),
        topRoutePrefix: firstSignal(candidates, 'topRoutePrefix'),
        topTopicPrefix: firstSignal(candidates, 'topTopicPrefix'),
        topCodeFamily: firstSignal(candidates, 'topCodeFamily'),
        topTableFamily: firstSignal(candidates, 'topTableFamily'),
        seedSourceSummary: seedSummary.slice(0, 16),
    };
}

function firstSignal(
    candidates: MergeCandidatePayload[],
    key: keyof Omit<CandidateSignalsPayload, 'seedSourceSummary'>,
): string | null {
    for (const candidate of candidates) {
        const value = candidate.signals?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

function mergeImplementingServices(
    candidates: MergeCandidatePayload[],
): ImplementingServicePayload[] {
    const byService = new Map<string, ImplementingServicePayload>();
    for (const candidate of candidates) {
        for (const service of candidate.implementingServices ?? []) {
            const serviceId = normalizeRequiredString(service.serviceObjectId);
            if (!serviceId) continue;
            const existing = byService.get(serviceId);
            if (!existing) {
                byService.set(serviceId, { ...service, serviceObjectId: serviceId });
                continue;
            }
            const childTotal = Math.max(existing.childTotal, service.childTotal);
            const childInDomain = childTotal > 0
                ? Math.min(childTotal, existing.childInDomain + service.childInDomain)
                : Math.max(existing.childInDomain, service.childInDomain);
            byService.set(serviceId, {
                serviceObjectId: serviceId,
                serviceName: existing.serviceName || service.serviceName,
                childInDomain,
                childTotal,
                confidence: childTotal > 0
                    ? childInDomain / childTotal
                    : Math.max(existing.confidence, service.confidence),
            });
        }
    }
    return Array.from(byService.values()).sort((a, b) => b.confidence - a.confidence);
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function slugify(input: string): string {
    return (
        input
            .toLowerCase()
            .replace(/[^a-z0-9가-힣]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'candidate'
    );
}

function buildMergedCandidateId(name: string, candidates: MergeCandidatePayload[]): string {
    const suffix = candidates
        .map((candidate) => slugify(candidate.id))
        .sort()
        .join('-')
        .slice(0, 80);
    return `merged-${suffix || slugify(name)}`;
}

export async function POST(req: Request) {
    try {
        let parsedBody: unknown;
        try {
            parsedBody = await req.json();
        } catch {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: '유효한 JSON body 가 필요합니다.' } },
                { status: 400 },
            );
        }
        if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: '요청 body 는 JSON object 여야 합니다.' } },
                { status: 400 },
            );
        }

        const body = parsedBody as MergeRequestBody;
        const workspaceId = normalizeRequiredString(body.workspaceId);
        const name = normalizeRequiredString(body.name);
        if (!workspaceId || !name) {
            return NextResponse.json(
                {
                    success: false,
                    error: { code: 'BAD_REQUEST', message: 'workspaceId, name 은 공백이 아닌 문자열이어야 합니다.' },
                },
                { status: 400 },
            );
        }
        if (!Array.isArray(body.candidates)) {
            return NextResponse.json(
                { success: false, error: { code: 'INVALID_CANDIDATE_PAYLOAD', message: 'candidates 는 배열이어야 합니다.' } },
                { status: 400 },
            );
        }
        if (body.candidates.length < 2) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: '병합하려면 후보를 2개 이상 선택해야 합니다.' } },
                { status: 400 },
            );
        }

        const invalidCandidateIndexes = collectInvalidCandidateIndexes(body.candidates);
        if (invalidCandidateIndexes.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'INVALID_MEMBER_PAYLOAD',
                        message: 'candidates 에 유효하지 않은 후보 또는 멤버가 포함되어 있습니다.',
                        invalidCandidateIndexes,
                    },
                },
                { status: 400 },
            );
        }

        const candidates = body.candidates as MergeCandidatePayload[];
        const members = mergeMembers(candidates);
        if (members.length === 0) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: '병합된 멤버가 비어있습니다.' } },
                { status: 400 },
            );
        }

        const memberIds = members.map((member) => member.objectId);
        const db = await getDb();
        const ownedRows = await db
            .select({ id: objects.id, objectType: objects.objectType })
            .from(objects)
            .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, memberIds)));

        if (ownedRows.length !== memberIds.length) {
            const ownedSet = new Set(ownedRows.map((row) => row.id));
            const foreignObjectIds = memberIds.filter((id) => !ownedSet.has(id));
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'FORBIDDEN_MEMBER',
                        message: '워크스페이스에 속하지 않는 멤버 객체가 포함되어 있습니다.',
                        foreignObjectIds,
                    },
                },
                { status: 403 },
            );
        }

        const invalidMemberTypes = ownedRows
            .filter((row) => row.objectType === 'domain' || row.objectType === 'service')
            .map((row) => ({ objectId: row.id, objectType: row.objectType }));
        if (invalidMemberTypes.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'INVALID_MEMBER_TYPE',
                        message: 'domain/service 객체는 도메인 멤버로 병합할 수 없습니다.',
                        invalidMemberTypes,
                    },
                },
                { status: 400 },
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                candidate: {
                    id: buildMergedCandidateId(name, candidates),
                    autoName: name,
                    signals: mergeSignals(candidates),
                    members,
                    review: null,
                    implementingServices: mergeImplementingServices(candidates),
                    origin: 'manual_merge',
                    parentCandidateId: null,
                    splitReason: 'manual_merge',
                    splitEvidenceHints: candidates.map((candidate) => candidate.id),
                },
            },
        });
    } catch (error) {
        console.error('[POST /api/domains/candidates/merge]', error);
        return NextResponse.json(
            {
                success: false,
                error: { code: 'INTERNAL_ERROR', message: '도메인 후보 병합 중 오류가 발생했습니다.' },
            },
            { status: 500 },
        );
    }
}
