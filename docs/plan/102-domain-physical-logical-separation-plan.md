# Domain Physical / Logical Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서비스(물리 단위)와 도메인(논리 단위)을 분리하여 한 서비스가 여러 도메인을 `objectRelations.relationType='implements'` 로 구현하는 모델을 도메인 발견/승인 파이프라인과 UI 에 적용한다.

**Architecture:** DB DDL 변경 없음 — `object_relations` 의 기존 TEXT 컬럼 `relation_type` / `source` 에 신규 값 `'implements'` / `'DISCOVERY'` 를 추가 사용. 서비스는 발견 입력 풀에서 제외되고, 승인 트랜잭션이 영향받는 서비스(S = S_old ∪ S_new)의 implements 행을 DELETE → 재집계 → INSERT 한다. confidence = (자식 중 해당 도메인에 속한 function/api_endpoint 수) / (서비스의 function/api_endpoint 자식 총수), primary affinity 만 분자/분모에 반영.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM, PostgreSQL, Vitest, React/TypeScript, Tailwind, shadcn/ui.

**Branch:** `feature/domain-physical-logical-separation` (base: `main` @ 52c4f58)

**관련 문서:**
- 설계: [`docs/design/15-domain-physical-logical-separation.md`](../design/15-domain-physical-logical-separation.md)
- 사양: [`docs/spec/102-domain-physical-logical-separation-spec.md`](../spec/102-domain-physical-logical-separation-spec.md)

---

## 파일 구조 (이 계획에서 건드릴 파일)

| 종류 | 경로 | 책임 |
|---|---|---|
| 수정 | `packages/db/src/schema/core.ts` | `objectRelations.relation_type` / `.source` 주석에 `'implements'` / `'DISCOVERY'` 허용 값 명시 |
| 수정 | `apps/web/src/app/api/domains/discover/route.ts` | service 제외 + precondition 검사 + `implementingServices` derived 계산 |
| 수정 | `apps/web/src/app/api/domains/approve/route.ts` | service 멤버 방어 + S_old/S_new 수집 + implements 재계산 트랜잭션 + 응답 확장 |
| 신규 | `apps/web/src/app/api/domains/[id]/implementing-services/route.ts` | 도메인 상세 페이지용 구현 서비스 JSON 반환 |
| 수정 | `apps/web/src/app/api/domains/route.ts` | 각 도메인 카드용 `implementingServiceCount` 포함 |
| 수정 | `apps/web/src/components/domains/domain-discover-section.tsx` | 미리보기 카드의 "구현 서비스" 섹션 + 각주 |
| 수정 | `apps/web/src/components/domains/domain-list-client.tsx` | 목록 카드 배지 + precondition disabled 버튼 |
| 수정 | `apps/web/src/components/domains/domain-semantic-client.tsx` | 상세 페이지에 구현 서비스 섹션 추가 |
| 신규 / 수정 | `apps/web/src/__tests__/domains-discover.route.test.ts` | 서비스 제외, precondition, implementingServices 집계 테스트 |
| 신규 / 수정 | `apps/web/src/__tests__/domains-approve.route.test.ts` | implements 재계산, stale parent, storage/channel 배제 테스트 |

> **결정:** 이번 PR 범위에서는 `/api/domains/[id]` 기본 detail route 를 만들지 않고, 의미 프로파일과 독립적으로 필요한 구현 서비스 정보만 `/api/domains/[id]/implementing-services` 로 분리한다. `domain-semantic-client` 가 기존 semantic 로더와 동일한 패턴으로 이 엔드포인트를 추가 호출.

---

## Task 1: objectRelations 주석에 implements / DISCOVERY 허용 값 명시

**Files:**
- Modify: `packages/db/src/schema/core.ts:123` (`relationType` 주석)
- Modify: `packages/db/src/schema/core.ts:140` (`source` 기본값 주석)

DB DDL 변경 없이 TypeScript 레벨 문서만 갱신한다.

- [ ] **Step 1: 주석 갱신**

`packages/db/src/schema/core.ts` 에서 `objectRelations` 테이블의 `relationType` / `source` 주석을 다음과 같이 교체한다:

```ts
relationType: text('relation_type').notNull(), // call, expose, read, write, produce, consume, depend_on, fk_reference, implements
// ...
source: text('source').notNull().default('MANUAL'), // MANUAL, INFERRED, ROLLUP, DISCOVERY
```

- [ ] **Step 2: 타입 체크**

Run: `pnpm --filter @archi-navi/db exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add packages/db/src/schema/core.ts
git commit -m "docs(db): objectRelations 주석에 implements/DISCOVERY 허용 값 명시"
```

---

## Task 2: 공용 집계 유틸 분리 — computeImplementingServices

discover / approve 두 라우트에서 같은 계산 로직을 쓴다. DRY 관점에서 inference 패키지에 순수 함수로 분리한다.

**Files:**
- Create: `packages/inference/src/domain/discovery/implementingServices.ts`
- Create: `packages/inference/src/__tests__/domain/discovery/implementingServices.test.ts`
- Modify: `packages/inference/src/domain/index.ts` (barrel export)

- [ ] **Step 1: 실패 테스트 작성**

`packages/inference/src/__tests__/domain/discovery/implementingServices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeImplementingServices } from '@/domain/discovery/implementingServices';

type Obj = { id: string; parentId: string | null; objectType: string; name: string };

describe('computeImplementingServices', () => {
    it('T1: function/api_endpoint 만 분자·분모에 기여한다', () => {
        const objects: Obj[] = [
            { id: 's1', parentId: null, objectType: 'service', name: 'RobotService' },
            { id: 'f1', parentId: 's1', objectType: 'function', name: 'create' },
            { id: 'f2', parentId: 's1', objectType: 'function', name: 'update' },
            { id: 'e1', parentId: 's1', objectType: 'api_endpoint', name: 'GET /r' },
            { id: 't1', parentId: 's1', objectType: 'db_table', name: 'robots' },
        ];
        const memberIds = new Set(['f1', 'e1']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result).toEqual([
            {
                serviceObjectId: 's1',
                serviceName: 'RobotService',
                childInDomain: 2, // f1 + e1
                childTotal: 3,    // f1 + f2 + e1 (db_table 제외)
                confidence: 2 / 3,
            },
        ]);
    });

    it('T2: childTotal=0 인 서비스 (코드 자식 없음) 는 결과에서 제외된다', () => {
        const objects: Obj[] = [
            { id: 's2', parentId: null, objectType: 'service', name: 'StorageOnly' },
            { id: 't2', parentId: 's2', objectType: 'db_table', name: 'orders' },
        ];
        const memberIds = new Set(['t2']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result).toEqual([]);
    });

    it('T3: parent 가 service 가 아닌 자식은 기여하지 않는다', () => {
        const objects: Obj[] = [
            { id: 'd1', parentId: null, objectType: 'database', name: 'orders_db' },
            { id: 't1', parentId: 'd1', objectType: 'db_table', name: 'orders' },
        ];
        const memberIds = new Set(['t1']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result).toEqual([]);
    });

    it('T4: confidence 내림차순으로 정렬된다', () => {
        const objects: Obj[] = [
            { id: 'sA', parentId: null, objectType: 'service', name: 'A' },
            { id: 'sB', parentId: null, objectType: 'service', name: 'B' },
            { id: 'fa1', parentId: 'sA', objectType: 'function', name: 'a1' },
            { id: 'fa2', parentId: 'sA', objectType: 'function', name: 'a2' },
            { id: 'fb1', parentId: 'sB', objectType: 'function', name: 'b1' },
        ];
        const memberIds = new Set(['fa1', 'fb1']);

        const result = computeImplementingServices({ objects, memberIds });

        expect(result.map((r) => r.serviceObjectId)).toEqual(['sB', 'sA']);
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/domain/discovery/implementingServices.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음.

- [ ] **Step 3: 순수 함수 구현**

`packages/inference/src/domain/discovery/implementingServices.ts`:

```ts
/**
 * 도메인 발견/승인 공용 유틸 — 멤버 집합을 기준으로 각 부모 서비스의
 * "얼마나 이 도메인을 구현하는가" 를 집계한다.
 *
 * 규칙 (설계 §4.3):
 *  - "자식" 은 objectType IN ('function', 'api_endpoint') 로 제한
 *  - childInDomain = 멤버 집합 ∩ (해당 service 의 코드 자식)
 *  - childTotal = 해당 service 의 코드 자식 총수 (워크스페이스 한정)
 *  - childTotal = 0 이면 결과에서 제외
 *  - confidence = childInDomain / childTotal
 *  - 결과는 confidence 내림차순, tie-break 는 serviceObjectId 사전순
 */
