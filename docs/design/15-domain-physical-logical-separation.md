# Domain Physical / Logical Separation Design

작성일: 2026-04-19
상태: Proposed
대상 범위: `packages/inference` (discovery), `apps/web` (`/api/domains/*`, `/domains/*`)
관련 SPEC: `102-domain-physical-logical-separation-spec.md`

---

## 1. 배경

현재 PR-2 에서 구현 중인 Phase 1 도메인 발견 엔진은 워크스페이스의 모든 non-domain object 를 후보 풀에 넣고 4개 결정적 신호 (pathPrefix / routePrefix / topicPrefix / nameTokenJaccard) 의 평균을 `affinity` 로 사용해 한 객체를 한 도메인의 **멤버** 로 귀속시킨다.

이 설계는 실제 코드베이스에 대면 두 가지 경계 케이스에서 일관성이 깨진다.

1. **다책임 서비스**. 하나의 서비스가 여러 하위 책임을 가지는 경우. 예: 로봇관리 서비스가 로봇 모델 CRUD, 로봇 인스턴스 CRUD, 상태 조회, 배정 요청 등을 한 서비스에서 모두 다루는 경우. 현재 엔진은 이 서비스와 그 자식 function/endpoint 전체를 단일 `robots` 슬러그로 묶어 하위 책임 구분을 잃는다.
2. **모듈러 모놀리스 / 모놀리스**. 한 물리 서비스가 여러 도메인을 담는 경우. 현재 엔진은 "1 object = 1 primary domain" 규칙 때문에 이 서비스를 하나의 도메인으로만 배정할 수밖에 없다.

두 문제의 뿌리는 동일하다. **엔진이 "서비스 = 도메인" 을 암묵적으로 가정** 한다. 서비스는 물리 단위(배포 단위, 실행 프로세스, 레포지토리), 도메인은 논리 단위(책임 경계, bounded context) 이다. 두 개념을 같게 두면 물리 단위가 논리 단위의 표현력을 제약한다.

---

## 2. 원칙

> **서비스는 물리 단위, 도메인은 논리 단위. 하나의 물리 단위 안에 여러 논리 단위가 있을 수 있다.**

이 원칙이 의미하는 것:

- 도메인의 "멤버" 는 논리 단위여야 한다. function, api_endpoint, topic, queue, database, db_table 등 — 책임의 최소 단위들.
- 서비스는 도메인에 **속하지 않는다**. 대신 도메인을 **구현한다** (implements). 서비스는 도메인을 담아내는 물리 컨테이너다.
- 한 서비스가 여러 도메인을 구현할 수 있다. 비중을 가지고 (예: 로봇서비스가 robot-management 60%, robot-monitoring 30%, assignment 10% 를 구현).

---

## 3. 스캐너 측 제약 확인

이 설계는 기존 스캐너 파이프라인이 이미 생성하는 자산에 기반한다. 추가 스캐너 작업 불필요.

- 초기 scan (`packages/cli/src/commands/scan.ts`): `service` 1 row / repo
- 후속 inference 단계에서 자동 생성:
  - `function` — `packages/inference/src/code/ownerResolution.ts` 에서 `resolveSignalOwnerMetadata()` 가 signal evidence 기반으로 생성. `parentId = serviceId`, `depth = 1`
  - `api_endpoint` — `packages/inference/src/relation/codeBased.ts:509-523` `bootstrapApiEndpointsFromCodeSignals()` 가 expose signal 기반으로 생성. `parentId = serviceId`, `depth = 1`
  - `topic` / `queue` — `packages/inference/src/orchestration/intentProofEngine.ts` 에서 메시지 신호 기반 생성
  - `database` / `db_table` — `relation/configBased.ts`, `relation/codeBased.ts` 에서 생성

즉 전체 스캔 + 추론 파이프라인을 한 번 돌리고 나면 `objects` 테이블에는 이미 서비스 자식 수준의 논리 단위들이 쌓여 있다. **본 설계는 이 자식 풀을 도메인 발견 입력으로 쓰는 것** 뿐이며 새 스캐너를 요구하지 않는다.

