# 102. Domain Physical / Logical Separation SPEC

- 작성일: 2026-04-19
- 대상 범위: `packages/inference/src/domain/discovery`, `apps/web/src/app/api/domains`, `apps/web/src/app/(dashboard)/domains`, `packages/db/src/schema` (주석만)
- 상태: Proposed
- 관련 설계: `docs/design/15-domain-physical-logical-separation.md`
- 선행 PR: PR-1 (`feature/domain-semantic-pr1`), PR-2 의 기존 변경분 (`feature/domain-semantic-pr2-discover`)

---

## 1) 배경

PR-2 가 구현 중인 도메인 발견 엔진이 "1 object = 1 primary domain" 가정을 전제로 모든 non-domain object 를 후보 멤버로 취급한다. 이 가정은 **다책임 서비스** (예: 로봇관리 서비스가 모델/인스턴스/상태/배정 책임을 한 서비스에서 담당) 와 **모듈러 모놀리스** (한 서비스가 여러 도메인 구현) 에서 표현력을 잃는다.

본 SPEC 은 설계 문서 `15-domain-physical-logical-separation.md` 의 결정을 PR-2 브랜치에 구체 적용하기 위한 구현 사양이다.

## 2) 문제 정의

1. 서비스가 도메인 멤버로 분류되면서 물리/논리 경계가 데이터에 섞여 있다.
2. 한 서비스가 여러 도메인을 구현하는 표현을 현재 `objectDomainAffinities` 제약 (`uq_oda` 유니크) 과 primary 선택 로직이 허용하지 않는다.
3. 발견 UI 가 멤버만 보여줄 뿐 "어떤 서비스가 이 도메인을 담당하는가" 정보가 없다.

## 3) 목표

1. 서비스는 도메인 멤버가 아닌 **구현체** 로 표현된다 (`objectRelations.relationType='implements'`).
2. 한 서비스가 여러 도메인의 implements 행을 가질 수 있다.
3. implements 행의 `confidence` 는 해당 서비스의 **코드 단위 자식** (`objectType IN ('function', 'api_endpoint')`) 중 해당 도메인에 속한 비율 (`childInDomain / childTotal`) 이다. `db_table` / `topic` / `queue` / `database` / `message_broker` 등 storage/channel 자식은 분자·분모 어느 쪽에도 포함되지 않는다 (UI 문구·운영 지표도 같은 기준으로 통일한다).
4. approve 라우트가 한 트랜잭션 안에서 멤버 affinity 와 implements 관계를 정합하게 재계산한다.
5. 도메인 상세 페이지와 발견 preview 카드가 "멤버" 와 "구현 서비스" 를 시각적으로 분리해 보여준다.

## 4) 비목표 (이번 PR 범위 밖)

- `database` / `message_broker` 객체의 implements 표현
- 도메인 ↔ 도메인 관계 (예: `depend_on_domain`)
- 경로 기반 하위 슬러그 자동 추출 (예: `/robots/models` 분리)
- implements 행 생성 임계값 (이번 PR 은 자식 ≥ 1 이면 모두 생성)
- 서비스의 "도메인 미분류 자식" 전용 상세 UI

## 5) 데이터 모델 변경

### 5.1 스키마 변경 (실제 DDL 변경 없음 — 주석/타입 확장만)

- `object_relations.relation_type` 에 `'implements'` 값을 신규 허용.
- `object_relations.source` 에 `'DISCOVERY'` 값을 신규 허용.
- 두 컬럼 모두 CHECK constraint 없는 TEXT 이므로 **DB DDL 변경 0**. Drizzle schema 파일의 주석/enum 정의만 확장한다.

적용 대상 파일:

- `packages/db/src/schema/core.ts` (`objectRelations` 테이블의 주석 갱신)
- 기존 TypeScript 타입 유니온이 있다면 `'DISCOVERY'`, `'implements'` 추가. 없으면 추가할 필요 없음.

### 5.2 신규 마이그레이션 파일 필요 여부

**필요 없음**. 5.1 에 따라 DB 스키마는 변경되지 않는다. PR-2 의 기존 마이그레이션 0019 는 유지.

