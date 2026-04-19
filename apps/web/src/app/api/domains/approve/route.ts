/**
 * POST /api/domains/approve — 발견된 후보 승인
 * body: { workspaceId, name, primaryMembers: [{objectId, affinity, confidence}], secondaryMembers: [...] }
 *
 * 동작:
 *  1. 모든 멤버 objectId 가 동일 workspace 소속인지 검증 (테넌트 격리)
 *  2. 같은 (workspace, /domain/<slug>) path 의 도메인이 이미 있으면 재사용, 없으면 신규 생성
 *  3. primaryMembers + secondaryMembers 를 objectDomainAffinities 에 upsert (source='APPROVED_INFERENCE')
 *  4. 멤버별 DOMAIN_AFFINITY_CHANGED 이벤트로 incremental rollup 발행
 *  5. 응답: { success, data: { domainId, memberCount, reused } }
 *
 * 같은 객체-도메인 쌍이 이미 있으면 affinity/confidence 만 갱신.
 */
import { NextResponse } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, objectDomainAffinities, objects } from '@archi-navi/db';
import {
    applyRollupChanges,
    createDomainAffinityChangedEvent,
} from '@/lib/rollup-change-events';

interface ApprovalMemberPayload {
    objectId: string;
    affinity: number;
    confidence: number;
}

interface ApprovalRequestBody {
    workspaceId?: string;
    name?: string;
    primaryMembers?: ApprovalMemberPayload[];
    secondaryMembers?: ApprovalMemberPayload[];
}

function isMemberPayload(value: unknown): value is ApprovalMemberPayload {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.objectId === 'string'
        && typeof v.affinity === 'number'
        && typeof v.confidence === 'number'
    );
}

export async function POST(req: Request) {
    try {
        const body = (await req.json()) as ApprovalRequestBody;
        if (!body.workspaceId || !body.name) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId, name 은 필수입니다.' } },
                { status: 400 },
            );
        }
        const primary = (body.primaryMembers ?? []).filter(isMemberPayload);
        const secondary = (body.secondaryMembers ?? []).filter(isMemberPayload);

        if (primary.length === 0) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: 'primaryMembers 가 비어있습니다.' } },
                { status: 400 },
            );
        }

        const workspaceId = body.workspaceId;
        const name = body.name;
        const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9가-힣]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const domainPath = `/domain/${slug}`;

        const db = await getDb();

        // primary + secondary 를 한 번에 upsert 대상으로 묶는다.
        const allMembers = [
            ...primary.map((m) => ({ ...m, isPrimary: true })),
            ...secondary.map((m) => ({ ...m, isPrimary: false })),
        ];

        // (P1) 테넌트 격리 — 모든 멤버 objectId 가 본 워크스페이스 소속인지 사전 검증.
        //      object_id FK 는 존재만 보장하므로, 다른 workspace 의 object 가 끼어들면
        //      도메인 분석이 오염될 수 있다.
        const memberIds = Array.from(new Set(allMembers.map((m) => m.objectId)));
        const ownedRows = await db
            .select({ id: objects.id })
            .from(objects)
            .where(
                and(eq(objects.workspaceId, workspaceId), inArray(objects.id, memberIds)),
            );
        if (ownedRows.length !== memberIds.length) {
            const ownedSet = new Set(ownedRows.map((row) => row.id));
            const foreign = memberIds.filter((id) => !ownedSet.has(id));
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        code: 'FORBIDDEN_MEMBER',
                        message: '워크스페이스에 속하지 않는 멤버 객체가 포함되어 있습니다.',
                        foreignObjectIds: foreign,
                    },
                },
                { status: 403 },
            );
        }

        // 도메인 조회/생성 + affinity upsert 는 하나의 트랜잭션으로 묶어
        // 중간 실패 시 고아 도메인/부분 affinity 가 남지 않도록 한다.
        const { domainId, reused } = await db.transaction(async (tx) => {
            // (P2) 같은 (workspace, /domain/<slug>) 가 이미 있으면 재사용.
            //      반복 발견·승인 시 동일 도메인이 중복 생성돼 카드와 분석이 분기되는 문제 방지.
            const existing = await tx
                .select({ id: objects.id })
                .from(objects)
                .where(
                    and(
                        eq(objects.workspaceId, workspaceId),
                        eq(objects.path, domainPath),
                        eq(objects.objectType, 'domain'),
                    ),
                )
                .limit(1);

            let domainObjectId: string;
            let didReuse = false;
            if (existing[0]) {
                domainObjectId = existing[0].id;
                didReuse = true;
            } else {
                const [created] = await tx
                    .insert(objects)
                    .values({
                        workspaceId,
                        objectType: 'domain',
                        category: 'COMPUTE',
                        granularity: 'COMPOUND',
                        name,
                        displayName: name,
                        path: domainPath,
                        depth: 1,
                    })
                    .returning({ id: objects.id });
                if (!created) {
                    throw new Error('도메인 객체 생성 실패');
                }
                domainObjectId = created.id;
            }

            // affinity upsert — primary + secondary 를 한 번에
            for (const member of allMembers) {
                await tx
                    .insert(objectDomainAffinities)
                    .values({
                        workspaceId,
                        objectId: member.objectId,
                        domainId: domainObjectId,
                        affinity: member.affinity,
                        confidence: member.confidence,
                        source: 'APPROVED_INFERENCE',
                    })
                    .onConflictDoUpdate({
                        target: [
                            objectDomainAffinities.workspaceId,
                            objectDomainAffinities.objectId,
                            objectDomainAffinities.domainId,
                        ],
                        set: {
                            affinity: member.affinity,
                            confidence: member.confidence,
                            source: 'APPROVED_INFERENCE',
                            updatedAt: sql`now()`,
                        },
                    });
            }

            return { domainId: domainObjectId, reused: didReuse };
        });

        // (P1) incremental rollup 발행 — 멤버별 DOMAIN_AFFINITY_CHANGED 이벤트.
        //      도메인-도메인 의존도 등 rollup 기반 화면이 즉시 반영되도록 한다.
        //      트랜잭션 외부에서 호출 — affinity row 가 커밋된 뒤에 rebuild 가 실행돼야
        //      generation meta 에 일관된 상태가 기록된다.
        await applyRollupChanges(
            db,
            workspaceId,
            allMembers.map((member) => createDomainAffinityChangedEvent(member.objectId, domainId)),
        );

        return NextResponse.json({
            success: true,
            data: {
                domainId,
                reused,
                memberCount: allMembers.length,
                primaryCount: primary.length,
                secondaryCount: secondary.length,
            },
        });
    } catch (error) {
        console.error('[POST /api/domains/approve]', error);
        return NextResponse.json(
            {
                success: false,
                error: { code: 'INTERNAL_ERROR', message: '도메인 승인 중 오류가 발생했습니다.' },
            },
            { status: 500 },
        );
    }
}