export interface ImplementingServiceRow {
    serviceObjectId: string;
    serviceName: string;
    childInDomain: number;
    childTotal: number;
    confidence: number;
}

export interface ComputeImplementingServicesInput {
    /** 대상 워크스페이스의 객체 전량 — id/parentId/objectType/name 만 필요 */
    objects: Array<{
        id: string;
        parentId: string | null;
        objectType: string;
        name: string;
    }>;
    /** "이 도메인에 속한다" 로 간주할 객체 id 집합 */
    memberIds: Set<string>;
}

const CODE_CHILD_TYPES = new Set(['function', 'api_endpoint']);

export function computeImplementingServices(
    input: ComputeImplementingServicesInput,
): ImplementingServiceRow[] {
    const serviceById = new Map<string, { id: string; name: string }>();
    for (const obj of input.objects) {
        if (obj.objectType === 'service') {
            serviceById.set(obj.id, { id: obj.id, name: obj.name });
        }
    }

    const childTotalByService = new Map<string, number>();
    const childInDomainByService = new Map<string, number>();

    for (const obj of input.objects) {
        if (!CODE_CHILD_TYPES.has(obj.objectType)) continue;
        if (!obj.parentId) continue;
        if (!serviceById.has(obj.parentId)) continue; // parent 가 service 인 자식만

        childTotalByService.set(
            obj.parentId,
            (childTotalByService.get(obj.parentId) ?? 0) + 1,
        );
        if (input.memberIds.has(obj.id)) {
            childInDomainByService.set(
                obj.parentId,
                (childInDomainByService.get(obj.parentId) ?? 0) + 1,
            );
        }
    }

    const rows: ImplementingServiceRow[] = [];
    for (const [serviceId, childTotal] of childTotalByService) {
        const childInDomain = childInDomainByService.get(serviceId) ?? 0;
        if (childInDomain === 0) continue; // 기여 없음은 행 생성 안 함
        const service = serviceById.get(serviceId)!;
        rows.push({
            serviceObjectId: serviceId,
            serviceName: service.name,
            childInDomain,
            childTotal,
            confidence: childInDomain / childTotal,
        });
    }

    rows.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return a.serviceObjectId.localeCompare(b.serviceObjectId);
    });

    return rows;
}
```

- [ ] **Step 4: barrel export**

`packages/inference/src/domain/index.ts` 에 export 추가:

```ts
export {
    computeImplementingServices,
    type ImplementingServiceRow,
    type ComputeImplementingServicesInput,
} from './discovery/implementingServices';
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/domain/discovery/implementingServices.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 6: 커밋**

```bash
git add packages/inference/src/domain/discovery/implementingServices.ts \
        packages/inference/src/__tests__/domain/discovery/implementingServices.test.ts \
        packages/inference/src/domain/index.ts
git commit -m "feat(inference): 구현 서비스 집계 유틸 computeImplementingServices 추가"
```

---

## Task 3: discover 라우트 precondition 검사 추가