### 5.3 `objectDomainAffinities` 계약 정리 (데이터 변경 없음)

- 서비스 object 의 affinity row 는 **절대 생성되지 않는다**. approve 라우트에서 보장.
- 기존 서비스 affinity row 는 PR-3 (레거시 정리) 에서 일괄 삭제. PR-2 범위에서는 "새로 만들지 않음" 만 보장.

## 6) 백엔드 변경

### 6.1 `runDomainDiscovery` / `structuralClustering`

- **변경 없음**. 서비스 필터링은 입력 단계에서 처리하므로 내부 로직 불변.
- 단, `DiscoveryInputs.objects` 가 이미 서비스를 포함하지 않는다는 전제를 테스트로 보호한다 (6.6 참조).

### 6.2 `/api/domains/discover` 라우트

파일: `apps/web/src/app/api/domains/discover/route.ts`

#### 6.2.1 Precondition 검사 (Codex 지적 반영)

초기 스캔만 돌린 워크스페이스는 `objects` 에 service row 만 존재한다. 이 상태에서 service 를 제외하면 후보 풀이 비어버린다. 이를 명시적으로 실패시켜 사용자에게 원인을 알린다.

```ts
const discoveryPrerequisiteObjectTypes = OBJECT_TYPES.filter(
    (objectType) => objectType !== 'service' && objectType !== 'domain',
);

// workspaceId 확정 후, 객체 로드 전에 선행 검사
const nonServiceCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(objects)
    .where(
        and(
            eq(objects.workspaceId, workspaceId),
            inArray(objects.objectType, discoveryPrerequisiteObjectTypes),
        ),
    );

if (nonServiceCount[0]?.count === 0) {
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

#### 6.2.2 서비스 제외

- `objectRows` 를 `DiscoveryObjectInput[]` 으로 매핑할 때 **`objectType === 'service'` 제외** 를 추가한다.

```ts
const memberObjects: DiscoveryObjectInput[] = objectRows
    .filter((o) => o.objectType !== 'domain' && o.objectType !== 'service')
    .map((o) => ({ ... }));