`path` 컬럼은 `/{uuid}`, `/{serviceId}/function/{hash}`, `/{serviceName}/{slug}` 형식이라 서비스 경계를 드러낼 뿐 도메인 슬러그 신호로는 빈약하다. 이 약점은 본 설계에서 "도메인 신호는 주로 intent route/topic prefix 와 name token 으로 결정" 된다는 사실로 수용한다. 경로 기반 슬러그 확장은 별개 설계 주제.

---

## 4. 핵심 설계 결정

### 4.1 서비스는 클러스터링 입력에서 제외

도메인 발견 파이프라인의 첫 단계 (structuralClustering) 에 들어가는 객체 풀에서 `objectType === 'service'` 를 걸러낸다. 서비스가 후보 멤버로 들어가지 않으므로 "1 object = 1 primary domain" 규칙이 서비스에 적용되지 않고, 서비스의 이름/경로 신호가 클러스터 경계를 왜곡하지 않는다.

### 4.2 서비스 ↔ 도메인 링크는 `objectRelations.relationType='implements'` 로 모델링

대안으로 고려했던 모델:

| 대안 | 평가 결과 |
|---|---|
| `objectDomainAffinities` 에 role 컬럼 추가 (`MEMBER | IMPLEMENTS`) | **기각.** affinity 컬럼이 두 의미를 동시에 가져 장기적으로 관리 비용 ↑ |
| 별도 테이블 `object_domain_implementations` | **기각.** "도메인에 연결된 모든 객체" 쿼리가 2테이블 UNION 로 분산 |
| **`objectRelations` 에 `implements` 타입 추가** | **채택** |

채택 이유:

- `objectRelations` 는 이미 `relationType` 이 오픈 스트링이며 `depend_on`, `fk_reference` 같은 정적 관계를 수용하도록 설계됨 (`interactionKind='STATIC'` 존재)
- subject/object FK 가 `objects.id` 이므로 domain 객체도 그대로 참여자로 가능. 스키마 변경 없음
- 방향성을 `subjectObjectId → objectId` 로 표현 가능. implements 는 본질적으로 방향 있는 관계 (service → domain)
- `objectDomainAffinities` 는 **멤버십 전용** 으로 의미가 순수해진다. affinity 컬럼의 의미가 "4개 신호 평균" 하나로 고정

implements row 필드 매핑:

| 컬럼 | 값 | 근거 |
|---|---|---|
| `subjectObjectId` | serviceId | "이 서비스가" |
| `objectId` | domainId | "이 도메인을" |
| `relationType` | `'implements'` | "구현한다" |
| `interactionKind` | `'STATIC'` | 정적 아키텍처 사실 |
| `direction` | `'OUT'` | 서비스 입장에서 OUT (담당하는 대상) |
| `isDerived` | `true` | 자식 멤버십으로부터 파생됨 |
| `confidence` | childInDomain / childTotal | 4.3 참조 |
| `source` | `'DISCOVERY'` | 4.4 참조 |
| `metadata` | `{childTotal, childInDomain, derivedFrom: 'child_membership_ratio'}` | 운영 디버깅용 |

### 4.3 implements.confidence 의 분모는 "코드 단위 자식"

"이 서비스가 해당 도메인을 얼마나 구현하는가" 를 수치화하는 방식으로 두 옵션을 비교했다.

이때 **"자식" 은 `objectType IN ('function', 'api_endpoint')` 로 제한한다**. 즉 db_table, topic, queue, database, message_broker 는 도메인 멤버로는 허용되지만 implements 계산의 분자/분모에는 포함되지 않는다. 이유:

1. "이 서비스가 이 도메인을 구현한다" 는 직관은 주로 **코드 단위** (function/endpoint) 에서 나온다. storage/channel 은 도메인을 **저장/중계** 할 뿐이며 서비스가 **구현** 하는 것은 그 자원을 조작하는 코드이다.
2. storage/channel 은 여러 서비스가 공유할 수 있어 (예: shared DB, shared broker) "단일 구현자" 로 서비스에 귀속시키기 모호하다. 또한 `parent_id` 가 `database`/`message_broker` 를 가리키므로 서비스와 직접적인 계층 관계도 없다.
3. storage/channel 을 서비스 구현 관계로 끌어오려면 `read` / `write` / `produce` / `consume` 같은 **relation 기반 귀속** 이 필요한데, 이는 이번 PR 범위를 넘는 별도 설계 주제이다 (§9 참조).