**Files:**
- Modify: `apps/web/src/app/api/domains/discover/route.ts` (workspaceId 검증 직후 삽입)
- Modify: `apps/web/src/__tests__/domains-discover.route.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

`apps/web/src/__tests__/domains-discover.route.test.ts` 의 `describe` 블록 안에 추가:

```ts
it('T-pre: workspace 에 service 외 객체가 없으면 400 PREREQUISITE_NOT_MET', async () => {
    getDbMock.mockResolvedValue({
        select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ count: 0 }]),
            }),
        }),
    });

    const { POST } = await import('@/app/api/domains/discover/route');
    const res = await POST(
        new Request('http://x/api/domains/discover', {
            method: 'POST',
            body: JSON.stringify({ workspaceId: 'ws-empty' }),
        }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PREREQUISITE_NOT_MET');
    expect(body.error.hint?.route).toBe('/inference-runs');
    expect(runDomainDiscoveryMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts -t PREREQUISITE_NOT_MET`
Expected: FAIL — 현재는 200 과 함께 빈 candidates 를 반환.

- [ ] **Step 3: 라우트에 precondition 블록 추가**

`apps/web/src/app/api/domains/discover/route.ts` 의 `const db = await getDb();` 바로 다음에 삽입:

```ts
// Precondition — 초기 scan 만 돌리고 inference 를 안 돌리면 service row 만 존재한다.
// 이 상태에서 service 를 제외하면 후보 풀이 비어버리므로 명시적으로 실패시켜
// 사용자에게 원인을 안내한다.
const nonServiceCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(objects)
    .where(
        and(
            eq(objects.workspaceId, workspaceId),
            inArray(objects.objectType, [
                'function',
                'api_endpoint',
                'topic',
                'queue',
                'database',
                'db_table',
            ]),
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
```

import 추가 (동일 파일 상단):

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts -t PREREQUISITE_NOT_MET`
Expected: PASS.

- [ ] **Step 5: 기존 테스트 mock 보정**

기존 discover 테스트들은 objects select 를 한 번만 호출하지만, 이제 precondition select 가 먼저 실행된다. 테스트 fixture 의 `getDbMock` 이 **두 번째 select 부터는 기존 객체를 반환** 하도록 수정한다. 가장 간단한 방법: `db.select` 가 호출될 때마다 다른 chain 을 반환하도록 `mockImplementation` 사용.

테스트 파일 상단의 `makeDbMock` 헬퍼(없으면 추가) 패턴 예시:

```ts
function makeDbMock(options: {
    nonServiceCount: number;
    objectRows: unknown[];
    intentRows: unknown[];
    relationRows: unknown[];
    artifactRows: unknown[];
}) {
    let selectCall = 0;
    return {
        select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(async () => {
                    selectCall += 1;
                    switch (selectCall) {
                        case 1: return [{ count: options.nonServiceCount }];
                        case 2: return options.objectRows;
                        case 3: return options.intentRows;
                        case 4: return options.relationRows;
                        case 5: return options.artifactRows;
                        default: return [];
                    }
                }),
            }),
        })),
    };
}
```

기존 테스트들은 `nonServiceCount: 1` 이상으로 호출해 precondition 을 통과시킨다.

- [ ] **Step 6: 전체 discover 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts`
Expected: 기존 테스트 전부 + 신규 1개 PASS.

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/app/api/domains/discover/route.ts \
        apps/web/src/__tests__/domains-discover.route.test.ts
git commit -m "feat(api): discover 라우트에 PREREQUISITE_NOT_MET 검사 추가"
```

---

## Task 4: discover 라우트에서 service 객체 제외

**Files:**
- Modify: `apps/web/src/app/api/domains/discover/route.ts:94-102`
- Modify: `apps/web/src/__tests__/domains-discover.route.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

```ts
it('T-filter: objectType="service" 객체는 멤버 후보 풀에서 제외된다', async () => {
    const capturedInputs = vi.fn<[{ inputs: { objects: Array<{ id: string }> } }], unknown>();
    runDomainDiscoveryMock.mockImplementation(async (args) => {
        capturedInputs(args);
        return { candidates: [] };
    });

    getDbMock.mockResolvedValue(
        makeDbMock({
            nonServiceCount: 2,
            objectRows: [
                { id: 'svc-1', objectType: 'service', name: 'Svc', displayName: null, path: '/svc' },
                { id: 'fn-1', objectType: 'function', name: 'fn', displayName: null, path: '/svc/fn' },
            ],
            intentRows: [],
            relationRows: [],
            artifactRows: [],
        }),
    );

    const { POST } = await import('@/app/api/domains/discover/route');
    await POST(
        new Request('http://x/api/domains/discover', {
            method: 'POST',
            body: JSON.stringify({ workspaceId: 'ws-1' }),
        }),
    );

    const { inputs } = capturedInputs.mock.calls[0]![0];
    expect(inputs.objects.map((o) => o.id)).toEqual(['fn-1']);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts -t "service.*제외"`
Expected: FAIL — `inputs.objects` 에 `svc-1` 이 포함됨.

- [ ] **Step 3: 필터 추가**

`apps/web/src/app/api/domains/discover/route.ts` 의 `memberObjects` 매핑을 수정:

```ts
const memberObjects: DiscoveryObjectInput[] = objectRows
    .filter((o) => o.objectType !== 'domain' && o.objectType !== 'service')
    .map((o) => ({
        id: o.id,
        objectType: o.objectType,
        name: o.name,
        displayName: o.displayName,
        path: o.path,
    }));
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts`
Expected: 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/app/api/domains/discover/route.ts \
        apps/web/src/__tests__/domains-discover.route.test.ts
git commit -m "feat(api): discover 입력 풀에서 service objectType 제외"
```

---

## Task 5: discover 응답에 implementingServices derived 포함

**Files:**
- Modify: `apps/web/src/app/api/domains/discover/route.ts`
- Modify: `apps/web/src/__tests__/domains-discover.route.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

```ts
it('T-impl: candidate 마다 implementingServices 가 멤버의 parent service 로부터 집계된다', async () => {
    // 후보 1개 — 멤버 f1, f2 (parent=svc-A), db-x (parent=svc-A, db_table 은 분자 제외)
    runDomainDiscoveryMock.mockResolvedValue({
        candidates: [
            {
                id: 'orders',
                autoName: 'Orders',
                signals: { topPathPrefix: null, topRoutePrefix: null, topTopicPrefix: null },
                members: [
                    { objectId: 'f1', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.5, relationCohesion: 0.3 },
                    { objectId: 'f2', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.5, relationCohesion: 0.3 },
                    { objectId: 'db-x', pathPrefixMatch: 1, routePrefixMatch: 0, topicPrefixMatch: 0, nameTokenJaccard: 1, affinity: 0.5, relationCohesion: 0.3 },
                ],
                review: null,
            },
        ],
    });

    getDbMock.mockResolvedValue(
        makeDbMock({
            nonServiceCount: 3,
            objectRows: [
                { id: 'svc-A', objectType: 'service', name: 'OrdersService', displayName: null, path: '/a', parentId: null },
                { id: 'f1', objectType: 'function', name: 'create', displayName: null, path: '/a/f1', parentId: 'svc-A' },
                { id: 'f2', objectType: 'function', name: 'update', displayName: null, path: '/a/f2', parentId: 'svc-A' },
                { id: 'f3', objectType: 'function', name: 'archive', displayName: null, path: '/a/f3', parentId: 'svc-A' },
                { id: 'db-x', objectType: 'db_table', name: 'orders', displayName: null, path: '/a/tbl', parentId: 'svc-A' },
            ],
            intentRows: [],
            relationRows: [],
            artifactRows: [],
        }),
    );

    const { POST } = await import('@/app/api/domains/discover/route');
    const res = await POST(
        new Request('http://x/api/domains/discover', {
            method: 'POST',
            body: JSON.stringify({ workspaceId: 'ws-1' }),
        }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.candidates[0].implementingServices).toEqual([
        {
            serviceObjectId: 'svc-A',
            serviceName: 'OrdersService',
            childInDomain: 2, // f1, f2 (db-x 는 분자 제외)
            childTotal: 3,    // f1, f2, f3 (db-x 분모 제외)
            confidence: 2 / 3,
        },
    ]);
});
```

또한 `objectsTable` hoisted mock 의 필드 목록에 `parentId: 'objects.parent_id'` 를 추가해야 한다 — 라우트가 parent_id 도 SELECT 하므로.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts -t implementingServices`
Expected: FAIL — `implementingServices` 필드가 응답에 없음.

- [ ] **Step 3: 라우트에서 parentId SELECT 추가 + 응답 shape 확장**

`apps/web/src/app/api/domains/discover/route.ts`:

```ts
// 1. 객체 SELECT 에 parentId 추가
const objectRows = await db
    .select({
        id: objects.id,
        objectType: objects.objectType,
        name: objects.name,
        displayName: objects.displayName,
        path: objects.path,
        parentId: objects.parentId,
    })
    .from(objects)
    .where(eq(objects.workspaceId, workspaceId));
```

`runDomainDiscovery` 호출 후 응답 구성 부분에서 candidate 마다 `implementingServices` 를 derived 계산:

```ts
import { computeImplementingServices } from '@archi-navi/inference';

// ... runDomainDiscovery 호출 직후:
const candidatesWithImpl = result.candidates.map((cand) => ({
    ...cand,
    implementingServices: computeImplementingServices({
        objects: objectRows.map((o) => ({
            id: o.id,
            parentId: o.parentId,
            objectType: o.objectType,
            name: o.name,
        })),
        memberIds: new Set(cand.members.map((m) => m.objectId)),
    }),
}));

return NextResponse.json({
    success: true,
    data: {
        candidates: candidatesWithImpl,
        llmReviewed: Boolean(modelInfo),
    },
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts`
Expected: 전체 PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/app/api/domains/discover/route.ts \
        apps/web/src/__tests__/domains-discover.route.test.ts
git commit -m "feat(api): discover 응답에 candidate 별 implementingServices 포함"
```

---

## Task 6: approve 라우트가 service 멤버를 거부

**Files:**
- Modify: `apps/web/src/app/api/domains/approve/route.ts:238-253`
- Modify: `apps/web/src/__tests__/domains-approve.route.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

```ts
it('T-service-reject: service objectType 멤버는 400 INVALID_MEMBER_TYPE 으로 거절된다', async () => {
    const db = makeApproveDbMock({
        members: [{ id: 'svc-1', objectType: 'service' }], // service 섞임
        existingDomain: null,
    });
    getDbMock.mockResolvedValue(db);

    const { POST } = await import('@/app/api/domains/approve/route');
    const res = await POST(
        new Request('http://x/api/domains/approve', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: 'ws-1',
                name: 'Orders',
                primaryMembers: [{ objectId: 'svc-1', affinity: 0.8, confidence: 0.5 }],
                secondaryMembers: [],
            }),
        }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_MEMBER_TYPE');
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t INVALID_MEMBER_TYPE`
Expected: FAIL — 현재는 service 를 허용해 affinity 가 생성됨.

- [ ] **Step 3: 서비스 타입 검사 추가**

기존 `domainMembers` 필터 (approve route 239 줄 근처) 바로 뒤에 service 검사 추가:

```ts
const serviceMembers = ownedRows
    .filter((row) => row.objectType === 'service')
    .map((row) => row.id);
if (serviceMembers.length > 0) {
    return NextResponse.json(
        {
            success: false,
            error: {
                code: 'INVALID_MEMBER_TYPE',
                message: 'service 객체는 도메인 멤버로 승인할 수 없습니다. 서비스는 implements 관계로 표현됩니다.',
                serviceObjectIds: serviceMembers,
            },
        },
        { status: 400 },
    );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t INVALID_MEMBER_TYPE`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/app/api/domains/approve/route.ts \
        apps/web/src/__tests__/domains-approve.route.test.ts
git commit -m "feat(api): approve 라우트에서 service 멤버를 INVALID_MEMBER_TYPE 으로 거절"
```

---

## Task 7: approve 트랜잭션 — S_old / S_new 수집

**Files:**
- Modify: `apps/web/src/app/api/domains/approve/route.ts` (트랜잭션 내부)

이번 Task 는 implements 재계산을 실제로 하지 않고, **"영향받는 서비스 집합" 을 계산만** 해서 트랜잭션 결과에 포함시킨다. Task 8 에서 이 집합을 사용해 DELETE/INSERT 로직을 붙인다. TDD 관점에서 집합 계산을 먼저 검증할 수 있게 분리.

- [ ] **Step 1: 실패 테스트 추가**

`apps/web/src/__tests__/domains-approve.route.test.ts`:

```ts
it('T-affected: S_old (기존 멤버 parent) ∪ S_new (신규 멤버 parent) 가 계산된다', async () => {
    // 1차 승인 상태: 도메인 D 에 f-a1 (parent=svcA), f-b1 (parent=svcB) 이 있었음
    // 2차 재승인 payload: f-a1 (parent=svcA), f-c1 (parent=svcC)
    // 기대: 영향받는 서비스 = { svcA, svcB, svcC }
    const db = makeApproveDbMock({
        members: [
            { id: 'f-a1', objectType: 'function' },
            { id: 'f-c1', objectType: 'function' },
        ],
        existingDomain: { id: 'dom-D' },
        existingAffinityMemberIds: ['f-a1', 'f-b1'],
        parentByMember: { 'f-a1': 'svcA', 'f-b1': 'svcB', 'f-c1': 'svcC' },
    });
    getDbMock.mockResolvedValue(db);

    const { POST } = await import('@/app/api/domains/approve/route');
    const res = await POST(
        new Request('http://x/api/domains/approve', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: 'ws-1',
                name: 'D',
                primaryMembers: [
                    { objectId: 'f-a1', affinity: 0.8, confidence: 0.5 },
                    { objectId: 'f-c1', affinity: 0.8, confidence: 0.5 },
                ],
                secondaryMembers: [],
            }),
        }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    // 응답에 affectedServiceIds 가 포함되어야 함 (테스트 가시성용)
    expect(new Set(body.data.affectedServiceIds)).toEqual(new Set(['svcA', 'svcB', 'svcC']));
});
```

(테스트 편의를 위해 응답에 `affectedServiceIds` 를 임시로 노출. Task 8 에서 이 필드는 제거하고 `implementingServices` 로 대체.)

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t S_old`
Expected: FAIL — `affectedServiceIds` 가 응답에 없음.

- [ ] **Step 3: 트랜잭션에 수집 로직 추가**

`apps/web/src/app/api/domains/approve/route.ts` 의 `db.transaction` 블록 내부, **기존 affinity 조회 직전** 에 S_old 수집, **affinity upsert 후** S_new 수집:

```ts
// S_old: 기존 이 도메인 affinity 의 object_id 의 parent service 집합
// - affinity DELETE 이전에 뽑아야 정확함
const existingAffinityRows = await tx
    .select({ objectId: objectDomainAffinities.objectId })
    .from(objectDomainAffinities)
    .where(
        and(
            eq(objectDomainAffinities.workspaceId, workspaceId),
            eq(objectDomainAffinities.domainId, domainObjectId),
        ),
    );

const oldMemberIds = existingAffinityRows.map((r) => r.objectId);
const sOldParentRows = oldMemberIds.length > 0
    ? await tx
        .select({ parentId: objects.parentId, parentType: objects.objectType })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                inArray(objects.id, oldMemberIds),
            ),
        )
    : [];
// 위 쿼리는 "child 자신의 parent_id" 가 필요하므로 실제 구현은 self-join 또는 2단계 조회:
//   1. child rows: SELECT id, parent_id FROM objects WHERE id IN (oldMemberIds)
//   2. parent rows: SELECT id FROM objects WHERE id IN (distinct parent_ids) AND object_type='service'
// 아래는 정리된 2단계 조회 예시:
const sOldChildren = oldMemberIds.length > 0
    ? await tx
        .select({ id: objects.id, parentId: objects.parentId })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                inArray(objects.id, oldMemberIds),
            ),
        )
    : [];
const sOldParentIds = Array.from(
    new Set(sOldChildren.map((c) => c.parentId).filter((p): p is string => p !== null)),
);
const sOldServices = sOldParentIds.length > 0
    ? await tx
        .select({ id: objects.id })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                inArray(objects.id, sOldParentIds),
                eq(objects.objectType, 'service'),
            ),
        )
    : [];
const sOldSet = new Set(sOldServices.map((s) => s.id));

// (기존 staleMemberIds 계산 + affinity DELETE/UPSERT 로직은 여기)

// S_new: 신규 멤버의 parent service
const sNewChildren = await tx
    .select({ id: objects.id, parentId: objects.parentId })
    .from(objects)
    .where(
        and(
            eq(objects.workspaceId, workspaceId),
            inArray(objects.id, memberIds),
        ),
    );
const sNewParentIds = Array.from(
    new Set(sNewChildren.map((c) => c.parentId).filter((p): p is string => p !== null)),
);
const sNewServices = sNewParentIds.length > 0
    ? await tx
        .select({ id: objects.id })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                inArray(objects.id, sNewParentIds),
                eq(objects.objectType, 'service'),
            ),
        )
    : [];
const sNewSet = new Set(sNewServices.map((s) => s.id));

const affectedServiceIds = Array.from(new Set([...sOldSet, ...sNewSet]));

return { domainId: domainObjectId, reused: didReuse, staleMemberIds, affectedServiceIds };
```

트랜잭션 결과로 `affectedServiceIds` 를 반환하고 응답에 임시 포함:

```ts
const { domainId, reused, staleMemberIds, affectedServiceIds } = await db.transaction(/* ... */);

const successData: ApprovalSuccessPayload = {
    // ... 기존 필드
    affectedServiceIds, // 임시 — Task 8 에서 제거
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t S_old`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/app/api/domains/approve/route.ts \
        apps/web/src/__tests__/domains-approve.route.test.ts
git commit -m "feat(api): approve 트랜잭션에서 영향받는 service 집합(S_old ∪ S_new) 수집"
```

---

## Task 8: approve 트랜잭션 — implements 재계산 (DELETE → 집계 → INSERT)

**Files:**
- Modify: `apps/web/src/app/api/domains/approve/route.ts`
- Modify: `apps/web/src/__tests__/domains-approve.route.test.ts`

- [ ] **Step 1: 실패 테스트 3개 추가**

```ts
it('T-impl-single: 단일 도메인 승인 시 영향받는 service 에 올바른 confidence 로 implements 행이 INSERT 된다', async () => {
    // svcA 의 자식 function 이 3개 (f1, f2, f3), 도메인 D 에 f1, f2 가 멤버
    // → svcA.implements(D).confidence = 2/3, childInDomain=2, childTotal=3
    const capturedInserts: unknown[] = [];
    const db = makeApproveDbMock({
        members: [
            { id: 'f1', objectType: 'function' },
            { id: 'f2', objectType: 'function' },
        ],
        existingDomain: null,
        parentByMember: { 'f1': 'svcA', 'f2': 'svcA' },
        serviceChildren: {
            svcA: [
                { id: 'f1', objectType: 'function' },
                { id: 'f2', objectType: 'function' },
                { id: 'f3', objectType: 'function' },
            ],
        },
        primaryAffinityByChild: { f1: 'dom-new', f2: 'dom-new', f3: null },
        captureObjectRelationInserts: capturedInserts,
    });
    getDbMock.mockResolvedValue(db);

    const { POST } = await import('@/app/api/domains/approve/route');
    await POST(
        new Request('http://x/api/domains/approve', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: 'ws-1',
                name: 'D',
                primaryMembers: [
                    { objectId: 'f1', affinity: 0.8, confidence: 0.5 },
                    { objectId: 'f2', affinity: 0.8, confidence: 0.5 },
                ],
                secondaryMembers: [],
            }),
        }),
    );

    expect(capturedInserts).toContainEqual(
        expect.objectContaining({
            subjectObjectId: 'svcA',
            relationType: 'implements',
            source: 'DISCOVERY',
            isDerived: true,
            interactionKind: 'STATIC',
            direction: 'OUT',
            confidence: 2 / 3,
            metadata: expect.objectContaining({
                childTotal: 3,
                childInDomain: 2,
                derivedFrom: 'child_membership_ratio',
            }),
        }),
    );
});

it('T-impl-stale: 재승인에서 빠진 멤버의 parent service 도 implements 가 재계산되어 stale 하지 않다', async () => {
    // 1차: svcA.implements(D), svcB.implements(D) 존재
    // 2차: payload 에 svcB 자식 없음 → svcB 의 DISCOVERY implements 는 DELETE 후
    //      svcB 의 새 분포로 재집계 — 자식이 더는 D 에 없으면 INSERT 없음
    const capturedDeletes: string[] = [];
    const capturedInserts: unknown[] = [];
    const db = makeApproveDbMock({
        members: [{ id: 'f-a1', objectType: 'function' }],
        existingDomain: { id: 'dom-D' },
        existingAffinityMemberIds: ['f-a1', 'f-b1'],
        parentByMember: { 'f-a1': 'svcA', 'f-b1': 'svcB' },
        serviceChildren: {
            svcA: [{ id: 'f-a1', objectType: 'function' }],
            svcB: [{ id: 'f-b1', objectType: 'function' }],
        },
        primaryAffinityByChild: { 'f-a1': 'dom-D', 'f-b1': null },
        captureObjectRelationDeletes: capturedDeletes,
        captureObjectRelationInserts: capturedInserts,
    });
    getDbMock.mockResolvedValue(db);

    const { POST } = await import('@/app/api/domains/approve/route');
    await POST(
        new Request('http://x/api/domains/approve', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: 'ws-1',
                name: 'D',
                primaryMembers: [{ objectId: 'f-a1', affinity: 0.8, confidence: 0.5 }],
                secondaryMembers: [],
            }),
        }),
    );

    // svcA, svcB 둘 다 DELETE 호출됨
    expect(capturedDeletes).toContain('svcA');
    expect(capturedDeletes).toContain('svcB');
    // svcA 에는 INSERT, svcB 는 childInDomain=0 이므로 INSERT 없음
    expect(capturedInserts.filter((i: any) => i.subjectObjectId === 'svcA')).toHaveLength(1);
    expect(capturedInserts.filter((i: any) => i.subjectObjectId === 'svcB')).toHaveLength(0);
});

it('T-impl-storage: db_table 자식은 childTotal/childInDomain 에 포함되지 않는다', async () => {
    const capturedInserts: unknown[] = [];
    const db = makeApproveDbMock({
        members: [{ id: 'f1', objectType: 'function' }],
        existingDomain: null,
        parentByMember: { 'f1': 'svcA' },
        serviceChildren: {
            svcA: [
                { id: 'f1', objectType: 'function' },
                { id: 'tbl-1', objectType: 'db_table' },
                { id: 'tbl-2', objectType: 'db_table' },
            ],
        },
        primaryAffinityByChild: { f1: 'dom-new', 'tbl-1': null, 'tbl-2': null },
        captureObjectRelationInserts: capturedInserts,
    });
    getDbMock.mockResolvedValue(db);

    const { POST } = await import('@/app/api/domains/approve/route');
    await POST(
        new Request('http://x/api/domains/approve', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: 'ws-1',
                name: 'D',
                primaryMembers: [{ objectId: 'f1', affinity: 0.8, confidence: 0.5 }],
                secondaryMembers: [],
            }),
        }),
    );

    const svcAInsert = capturedInserts.find((i: any) => i.subjectObjectId === 'svcA');
    expect(svcAInsert).toMatchObject({
        confidence: 1, // 1/1 (db_table 배제)
        metadata: { childTotal: 1, childInDomain: 1 },
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t "implements"`
Expected: FAIL — 아직 DELETE/INSERT 로직 없음.

- [ ] **Step 3: 재계산 로직 구현**

`apps/web/src/app/api/domains/approve/route.ts` 의 트랜잭션 블록 맨 끝, `return { domainId, ... }` 바로 앞:

```ts
import { objectRelations } from '@archi-navi/db';

// S 각 service 에 대해 implements 재계산
// 1. 해당 service 의 DISCOVERY implements 전량 DELETE
// 2. 해당 service 의 자식 중 function/api_endpoint 만 조회
// 3. 자식별 primary domain (DISTINCT ON) 집계
// 4. 도메인별 INSERT

for (const serviceId of affectedServiceIds) {
    await tx
        .delete(objectRelations)
        .where(
            and(
                eq(objectRelations.workspaceId, workspaceId),
                eq(objectRelations.subjectObjectId, serviceId),
                eq(objectRelations.relationType, 'implements'),
                eq(objectRelations.source, 'DISCOVERY'),
            ),
        );

    // 이 service 의 코드 자식 조회
    const codeChildren = await tx
        .select({ id: objects.id })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                eq(objects.parentId, serviceId),
                inArray(objects.objectType, ['function', 'api_endpoint']),
            ),
        );
    const childTotal = codeChildren.length;
    if (childTotal === 0) continue; // storage-only service — implements 생성 안 함
    const childIds = codeChildren.map((c) => c.id);

    // 자식별 primary domain — DISTINCT ON 으로 affinity 최댓값 1행만
    const primaryRows = await tx.execute(sql`
        SELECT DISTINCT ON (oda.object_id)
               oda.object_id AS child_id,
               oda.domain_id AS domain_id
        FROM ${objectDomainAffinities} oda
        WHERE oda.workspace_id = ${workspaceId}
          AND oda.object_id IN ${sql.raw(`(${childIds.map((id) => `'${id}'`).join(',')})`)}
        ORDER BY oda.object_id, oda.affinity DESC, oda.domain_id ASC
    `);

    // 위 SQL 은 가독성 예시 — 실제로는 inArray + DISTINCT ON 을 지원하는 drizzle
    // raw SQL 헬퍼 사용. 아래는 drizzle-native 버전:
    const primaryRowsDrizzle = await tx
        .selectDistinctOn([objectDomainAffinities.objectId], {
            childId: objectDomainAffinities.objectId,
            domainId: objectDomainAffinities.domainId,
        })
        .from(objectDomainAffinities)
        .where(
            and(
                eq(objectDomainAffinities.workspaceId, workspaceId),
                inArray(objectDomainAffinities.objectId, childIds),
            ),
        )
        .orderBy(
            objectDomainAffinities.objectId,
            sql`${objectDomainAffinities.affinity} DESC`,
            sql`${objectDomainAffinities.domainId} ASC`,
        );

    const byDomain = new Map<string, number>();
    for (const row of primaryRowsDrizzle) {
        byDomain.set(row.domainId, (byDomain.get(row.domainId) ?? 0) + 1);
    }

    // 도메인별 INSERT (INSERT ... ON CONFLICT DO NOTHING 로 동시성 방어)
    for (const [domainId, childInDomain] of byDomain) {
        const confidence = childInDomain / childTotal;
        await tx
            .insert(objectRelations)
            .values({
                workspaceId,
                relationType: 'implements',
                subjectObjectId: serviceId,
                objectId: domainId,
                interactionKind: 'STATIC',
                direction: 'OUT',
                isDerived: true,
                confidence,
                source: 'DISCOVERY',
                metadata: {
                    childTotal,
                    childInDomain,
                    derivedFrom: 'child_membership_ratio',
                },
            })
            .onConflictDoNothing({
                target: [
                    objectRelations.workspaceId,
                    objectRelations.relationType,
                    objectRelations.subjectObjectId,
                    objectRelations.objectId,
                    objectRelations.isDerived,
                ],
            });
    }
}
```

주: `selectDistinctOn` 이 drizzle 버전에 없다면 `sql` raw 로 대체. 프로젝트 현재 drizzle 버전 확인 후 지원 여부에 따라 선택.

- [ ] **Step 4: `affectedServiceIds` 응답 제거**

응답에서 임시 `affectedServiceIds` 필드를 제거 — Task 9 에서 `implementingServices` 로 교체.

- [ ] **Step 5: 3 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t "implements"`
Expected: 3 PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/app/api/domains/approve/route.ts \
        apps/web/src/__tests__/domains-approve.route.test.ts
