/**
 * POST /api/domains/approve — 발견된 후보 승인
 * body: { workspaceId, name, primaryMembers: [{objectId, affinity, confidence}], secondaryMembers: [...] }
 *
 * 동작:
 *  1. domain 타입 Object 생성 (path = "/domain/<slug>")
 *  2. primaryMembers + secondaryMembers 를 objectDomainAffinities 에 upsert (source='APPROVED_INFERENCE')
 *  3. 응답: { success, data: { domainId, memberCount } }
 *
 * 같은 객체-도메인 쌍이 이미 있으면 affinity/confidence 만 갱신.
 */
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb, objectDomainAffinities, objects } from '@archi-navi/db';

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

        const db = await getDb();

        // primary + secondary 를 한 번에 upsert 대상으로 묶는다.
        const allMembers = [
            ...primary.map((m) => ({ ...m, isPrimary: true })),
            ...secondary.map((m) => ({ ...m, isPrimary: false })),
        ];

        // 도메인 생성 + affinity upsert 는 하나의 트랜잭션으로 묶어
        // 중간 실패 시 고아 도메인/부분 affinity 가 남지 않도록 한다.
        const { domainId } = await db.transaction(async (tx) => {
            // 1. 도메인 Object 생성
            const [domain] = await tx
                .insert(objects)
                .values({
                    workspaceId,
                    objectType: 'domain',
                    category: 'COMPUTE',
                    granularity: 'COMPOUND',
                    name,
                    displayName: name,
                    path: `/domain/${slug}`,
                    depth: 1,
                })
                .returning({ id: objects.id });

            if (!domain) {
                throw new Error('도메인 객체 생성 실패');
            }

            // 2. affinity upsert — primary + secondary 를 한 번에
            for (const member of allMembers) {
                await tx
                    .insert(objectDomainAffinities)
                    .values({
                        workspaceId,
                        objectId: member.objectId,
                        domainId: domain.id,
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

            return { domainId: domain.id };
        });

        return NextResponse.json({
            success: true,
            data: {
                domainId,
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