```
예시: RobotService 자식 10개 중 function/api_endpoint 가 10개 (모두 계산 대상).
  도메인 할당: 6개 → robot-mgmt, 1개 → monitoring, 3개 → 미할당
```

| 옵션 | 계산 | 결과 |
|---|---|---|
| I (채택) | `childInDomain / childTotal` | mgmt=0.6, mon=0.1, 합=0.7 |
| II (기각) | `childInDomain / childAssigned` | mgmt=0.857, mon=0.143, 합=1.0 |

옵션 I 채택 이유:

1. **정보 보존성**: 옵션 I 데이터에서 옵션 II 는 `confidence / Σ(confidence)` 로 언제든 유도 가능. 역은 불가능. 옵션 II 는 "미할당 자식 수" 정보를 영구히 잃는다.
2. **신규 서비스 과대평가 방지**: 옵션 II 에서는 자식 중 하나만 도메인에 승인되면 "이 서비스 100% 해당 도메인 구현자" 로 표시돼 커버리지가 낮을수록 과장된 확신이 생긴다. 옵션 I 은 0.1 같은 작은 수로 정직하게 표현.
3. **커버리지가 데이터에 내재**: `1 - Σ(confidence)` 가 해당 서비스의 도메인 미분류 비율을 즉시 답한다. 별도 메타데이터 없이 `objectRelations` 쿼리 하나로 커버리지 운영 지표 구성 가능.

위 "도메인에 속한 자식" 은 **자식의 primary domain 만** 을 의미한다. `objectDomainAffinities` 는 한 자식에 대해 primary + secondary 로 2개 이상 행을 가질 수 있지만, implements 계산에서는 자식당 가장 affinity 가 큰 1개 도메인만 count 한다. 이유:

- `Σ(confidence) ≤ 1` 과 `1 - Σ = 미분류 비율` 불변식을 유지해야 "커버리지가 데이터에 내재" 논리가 성립
- secondary 는 "약한 연관" 신호지 "이 서비스가 그 도메인을 구현한다" 고 주장할 만한 근거가 아님

비중이 작은 도메인(예: 0.1) 도 UI 에서 드러나야 한다는 원칙은 별개의 임계값 정책으로 다룬다 (4.5 참조).

### 4.4 source 값에 `DISCOVERY` 추가

`objectRelations.source` 는 현재 `MANUAL | INFERRED | ROLLUP`. 본 설계에서 생성되는 implements row 는 새 값 `DISCOVERY` 를 사용한다.

채택 이유:

- `source` 는 관계의 **출처** 를 나타내는 축이고 `relationType` 은 관계의 **타입** 축이다. 둘의 직교성 유지가 깔끔함
- 기존 `INFERRED` 는 runtime 추론 (call / read / write 등) 을 포함한다. 정적 도메인 발견과 섞이면 "도메인 발견 롤백" 같은 운영 작업에서 범위 지정이 지저분해진다
- CHECK constraint 가 없는 TEXT 컬럼이라 DB 마이그레이션 DDL 불필요. TypeScript enum 주석만 확장

### 4.5 implements row 생성 임계값 없음

자식이 한 명이라도 해당 도메인에 속하면 implements row 를 만든다. 아주 작은 비중의 도메인도 데이터에 드러나야 한다는 것이 채택 원칙이다. 시각적 차별화는 UI 레이어 책임.

```
UI 시각 계층:
  ≥ 0.5         큰 배지 + 굵은 텍스트 ("주 구현")
  0.2 ~ 0.5     중간 배지 ("보조 구현")
  0 < x < 0.2   작은 칩, 은은한 색 ("소수 구현")
  1 - Σ         회색 "미분류" 칩 (coverage gap)
```

---

## 5. 재계산 범위와 트랜잭션

한 도메인을 approve 하면 멤버의 부모 서비스들의 자식 분포가 바뀐다. 문제는 이 부모 서비스들이 **다른 도메인에도 implements 행을 이미 가지고 있을 수 있다**는 점, 그리고 **재승인 시 이전 멤버가 이번 payload 에서 빠졌다면 그 멤버의 부모 서비스도 영향받는다** 는 점이다.