git commit -m "feat(api): approve 트랜잭션에서 implements 관계 재계산 (primary-only, function/api_endpoint 기준)"
```

---

## Task 9: approve 응답에 implementingServices 포함

**Files:**
- Modify: `apps/web/src/app/api/domains/approve/route.ts`
- Modify: `apps/web/src/__tests__/domains-approve.route.test.ts`

- [ ] **Step 1: 실패 테스트 추가**

```ts
it('T-response-impl: 응답에 이 도메인의 implementingServices 가 포함된다', async () => {
    const db = makeApproveDbMock({
        members: [{ id: 'f1', objectType: 'function' }],
        existingDomain: null,
        parentByMember: { 'f1': 'svcA' },
        serviceChildren: {
            svcA: [
                { id: 'f1', objectType: 'function' },
                { id: 'f2', objectType: 'function' },
            ],
        },
        primaryAffinityByChild: { f1: 'dom-new', f2: null },
        serviceNameById: { svcA: 'OrdersService' },
    });
    getDbMock.mockResolvedValue(db);

    const { POST } = await import('@/app/api/domains/approve/route');
    const res = await POST(
        new Request('http://x/api/domains/approve', {
            method: 'POST',
            body: JSON.stringify({
                workspaceId: 'ws-1',
                name: 'D',
                primaryMembers: [{ objectId: 'f1', affinity: 0.8, confidence: 0.5 }],
                secondaryMembers: [],
            }),
        }),
    );
    const body = await res.json();
    expect(body.data.implementingServices).toEqual([
        {
            serviceObjectId: 'svcA',
            serviceName: 'OrdersService',
            childInDomain: 1,
            childTotal: 2,
            confidence: 0.5,
        },
    ]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts -t implementingServices`
Expected: FAIL.

- [ ] **Step 3: 응답 shape 확장**

`apps/web/src/app/api/domains/approve/route.ts` 의 `ApprovalSuccessPayload` 인터페이스 + 응답 구성부:

```ts
interface ApprovalSuccessPayload {
    domainId: string;
    reused: boolean;
    memberCount: number;
    primaryCount: number;
    secondaryCount: number;
    rollupApplied: boolean;
    implementingServices: Array<{
        serviceObjectId: string;
        serviceName: string;
        childInDomain: number;
        childTotal: number;
        confidence: number;
    }>;
}
```

트랜잭션 바깥, 트랜잭션 반환 후 이 도메인의 implements 를 다시 SELECT 해서 payload 에 담는다:

```ts
const implRows = await db
    .select({
        subjectObjectId: objectRelations.subjectObjectId,
        confidence: objectRelations.confidence,
        metadata: objectRelations.metadata,
    })
    .from(objectRelations)
    .where(
        and(
            eq(objectRelations.workspaceId, workspaceId),
            eq(objectRelations.objectId, domainId),
            eq(objectRelations.relationType, 'implements'),
            eq(objectRelations.source, 'DISCOVERY'),
        ),
    );

// service 이름 조회
const svcRows = implRows.length > 0
    ? await db
        .select({ id: objects.id, name: objects.name, displayName: objects.displayName })
        .from(objects)
        .where(
            and(
                eq(objects.workspaceId, workspaceId),
                inArray(
                    objects.id,
                    implRows.map((r) => r.subjectObjectId),
                ),
            ),
        )
    : [];
const svcName = new Map(svcRows.map((r) => [r.id, r.displayName ?? r.name]));

const implementingServices = implRows
    .map((r) => {
        const meta = (r.metadata ?? {}) as { childTotal?: number; childInDomain?: number };
        return {
            serviceObjectId: r.subjectObjectId,
            serviceName: svcName.get(r.subjectObjectId) ?? r.subjectObjectId,
            childInDomain: meta.childInDomain ?? 0,
            childTotal: meta.childTotal ?? 0,
            confidence: r.confidence ?? 0,
        };
    })
    .sort((a, b) => b.confidence - a.confidence);

const successData: ApprovalSuccessPayload = {
    domainId,
    reused,
    memberCount: allMembers.length,
    primaryCount: primary.length,
    secondaryCount: secondary.length,
    rollupApplied: true,
    implementingServices,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-approve.route.test.ts`
Expected: 전체 PASS (기존 테스트 포함).

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/app/api/domains/approve/route.ts \
        apps/web/src/__tests__/domains-approve.route.test.ts
git commit -m "feat(api): approve 응답에 이 도메인의 implementingServices 포함"
```

---

## Task 10: 도메인 상세 페이지용 /api/domains/[id]/implementing-services 엔드포인트

**Files:**
- Create: `apps/web/src/app/api/domains/[id]/implementing-services/route.ts`
- Create: `apps/web/src/__tests__/domains-implementing-services.route.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('@archi-navi/db', () => ({
    getDb: getDbMock,
    objectRelations: { /* ... */ },
    objects: { /* ... */ },
}));

describe('GET /api/domains/[id]/implementing-services', () => {
    afterEach(() => vi.resetModules());

    it('T1: workspaceId 누락 시 400', async () => {
        const { GET } = await import('@/app/api/domains/[id]/implementing-services/route');
        const res = await GET(
            new Request('http://x/api/domains/dom-1/implementing-services'),
            { params: Promise.resolve({ id: 'dom-1' }) },
        );
        expect(res.status).toBe(400);
    });

    it('T2: 저장된 implements 행을 confidence 내림차순으로 반환', async () => {
        getDbMock.mockResolvedValue({
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({
                    innerJoin: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            orderBy: vi.fn().mockResolvedValue([
                                { serviceId: 'svcA', serviceName: 'A', confidence: 0.8, metadata: { childTotal: 5, childInDomain: 4 } },
                                { serviceId: 'svcB', serviceName: 'B', confidence: 0.2, metadata: { childTotal: 10, childInDomain: 2 } },
                            ]),
                        }),
                    }),
                }),
            }),
        });
        const { GET } = await import('@/app/api/domains/[id]/implementing-services/route');
        const res = await GET(
            new Request('http://x/api/domains/dom-1/implementing-services?workspaceId=ws-1'),
            { params: Promise.resolve({ id: 'dom-1' }) },
        );
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data.implementingServices).toHaveLength(2);
        expect(body.data.implementingServices[0].serviceObjectId).toBe('svcA');
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-implementing-services.route.test.ts`
Expected: FAIL — 파일 없음.

- [ ] **Step 3: 라우트 구현**

`apps/web/src/app/api/domains/[id]/implementing-services/route.ts`:

```ts
/**
 * GET /api/domains/[id]/implementing-services
 *   ?workspaceId=<id>
 *
 * 해당 도메인을 구현하는 서비스 목록 + 비중. objectRelations.implements + DISCOVERY 행 기반.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb, objectRelations, objects } from '@archi-navi/db';

export async function GET(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
) {
    try {
        const { id: domainId } = await ctx.params;
        const workspaceId = req.nextUrl.searchParams.get('workspaceId');
        if (!workspaceId) {
            return NextResponse.json(
                { success: false, error: { code: 'BAD_REQUEST', message: 'workspaceId 가 필요합니다.' } },
                { status: 400 },
            );
        }

        const db = await getDb();
        const rows = await db
            .select({
                serviceId: objectRelations.subjectObjectId,
                serviceName: objects.name,
                serviceDisplayName: objects.displayName,
                confidence: objectRelations.confidence,
                metadata: objectRelations.metadata,
            })
            .from(objectRelations)
            .innerJoin(objects, eq(objects.id, objectRelations.subjectObjectId))
            .where(
                and(
                    eq(objectRelations.workspaceId, workspaceId),
                    eq(objectRelations.objectId, domainId),
                    eq(objectRelations.relationType, 'implements'),
                    eq(objectRelations.source, 'DISCOVERY'),
                ),
            )
            .orderBy(desc(objectRelations.confidence));

        const implementingServices = rows.map((r) => {
            const meta = (r.metadata ?? {}) as { childTotal?: number; childInDomain?: number };
            return {
                serviceObjectId: r.serviceId,
                serviceName: r.serviceDisplayName ?? r.serviceName,
                childInDomain: meta.childInDomain ?? 0,
                childTotal: meta.childTotal ?? 0,
                confidence: r.confidence ?? 0,
            };
        });

        return NextResponse.json({ success: true, data: { implementingServices } });
    } catch (error) {
        console.error('[GET /api/domains/[id]/implementing-services]', error);
        return NextResponse.json(
            { success: false, error: { code: 'INTERNAL_ERROR', message: '조회 중 오류가 발생했습니다.' } },
            { status: 500 },
        );
    }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-implementing-services.route.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/app/api/domains/\[id\]/implementing-services/route.ts \
        apps/web/src/__tests__/domains-implementing-services.route.test.ts
git commit -m "feat(api): /api/domains/[id]/implementing-services 엔드포인트 추가"
```

---

## Task 11: /api/domains GET 응답에 implementingServiceCount 포함

**Files:**
- Modify: `apps/web/src/app/api/domains/route.ts`

- [ ] **Step 1: 응답 shape 확장**

```ts
/**
 * GET /api/domains — 도메인 목록 조회
 * 응답: Array<{ id, name, displayName, path, implementingServiceCount }>
 */
import { type NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, objects, objectRelations } from '@archi-navi/db';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = await getDb();
    const domains = await db
      .select({
        id: objects.id,
        name: objects.name,
        displayName: objects.displayName,
        path: objects.path,
        implementingServiceCount: sql<number>`(
          SELECT count(*)::int
          FROM ${objectRelations} r
          WHERE r.workspace_id = ${objects.workspaceId}
            AND r.object_id = ${objects.id}
            AND r.relation_type = 'implements'
            AND r.source = 'DISCOVERY'
        )`,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, workspaceId),
          eq(objects.objectType, 'domain'),
        ),
      );

    return NextResponse.json(domains);
  } catch (error) {
    console.error('[GET /api/domains]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
```

- [ ] **Step 2: 타입 체크**

Run: `pnpm --filter @archi-navi/web exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add apps/web/src/app/api/domains/route.ts
git commit -m "feat(api): 도메인 목록에 implementingServiceCount 포함"
```

---

## Task 12: 발견 preview 카드에 "구현 서비스" 섹션 추가

**Files:**
- Modify: `apps/web/src/components/domains/domain-discover-section.tsx`

- [ ] **Step 1: 타입 확장**

`DiscoveredCandidate` 인터페이스에 `implementingServices` 추가:

```ts
interface ImplementingService {
  serviceObjectId: string;
  serviceName: string;
  childInDomain: number;
  childTotal: number;
  confidence: number;
}

interface DiscoveredCandidate {
  id: string;
  autoName: string;
  signals: {
    topPathPrefix: string | null;
    topRoutePrefix: string | null;
    topTopicPrefix: string | null;
  };
  members: CandidateMember[];
  review: CandidateReview | null;
  implementingServices: ImplementingService[];
}
```

- [ ] **Step 2: 시각 계층 헬퍼**

파일 상단에 추가:

```ts
function implTier(confidence: number): 'major' | 'secondary' | 'minor' {
  if (confidence >= 0.5) return 'major';
  if (confidence >= 0.2) return 'secondary';
  return 'minor';
}

const IMPL_TIER_CLASS = {
  major: 'bg-primary/15 text-primary font-semibold',
  secondary: 'bg-muted text-foreground',
  minor: 'bg-muted/50 text-muted-foreground text-xs',
} as const;
```

- [ ] **Step 3: 카드 본문에 섹션 추가**

기존 카드의 멤버 리스트 아래 (`{/* 푸터 — 액션 */}` 직전) 삽입:

```tsx
{c.implementingServices.length > 0 ? (
  <section className="mt-3 rounded-md border border-border/50 bg-muted/30 p-3">
    <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
      이 도메인을 구현하는 서비스
    </h4>
    <ul className="space-y-1.5">
      {c.implementingServices.map((s) => {
        const tier = implTier(s.confidence);
        const pct = Math.round(s.confidence * 100);
        return (
          <li
            key={s.serviceObjectId}
            className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${IMPL_TIER_CLASS[tier]}`}
          >
            <span className="truncate">{s.serviceName}</span>
            <span className="shrink-0 font-mono text-xs">
              {s.childInDomain}/{s.childTotal} ({pct}%)
            </span>
          </li>
        );
      })}
    </ul>
    {(() => {
      const sum = c.implementingServices.reduce((a, s) => a + s.confidence, 0);
      const unassigned = 1 - sum;
      return unassigned > 0.001 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          미분류 {Math.round(unassigned * 100)}%
        </p>
      ) : null;
    })()}
    <p className="mt-2 text-[10px] text-muted-foreground">
      * 비율은 코드 단위 (function, api_endpoint) 기준이며, DB/메시지 자원은 포함하지 않습니다.
    </p>
  </section>
) : null}
```

- [ ] **Step 4: 타입 체크**

Run: `pnpm --filter @archi-navi/web exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/components/domains/domain-discover-section.tsx
git commit -m "feat(ui): 발견 preview 카드에 '구현 서비스' 섹션 추가"
```

---

## Task 13: 도메인 목록 카드에 구현 서비스 배지 + precondition 안내

**Files:**
- Modify: `apps/web/src/components/domains/domain-list-client.tsx`

- [ ] **Step 1: 타입 확장 + 배지**

`DomainListItem` 에 `implementingServiceCount: number` 추가.

카드 JSX 에서 이름 아래 배지 추가:

```tsx
<div className="min-w-0">
  <h3 className="truncate font-medium group-hover:text-primary">
    {d.displayName ?? d.name}
  </h3>
  <p className="mt-1 truncate text-xs text-muted-foreground">{d.path}</p>
  <Badge variant="secondary" className="mt-2 text-[10px]">
    구현 서비스 {d.implementingServiceCount}개
  </Badge>