```

- 응답 포맷에 각 candidate 의 "구현 서비스 derived 목록" 을 포함한다. 이 값은 DB 에 저장되지 않으며 UI 표시용이다.

응답 shape 확장 (candidate 당):

```ts
type DomainCandidateResponse = {
  // 기존 필드 유지
  id: string;
  autoName: string;
  signals: { ... };
  members: CandidateMemberScore[];
  review: ReviewResult | null;
  // 신규 필드
  implementingServices: Array<{
    serviceObjectId: string;
    serviceName: string;
    childInDomain: number;
    childTotal: number;
    confidence: number; // childInDomain / childTotal
  }>;
};
```

- `implementingServices` 계산 (discover 단계 — 아직 affinity 가 DB 에 없음):
  - 이 후보의 `members` 목록 중 **`objectType IN ('function', 'api_endpoint')`** 인 것만 집계 대상
  - 집계 대상 멤버의 parent service 로 귀속
  - `childInDomain` = 이 후보의 집계 대상 멤버 중 해당 service 자식 수
  - `childTotal` = 해당 service 의 자식 중 **`objectType IN ('function', 'api_endpoint')`** 인 것의 전체 수 (워크스페이스 한정)
  - `confidence = childInDomain / childTotal` (childTotal = 0 이면 해당 service 는 응답에서 생략)
  - **db_table, topic, queue, database 는 멤버 풀에는 들어가지만 implements 계산에는 기여하지 않음** (근거: 설계 문서 §4.3)
  - 주의: 여러 candidate preview 가 같은 자식을 (primary + secondary 로) 포함할 수 있으나 **이 단계는 예상 preview 이며** 실제 approve 시점의 숫자와 완전 일치하지 않을 수 있다. approve 시점에서는 runDomainDiscovery 의 primary 선택 규칙에 따라 자식이 1개 도메인에 귀속되므로 DB 값이 정확해진다
  - 서버 쿼리: `objects` 테이블을 멤버 id 로 JOIN 해 `parent_id` 를 뽑고, 같은 workspace 에서 `parent_id IN (…) AND object_type IN ('function','api_endpoint')` 로 자식 총수 집계 (쿼리 2회)

### 6.3 `/api/domains/approve` 라우트

파일: `apps/web/src/app/api/domains/approve/route.ts`

단일 트랜잭션 내에서 다음 순서로 처리한다:

1. **도메인 object upsert** — 기존 로직 유지 (`onConflictDoNothing` + fallback re-select).
2. **멤버 affinity insert** — 기존 로직. 단 payload 에 서비스 멤버가 섞여 들어오는 경우를 방어:
   - 서버에서 `memberObjectId` 목록의 `objectType` 을 조회해 `service` 는 즉시 400 BAD_REQUEST (`{ code: 'INVALID_MEMBER_TYPE' }`). UI 는 service 를 보낼 일이 없지만 API 레벨 방어.
3. **영향받는 service 집합 계산** (Codex 지적 반영 — stale parent 포함):

   재승인 시 "이전에는 이 도메인의 멤버였으나 이번 payload 에서 빠진 멤버" 의 parent service 도 포함해야 stale implements 가 재계산된다. 따라서:

   ```sql
   -- S_old: 이 도메인 D 에 이전에 affinity 가 걸려 있던 멤버의 parent service
   WITH old_member_parents AS (
       SELECT DISTINCT parent.id AS service_id
       FROM object_domain_affinities oda
       JOIN objects child ON child.id = oda.object_id
       JOIN objects parent ON parent.id = child.parent_id
       WHERE oda.workspace_id = :workspaceId
         AND oda.domain_id = :domainId
         AND parent.object_type = 'service'
   ),
   -- S_new: 이번 approve 멤버의 parent service
   new_member_parents AS (
       SELECT DISTINCT parent.id AS service_id
       FROM objects child
       JOIN objects parent ON parent.id = child.parent_id
       WHERE child.id IN (:approvedMemberIds)
         AND parent.object_type = 'service'
         AND parent.workspace_id = :workspaceId
   )
   SELECT service_id FROM old_member_parents
   UNION
   SELECT service_id FROM new_member_parents;
   ```

   이 쿼리는 반드시 **2단계 (멤버 affinity 재작성) 직전** 에 실행해서 `S_old` 가 기존 affinity 상태를 기준으로 수집되도록 해야 한다. 구체 순서:

   ```
   1단계: 도메인 object upsert
   [S_old 수집] — old_member_parents 쿼리
   2단계: 기존 affinity DELETE (WHERE domain_id = :domainId) + 새 affinity INSERT
   [S_new 수집] — new_member_parents 쿼리 (또는 payload 에서 parent 집계)
   S = S_old ∪ S_new
   4단계: S 각 service 에 대해 implements 재계산
   ```

4. **영향받는 service 각각에 대해 implements 재계산** (트랜잭션 내):

   - 해당 service 의 기존 DISCOVERY implements 행 DELETE:

     ```sql
     DELETE FROM object_relations
     WHERE workspace_id = :workspaceId
       AND subject_object_id = :serviceId
       AND relation_type = 'implements'
       AND source = 'DISCOVERY';
     ```

   - 자식 분포 SELECT (자식당 **primary domain 만** count, 자식 타입은 **function/api_endpoint 만**):

     ```sql
     -- 자식별 primary domain (affinity 최댓값) 을 먼저 뽑고
     WITH primary_affinity AS (
       SELECT DISTINCT ON (oda.object_id)
              oda.object_id, oda.domain_id, oda.affinity
       FROM object_domain_affinities oda
       WHERE oda.workspace_id = :workspaceId
       ORDER BY oda.object_id, oda.affinity DESC, oda.domain_id ASC
       -- 동률이면 domain_id 사전순 tie-break 로 결정성 확보
     )
     SELECT pa.domain_id, COUNT(*) AS child_in_domain
     FROM objects child
     LEFT JOIN primary_affinity pa ON pa.object_id = child.id
     WHERE child.parent_id = :serviceId
       AND child.workspace_id = :workspaceId
       AND child.object_type IN ('function', 'api_endpoint')  -- 코드 단위만 implements 분자/분모 대상
     GROUP BY pa.domain_id;

     -- 동시에 childTotal = COUNT(*) WHERE parent_id = :serviceId
     --                              AND object_type IN ('function','api_endpoint')
     ```

     `pa.domain_id IS NULL` 행은 미분류 자식 수로만 사용 (INSERT 안 함). 자식이 secondary 로 다른 도메인에 걸쳐 있어도 implements 비중에는 **primary 만** 반영된다. 이 규칙으로 `Σ(confidence) ≤ 1` 및 `1 - Σ = 미분류 비율` 불변식이 성립.

     `childTotal = 0` 인 service (function/api_endpoint 자식이 하나도 없는 경우 — 예: storage-only 서비스나 초기 scan 직후 상태) 는 implements 계산을 건너뛴다 (행 생성 없음, stale DELETE 만 수행).

     **db_table / topic / queue / database / message_broker 는 분자/분모에 포함되지 않음** (근거: 설계 문서 §4.3, §9). 향후 relation 기반 귀속 (§11) 이 도입되면 별도 집계 경로로 합산.

   - 도메인별로 INSERT:

     ```sql
     INSERT INTO object_relations
       (workspace_id, subject_object_id, object_id, relation_type,
        interaction_kind, direction, is_derived, confidence, source, metadata)
     VALUES
       (:ws, :serviceId, :domainId, 'implements',
        'STATIC', 'OUT', true, :confidence, 'DISCOVERY', :metadata);
     ```

     `confidence = childInDomain / childTotal`.  
     `metadata = { childTotal, childInDomain, derivedFrom: 'child_membership_ratio' }`.

5. **uq_object_relations 유니크 충돌 처리**:
   - 기존 유니크 키는 `(workspace_id, relation_type, subject_object_id, object_id, is_derived)`.
   - 4 의 DELETE → INSERT 순서로 인해 같은 트랜잭션에서는 충돌 없음.
   - 다른 트랜잭션과 동시 실행 시 (극히 드물지만) `ON CONFLICT DO NOTHING` 로 안전 fallback.

### 6.4 `/api/domains/approve` 응답 확장

기존 응답에 새 도메인을 담당하는 서비스 목록 추가:

```ts
type ApproveResponse = {
  success: true;
  data: {
    domainId: string;
    autoName: string;
    members: Array<{ objectId, affinity, confidence }>;
    implementingServices: Array<{
      serviceObjectId: string;
      serviceName: string;
      childInDomain: number;
      childTotal: number;
      confidence: number;
    }>;
  };
};
```

UI 가 승인 직후 상세 페이지로 이동해도 구현 서비스를 바로 표시할 수 있도록 하기 위함.

### 6.5 도메인 상세 조회 API (기존 PR-1 라우트) 확장

- 도메인 상세 페이지 로더가 implements 행을 JOIN 해서 함께 반환.
- 기존 라우트 경로는 PR-1 에서 정의된 것 그대로 사용. 쿼리 1개 추가.

구체 SELECT:

```sql
SELECT r.subject_object_id, r.confidence, r.metadata,
       s.name AS service_name, s.display_name AS service_display_name