```
예시 1 (신규 승인):
  이번 승인: robot-monitoring 에 f7 추가 (f7 의 parent = RobotService)
  RobotService 는 이전에 implements(robot-mgmt) 행을 이미 가짐
  → f7 이 추가되면서 RobotService 자식 할당 집합이 바뀜
  → RobotService 의 모든 implements 행의 분모 / 분자가 바뀜
  → implements(robot-mgmt) 도 재계산 필요

예시 2 (재승인 — Codex 지적):
  1차 approve: mgmt 에 f1, f2 (parent=ServiceA) + f10 (parent=ServiceB) 승인
           → ServiceA.implements(mgmt), ServiceB.implements(mgmt) 생성
  2차 재approve: mgmt 에 f1 만 포함 (f2, f10 제외)
           → approvedMemberIds 의 parent 만 보면 S = {ServiceA}
           → ServiceB 재계산 누락 → stale implements(mgmt) 로 남음 ❌
  → 영향 범위는 신규 승인 멤버의 parent 뿐 아니라 "이 도메인에서 제거된 멤버의 parent" 까지 포함해야 함
```

따라서 approve 트랜잭션의 재계산 범위는 **도메인 D 의 이전 멤버와 새 멤버의 parent 서비스 합집합**:

```
1. 기존 objectDomainAffinities WHERE domain_id = D 의 object_id 수집
   → S_old = {parent_service_of(obj) for obj in old_members}
2. affinity 재작성 (기존 DELETE → 새 INSERT)
3. 새 멤버의 parent 수집 → S_new
4. S = S_old ∪ S_new  (objectType='service' 필터)
5. for each s in S, 같은 트랜잭션 내에서:
   a. DELETE FROM object_relations
      WHERE workspace_id = ?
        AND subject_object_id = s
        AND relation_type = 'implements'
        AND source = 'DISCOVERY'
   b. SELECT s 의 자식 (function/api_endpoint 만) 의 도메인 할당 분포 계산
   c. 도메인별로 INSERT
```

이 재계산을 approve 와 같은 트랜잭션에 묶지 않으면 "부분 상태" (자식 변경은 반영됐으나 implements 는 옛날 값) 가 노출된다.

---

## 6. 데이터 모델 쿼리 관점

본 설계 이후 도메인 X 의 "참여자" 를 묻는 두 쿼리는 의미가 다르다.

```sql
-- 멤버 (논리 단위)
SELECT oda.*
FROM object_domain_affinities oda
JOIN objects o ON o.id = oda.object_id
WHERE oda.domain_id = :X
  AND o.object_type IN ('function', 'api_endpoint', 'topic', 'queue', 'database', 'db_table')

-- 구현 서비스 (물리 단위)
SELECT r.*
FROM object_relations r
WHERE r.object_id = :X
  AND r.relation_type = 'implements'
  AND r.source = 'DISCOVERY'
```

한 서비스의 "구현 비율" 질의:

```sql
SELECT d.id, d.name, r.confidence, r.metadata
FROM object_relations r
JOIN objects d ON d.id = r.object_id
WHERE r.subject_object_id = :serviceId
  AND r.relation_type = 'implements'
ORDER BY r.confidence DESC
```

---

## 7. UI 의미 변화

### 7.1 발견 preview 카드

- 멤버 목록: function / api_endpoint 등 논리 단위만 표시. 서비스는 멤버로 노출되지 않음
- 신규 섹션 "이 도메인을 구현하는 서비스": `RobotService (6/10)`, `LegacyAdminSvc (2/5)` 형태
  - 괄호는 `childInDomain / childTotal` (코드 단위 자식 = `function` / `api_endpoint` 기준. storage/channel 자식은 제외)
  - 아직 DB 에 저장되지 않은 값이지만, 서버가 discover 응답에 `implementingServices` 필드로 함께 내려준다 — 클라이언트는 그 값을 그대로 표시 (계산 책임은 서버).  구체 계약은 SPEC §6.2 참조.

### 7.2 `/domains/[id]` 상세 페이지

섹션을 분리:

- **멤버** (function / endpoint / topic / queue / ...)
- **구현 서비스** (implements 관계 기반)
- 각 구현 서비스 카드에 비중 바 + "N/M children" + 시각 계층

### 7.3 도메인 카드

워크스페이스 `/domains` 목록 카드에 "구현 서비스 N개" 배지 추가 (선택 — 스펙에서 결정).

---

## 8. 폐기 / 유지 / 변경

| 자산 | 상태 | 비고 |
|---|---|---|
| `objectDomainAffinities` 테이블 | 유지 | 의미를 "멤버십 전용" 으로 정리 |
| `objectDomainAffinities` 에 service row 저장 | **폐기** | 본 설계 이후 service 는 여기에 들어가지 않음 |
| `objectRelations` 에 `implements` 타입 | **신규** | relationType 값 추가 (DDL 변경 없음) |
| `objectRelations.source = 'DISCOVERY'` | **신규** | enum 값 추가 (DDL 변경 없음) |
| discover 라우트의 objects pool | 변경 | `objectType !== 'service'` 필터 추가 |
| approve 라우트 | 변경 | 멤버 affinity insert 후 영향받은 service 의 implements 재계산 로직 추가 |
| `/domains/[id]` 상세 페이지 | 확장 | 구현 서비스 섹션 추가 (이 PR 범위 내) |

---

## 9. 비목표 / 후속 PR

이번 PR 범위 밖:

- `database` / `message_broker` 객체의 implements 관계. 현재 철학으로는 도메인 소속/구현이라기보다 "서비스가 사용하는 외부 자원". 별도 설계 주제
- **relation 기반 storage/channel 귀속** — `db_table` / `topic` / `queue` 같은 storage/channel 객체를 implements 분자에 포함시키려면 `read` / `write` / `produce` / `consume` 관계를 통해 "어느 서비스가 어느 자원을 사용하는가" 를 집계해 귀속해야 한다. 이는 relation 집계 규칙 (공유 자원 시 비율 분배 등) 에 대한 별도 설계가 필요하므로 후속 PR
- `objectRelations` 를 통한 domain ↔ domain 관계 모델링 (예: `depend_on`)
- 서비스가 "어떤 도메인도 구현하지 않는 상태" (자식이 전부 미승인) 의 UI 표현. 기본적으로 숨김 처리 가능하나 해당 서비스의 상세 페이지에서 "도메인 미분류 N개 자식" 안내 정도는 후속 고려
- 경로 기반 슬러그 확장 (예: `/robots/models` 을 하위 슬러그로 추출해 다책임 서비스를 자동 분할) — 별개 설계 주제 (이번 PR 은 intent route/topic prefix + name token 신호 그대로 사용)

---

## 10. 검증 관점

- 다책임 서비스 샘플: 로봇관리 서비스 (자식 10개가 여러 route prefix 를 가지는 구조) 에서 자식이 intent route 기반으로 도메인 별로 분리 클러스터 되는지 + 서비스가 여러 implements 행을 가지는지
- 모놀리스 샘플: 자식이 `/orders/*`, `/payments/*`, `/inventory/*` 로 나뉜 단일 서비스에서 3개 implements 행이 생성되는지 + 각 confidence 합 ≤ 1 인지
- 재승인 시나리오: 같은 서비스 자식에 후속 승인 추가 시 implements 행이 올바르게 분모/분자 반영하는지
- **Stale parent 재계산 시나리오** (Codex 지적 반영): 도메인 D 의 이전 멤버가 ServiceA 에도 ServiceB 에도 있었는데, 재approve payload 에서 ServiceB 관련 멤버가 전부 빠진 경우 ServiceB 의 `implements(D)` 도 재계산되어 stale 하게 남지 않는지
- 커버리지 < 1 시나리오: `1 - Σ(confidence)` 가 미분류 자식 비율과 일치하는지
- **Storage/channel 배제 시나리오**: `db_table`, `topic`, `queue` 가 도메인 멤버로는 들어가되 implements 분자/분모에는 영향을 주지 않는지
- **초기 스캔 상태 precondition**: 워크스페이스에 service 외 객체가 없는 상태에서 discover 호출 시 400 `PREREQUISITE_NOT_MET` 로 명확히 실패하는지