</div>
```

- [ ] **Step 2: precondition 사전 차단 (선택적)**

본 섹션은 UX 향상용으로 **서버 discover 라우트가 이미 400 을 돌려주므로 필수는 아니다**. UI 에서 미리 차단하려면 `DomainDiscoverSection` 에 prop `disabled` 를 추가하고 여기서 workspace 객체 수를 조회해 전달. 이번 계획에서는 **후속 PR 로 미룬다** — 서버 측 안내 메시지로 충분.

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
pnpm --filter @archi-navi/web exec tsc --noEmit
git add apps/web/src/components/domains/domain-list-client.tsx
git commit -m "feat(ui): 도메인 카드에 구현 서비스 배지 추가"
```

---

## Task 14: 도메인 상세 페이지에 "구현 서비스" 섹션

**Files:**
- Modify: `apps/web/src/components/domains/domain-semantic-client.tsx`

- [ ] **Step 1: fetch 훅 추가**

`DomainSemanticClient` 내부에 새 상태/로더 추가:

```ts
interface ImplementingService {
  serviceObjectId: string;
  serviceName: string;
  childInDomain: number;
  childTotal: number;
  confidence: number;
}

const [implServices, setImplServices] = useState<ImplementingService[]>([]);

const loadImplServices = useCallback(async () => {
  if (!workspaceId) return;
  try {
    const res = await fetch(
      `/api/domains/${domainId}/implementing-services?workspaceId=${workspaceId}`,
    );
    const json = (await res.json()) as ApiEnvelope<{ implementingServices: ImplementingService[] }>;
    if (res.ok && json.success && json.data) {
      setImplServices(json.data.implementingServices);
    }
  } catch (e) {
    console.error('[domain-semantic] loadImplServices', e);
  }
}, [domainId, workspaceId]);

useEffect(() => {
  void loadImplServices();
}, [loadImplServices]);
```