FROM object_relations r
JOIN objects s ON s.id = r.subject_object_id
WHERE r.object_id = :domainId
  AND r.workspace_id = :workspaceId
  AND r.relation_type = 'implements'
  AND r.source = 'DISCOVERY'
ORDER BY r.confidence DESC;
```

### 6.6 테스트 매트릭스

파일: `packages/inference/src/__tests__/domain/discovery/runDomainDiscovery.test.ts` 및 `apps/web/src/__tests__/domains-discover.route.test.ts`, `apps/web/src/__tests__/domains-approve.route.test.ts`

추가할 테스트 (한국어 describe / it 타이틀):

- **discover 라우트**:
  - T: `objectType='service'` 객체는 멤버 후보 풀에서 제외된다
  - T: 워크스페이스에 service 외 객체가 없으면 400 `PREREQUISITE_NOT_MET` 를 반환한다 (Codex 지적 반영)
  - T: precondition 은 canonical object type 집합에서 `service` / `domain` 만 제외한다 (`db_view`, `cache_instance`, `cache_key`, `message_broker` 도 허용)
  - T: 각 candidate 의 `implementingServices` 가 멤버의 parent service 로부터 올바르게 집계된다
  - T: `implementingServices` 의 childInDomain/childTotal 는 **function/api_endpoint 만** 기준으로 계산된다 (db_table/topic 은 집계에 기여하지 않음)
  - T: 부모 service 가 없는 멤버 (자식이 아닌 최상위 객체) 는 `implementingServices` 에 기여하지 않는다

- **approve 라우트**:
  - T: 단일 도메인 승인 시 영향받는 service 에 올바른 `confidence = childInDomain / childTotal` 로 implements 행이 생성된다
  - T: 같은 service 자식에 후속 도메인이 승인되면 기존 implements 행의 분모가 유지되고 새 도메인 implements 행이 추가된다
  - T: 재승인 시 기존 DISCOVERY implements 행은 모두 DELETE 되고 새로 INSERT 된다 (INFERRED 출처의 다른 implements 는 건드리지 않음)
  - T (**Codex 지적**): **stale parent 재계산** — 1차 승인에서 ServiceA 자식과 ServiceB 자식이 모두 도메인 D 의 멤버였다가, 2차 재승인에서 ServiceB 자식이 전부 빠져도 ServiceB 의 `implements(D)` 가 재계산되어 stale 하게 남지 않는다
  - T: 자식 10 중 6 이 A 도메인, 3 이 B 도메인, 1 이 미할당인 service 에서 `implements(A)=0.6, implements(B)=0.3, Σ=0.9` 가 되는지
  - T: **storage/channel 자식은 implements 분자/분모에 포함되지 않음** — service 자식에 function 5 + db_table 3 이 있을 때 childTotal=5 로 계산된다
  - T: payload 에 service objectId 가 멤버로 섞여 오면 400 `INVALID_MEMBER_TYPE` 반환
  - T: 자식이 하나도 도메인에 할당되지 않은 service 는 implements 행이 생성되지 않는다
  - T: function/api_endpoint 자식이 0 개인 service (storage-only 등) 는 implements 계산 대상에서 빠지며 에러 없이 진행된다
  - T: 트랜잭션 중 INSERT 충돌 (동시 approve) 시 `ON CONFLICT DO NOTHING` 으로 500 안 나는지 (mock 레벨)

## 7) UI 변경

### 7.1 발견 preview 카드

파일: `apps/web/src/components/domains/domain-discover-section.tsx` (또는 발견 카드 컴포넌트 경로)

- 멤버 목록: function / api_endpoint / topic / queue / db_table 등만 표시. service 는 나타나지 않음 (백엔드에서 제외됨).
- 신규 섹션 "구현 서비스":
  - 응답의 `implementingServices` 를 `confidence` 내림차순 정렬
  - 카드 형태 예시: `RobotService · 6/10 (60%)` + 비중 바
  - 시각 계층:

    | confidence 범위 | 시각 |
    |---|---|
    | ≥ 0.5 | 큰 배지 + 굵은 텍스트 |
    | 0.2 ~ 0.5 | 중간 배지 |
    | 0 < x < 0.2 | 작은 칩, 은은한 색 |

  - `1 - Σ` 가 0 보다 크면 카드 하단에 회색 "미분류 N개" 칩.
  - 섹션 하단 각주 (작은 글씨): "* 비율은 코드 단위 (function, api_endpoint) 기준이며, DB/메시지 자원은 포함하지 않습니다."

### 7.2 `/domains/[id]` 상세 페이지

파일: PR-1 에서 생성된 `apps/web/src/app/(dashboard)/domains/[id]/page.tsx` (및 하위 컴포넌트)

- 기존 "멤버" 섹션 옆에 **"구현 서비스"** 섹션 추가. 두 섹션은 명확히 분리 (서로 다른 카드 / 분리선).
- 구현 서비스 섹션 내용:
  - 서비스 카드 목록 (confidence 내림차순)
  - 각 카드: 서비스 이름 (링크 → `/services/[id]` 가 있다면 연결, 없으면 plain 텍스트), 비중 바, `N/M children` 텍스트, 시각 계층 (7.1 동일)
  - 섹션 푸터 라벨: "이 도메인은 N개 서비스에서 구현됩니다" (implements 행 개수)
  - 각주 (작은 글씨): "* 비율은 코드 단위 (function, api_endpoint) 기준입니다."

### 7.3 `/domains` 목록 페이지

파일: PR-2 에서 생성된 `apps/web/src/app/(dashboard)/domains/page.tsx`

- 이미 승인된 도메인 카드 그리드에 "구현 서비스 N개" 배지 추가 (DB 쿼리에서 implements 개수 집계).
- 쿼리 1개 추가 (도메인별 implements count GROUP BY). 부하 낮음.
- **"도메인 발견" 버튼 precondition 처리** (Codex 지적 반영):
  - 페이지 서버 컴포넌트에서 canonical object type 집합 중 `service` / `domain` 을 제외한 객체의 존재 여부를 같이 조회
  - 없으면 버튼 disabled + 툴팁 "도메인 발견 전에 inference 를 먼저 실행해주세요"
  - 버튼 옆에 `/inference-runs` 로 가는 링크 ("inference 실행하러 가기") 표시
  - discover API 가 어쨌든 400 로 방어하지만, UI 가 사전 차단하는 편이 사용자 경험이 깔끔함

### 7.4 Sidebar / 기타

- 기존 PR-2 스코프에 포함된 sidebar 메뉴 추가는 본 SPEC 변경과 무관하게 유지.

## 8) 실행 순서

1. 설계 문서 `docs/design/15-...` 및 본 SPEC 커밋 (이 작업).
2. `packages/db/src/schema/core.ts` `objectRelations` 주석 업데이트 (`implements` / `DISCOVERY` 값 허용 명시).
3. `packages/inference` 측: 이미 service 필터링은 discover 라우트에서 처리되므로 inference 모듈 변경 없음. 기존 테스트 fixture 가 service 를 포함하는지 점검 후 필요시 수정.
4. `/api/domains/discover` 라우트: service 필터 + `implementingServices` derived 계산.
5. `/api/domains/approve` 라우트: implements 재계산 트랜잭션 로직 + 응답 확장 + 방어.
6. `/api/domains/[id]` (상세 조회) 라우트: implements JOIN 추가.
7. UI 컴포넌트:
   - 발견 preview 카드 (7.1)
   - 도메인 상세 페이지 (7.2)
   - 도메인 목록 카드 배지 (7.3)
8. 테스트 (6.6) 작성 및 기존 테스트 수정.
9. 타입체크 + lint + unit tests + preview 종단 검증.

## 9) 검증

### 9.1 단위 테스트

```bash
pnpm --filter @archi-navi/inference exec vitest run src/__tests__/domain/discovery
pnpm --filter @archi-navi/web exec vitest run src/__tests__/domains-discover.route.test.ts src/__tests__/domains-approve.route.test.ts
```

### 9.2 타입/빌드

```bash
pnpm -r exec tsc --noEmit
```

### 9.3 종단 검증 (preview)

워크스페이스 "ㅊㅊㅊㅊ" 기준:

1. `/domains` 진입 → 기존 도메인 카드에 "구현 서비스 N개" 배지가 보이는지 (기존 도메인은 implements 행이 없어 0 일 수 있음 — 정상, PR-3 에서 재승인 후 채워짐).
2. "도메인 발견" 클릭 → preview 카드에 멤버에 service 가 없고 "구현 서비스" 섹션이 렌더되는지.
3. 1개 후보 [승인] → 200. 응답의 `implementingServices` 에 기대한 서비스가 비중과 함께 옴.
4. 승인 후 `/domains/[id]` 상세 진입 → 멤버 섹션과 구현 서비스 섹션이 분리 렌더.
5. 같은 서비스 자식을 포함하는 **다른** 후보 승인 → 해당 서비스의 이전 implements confidence 가 새 분모 반영해 업데이트.
6. 개발자 도구 Network → approve 응답의 `implementingServices` 가 실제 DB 저장값과 일치.

### 9.4 SQL 점검

preview 환경에서 1개 도메인 승인 후:

```sql
SELECT subject_object_id, object_id, confidence, metadata, source
FROM object_relations
WHERE relation_type = 'implements'
  AND workspace_id = :ws