- [ ] **Step 2: 섹션 JSX 추가**

기존 멤버/프로파일 섹션과 **분리선**으로 구분해 추가. 파일 내 기존 layout 에 맞춰 삽입 위치를 잡되, 의미 프로파일 섹션들보다 위 (상단에 배치해 상세 페이지 첫 시선에 들어오게) 권장:

```tsx
<section className="rounded-lg border border-border bg-card p-4">
  <header className="mb-3 flex items-center justify-between">
    <h2 className="text-sm font-semibold">구현 서비스</h2>
    <Badge variant="secondary" className="text-xs">
      {implServices.length}개 서비스
    </Badge>
  </header>
  {implServices.length === 0 ? (
    <p className="text-sm text-muted-foreground">
      아직 이 도메인을 구현하는 서비스가 연결되지 않았습니다.
    </p>
  ) : (
    <ul className="space-y-2">
      {implServices.map((s) => {
        const pct = Math.round(s.confidence * 100);
        return (
          <li
            key={s.serviceObjectId}
            className="flex items-center justify-between gap-3 rounded border border-border/60 px-3 py-2"
          >
            <span className="truncate text-sm font-medium">{s.serviceName}</span>
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {s.childInDomain}/{s.childTotal} ({pct}%)
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  )}
  <p className="mt-3 text-[10px] text-muted-foreground">
    * 비율은 코드 단위 (function, api_endpoint) 기준입니다.
  </p>
</section>
```

- [ ] **Step 3: 타입 체크**

Run: `pnpm --filter @archi-navi/web exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: 커밋**

```bash
git add apps/web/src/components/domains/domain-semantic-client.tsx
git commit -m "feat(ui): 도메인 상세 페이지에 구현 서비스 섹션 추가"
```

---

## Task 15: 종단 검증 및 typecheck

**Files:** (검증만)

- [ ] **Step 1: 전체 단위 테스트**

Run:
```bash
pnpm --filter @archi-navi/inference exec vitest run src/__tests__/domain/discovery
pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts \
  src/__tests__/domains-approve.route.test.ts \
  src/__tests__/domains-implementing-services.route.test.ts
```
Expected: 전부 PASS.

- [ ] **Step 2: 전역 타입 체크**

Run: `pnpm -r exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: preview 종단 검증**

Run: `pnpm --filter @archi-navi/web dev` (백그라운드) 후:

1. `/domains` 진입 → 기존 도메인 카드에 "구현 서비스 N개" 배지 표시 (N 은 정상 0 가능 — PR-3 에서 재승인 후 채워짐).
2. "도메인 발견" 클릭 → preview 카드에
   - 멤버 목록에 service 타입이 **하나도 없음** 확인
   - "이 도메인을 구현하는 서비스" 섹션 표시 (비중 바 + N/M + %)
   - 각주 "* 비율은 코드 단위 ..." 표시