ORDER BY created_at DESC
LIMIT 20;
```

- `source='DISCOVERY'`, `is_derived=true`, `interaction_kind='STATIC'`, `direction='OUT'` 확인
- `metadata.childTotal`, `metadata.childInDomain`, `metadata.derivedFrom='child_membership_ratio'` 확인

## 10) 기존 데이터 / 마이그레이션 영향

- 기존 서비스의 `objectDomainAffinities` 행은 본 PR 에서는 건드리지 않는다. PR-3 에서 일괄 정리.
- `object_relations` 에 이미 다른 `relationType` 값들이 있다 → 본 PR 은 새 값 `'implements'` 와 새 source `'DISCOVERY'` 를 추가 사용할 뿐이므로 기존 데이터에 영향 없음.
- 롤백: PR revert 후 운영에서 잔존한 `'implements' / DISCOVERY` 행을 삭제하려면 `DELETE FROM object_relations WHERE relation_type='implements' AND source='DISCOVERY';` 1회 실행. 다른 관계 손상 없음.

## 11) 열린 질문 / 후속 검토

- 동일 워크스페이스에서 도메인 재승인이 반복될 때 implements row 재계산 비용: 현재는 service 단위 DELETE → INSERT. 자식 수가 매우 많은 모놀리스에서는 milliseconds 단위 부하 가능. 이번 PR 스코프에서는 문제 없을 것으로 판단, 후속 PR 에서 실측 후 최적화 (예: DIFF 기반 UPDATE) 검토.
- 서비스가 모든 자식이 미분류인 상태에서 상세 페이지 방문 시 "이 서비스는 아직 어떤 도메인도 담당하지 않습니다" 안내. 별개 UI 작업, 본 PR 외.
- `uq_object_relations` 유니크 키가 `is_derived` 를 포함하므로 `is_derived=true` implements 와 수동 `is_derived=false` implements 가 공존 가능. 수동 implements 입력 경로는 아직 없으므로 현재는 단일 키 충돌 없음.
- primary-only counting 규칙으로 secondary 도메인 소속 자식은 implements 에 반영되지 않음. 이 선택은 "1 - Σ = 미분류" 불변식을 우선한 결과. 만약 향후 "이 서비스가 몇 도메인과 조금이라도 관련 있나" 지표가 별도로 필요해지면 secondary 를 반영하는 별도 메트릭 (예: `touchesDomains` count) 추가 고려.
- **Relation 기반 storage/channel 귀속** (Codex 지적에서 파생): 현재 implements 분자/분모는 function/api_endpoint 만 다루므로 storage/channel 중심 도메인 (예: "orders 도메인의 orders_table 이 어느 서비스에서 구현되는가") 은 별도 귀속 경로가 없다. 후속 PR 에서 `read` / `write` / `produce` / `consume` 관계를 집계해 "DB/MQ 를 사용하는 서비스" 를 storage 멤버의 구현자로 인정하는 설계를 별도 진행. 공유 자원 시 비율 분배 규칙 (예: 3개 서비스가 같은 table 을 사용하면 각 1/3 으로 귀속) 이 핵심 쟁점.
- **Precondition 자동 해소** (후속 UX): 현재는 service 외 객체 부재 시 사용자에게 수동 inference 실행을 안내. 후속에서는 "도메인 발견" 버튼 클릭 시 inference 상태를 체크하고 누락이면 자동 실행 선택지를 다이얼로그로 제공하는 방안 검토.