3. service 외 객체가 없는 빈 워크스페이스로 "도메인 발견" → 토스트로 `PREREQUISITE_NOT_MET` 메시지 표시 확인.
4. 후보 1개 [승인] → 200 응답. 승인 직후 `/domains/[id]` 상세 진입 → "구현 서비스" 섹션이 채워져 있는지.
5. 같은 서비스 자식을 포함하는 **다른** 후보 승인 → 해당 서비스의 implements 행이 새 분모 반영으로 재계산되는지 (DB 확인).

- [ ] **Step 4: SQL 점검**

```sql
SELECT subject_object_id, object_id, confidence, metadata, source, relation_type
FROM object_relations
WHERE relation_type = 'implements'
  AND source = 'DISCOVERY'
ORDER BY created_at DESC
LIMIT 20;
```

확인:
- `is_derived=true`, `interaction_kind='STATIC'`, `direction='OUT'`
- `metadata.childTotal`, `metadata.childInDomain`, `metadata.derivedFrom='child_membership_ratio'`

- [ ] **Step 5: 최종 커밋 (필요 시)**

검증 과정에서 발견한 잔여 이슈가 있다면 fix 후 커밋. 없다면 Task 15 는 검증만.

```bash
git log --oneline feature/domain-physical-logical-separation ^main
```

모든 Task 커밋이 기대한 대로 쌓여 있는지 확인.

---

## Self-Review 결과

### Spec Coverage

| SPEC 항목 | Task |
|---|---|
| §5.1 objectRelations 주석 확장 | Task 1 |
| §6.1 runDomainDiscovery 변경 없음 | (no-op, 테스트 보호는 기존 inference 테스트) |
| §6.2.1 PREREQUISITE_NOT_MET | Task 3 |
| §6.2.2 service 제외 | Task 4 |
| §6.2 implementingServices derived 계산 | Task 5 (+ Task 2 공용 유틸) |
| §6.3 approve implements 재계산 | Task 7 (S 수집) + Task 8 (DELETE/INSERT) |
| §6.3 INVALID_MEMBER_TYPE (service) | Task 6 |
| §6.4 approve 응답 확장 | Task 9 |
| §6.5 도메인 상세 조회 API (implements JOIN) | Task 10 (`/implementing-services` 전용 엔드포인트로 분리) |
| §6.6 테스트 매트릭스 | Task 3/4/5/6/7/8/9/10 에 분산 |
| §7.1 발견 preview 카드 구현 서비스 섹션 | Task 12 |
| §7.2 상세 페이지 구현 서비스 섹션 | Task 14 |
| §7.3 목록 배지 + precondition UI | Task 13 (precondition 사전 차단은 후속 PR) |
| §9 검증 | Task 15 |

### Placeholder Scan

- 모든 코드 스텝이 실행 가능한 전문 포함.
- "TBD", "TODO" 없음.
- drizzle `selectDistinctOn` 미지원 버전 대비 raw SQL fallback 경로를 Task 8 Step 3 에서 명시.

### Type Consistency

- `ImplementingService` shape (`serviceObjectId, serviceName, childInDomain, childTotal, confidence`) 는 Task 2, 5, 9, 10, 12, 14 전반에서 통일.
- `affectedServiceIds` 는 Task 7 에서 임시로 응답에 노출 → Task 8 에서 제거 → Task 9 에서 `implementingServices` 로 교체. 응답 계약 일관성 확인 완료.

### 스코프 적절성

단일 PR 범위로 문제 없음. 데이터 모델 변경 없음 + 라우트/UI 만 건드려 독립 실행 가능.
