# Archi.Navi — Compound Dependency View Extension

작성일: 2026-02-23
문서 버전: v1.0
상태: Draft
구현 SPEC: [13-compound-view-implementation-spec.md](./13-compound-view-implementation-spec.md)

---

## 1. 목적

본 문서는 기존 Roll-up/Query 전략을 변경하지 않고, 그 위에 다음 기능을 정의한다.

- Compound 간 1레벨 의존성 그래프 (View-Level Graph)
- 특정 Compound에 대한 Atomic 단위 의존 근거 (Contributor) Drill-down
- 계층(Containment)과 의존(Dependency)의 구조적 분리 원칙

> **위치**: 본 문서는 [05-rollup-and-graph.md](./05-rollup-and-graph.md)의 Rollup/Navigation 전략을 전제로 하며, View 계층의 확장만을 다룬다.

---

## 2. 핵심 설계 원칙

### 2.1 Containment와 Dependency의 분리

| 구분 | Containment | Dependency |
|------|-------------|------------|
| 의미 | 포함/소속 관계 | 호출/읽기/쓰기/발행/구독 |
| 그래프 유형 | Tree (parent_id 기반) | Directed Graph |
| 저장 단위 | Object.parent_id | object_relations |
| 목적 | 스코프, 네비게이션 | 영향도, 흐름 분석 |
| Roll-up | 없음 | Compound 레벨에서 파생 |

### 2.2 Dependency 저장 규칙

기존 [02-data-model.md](./02-data-model.md) Section 2.3의 정규 저장 원칙을 따른다.

- Dependency는 **최소 한쪽이 Atomic**인 관계로 저장한다.
- Compound ↔ Compound edge는 직접 저장하지 않는다.
- Compound edge는 항상 Atomic edge의 Roll-up 파생으로 생성된다.

> **향후 확장**: source 측도 Atomic으로 정규화하는 점진적 Atomicization을 검토할 수 있다.
> 예: service 내부에 synthetic atomic(`__service_root__`)을 생성하여 Atomic ↔ Atomic 정규형으로 전환.
> 단, 현재 단계에서는 기존 Compound → Atomic 패턴을 유지한다.

---

## 3. 개념 모델

### 3.1 Object 유형

| 구분 | Compound (집합체) | Atomic (원자 단위) |
|------|---|---|
| COMPUTE | `service` | `api_endpoint`, `function` |
| STORAGE | `database`, `cache_instance` | `db_table`, `db_view`, `cache_key` |
| CHANNEL | `message_broker` | `topic`, `queue` |

> `domain`은 Containment 계층이 아닌 Affinity 기반 소속이므로 아래 Section 3.3에서 별도 정의한다.

### 3.2 Containment 모델

기존 스키마의 Materialized Path 전략을 그대로 사용한다.

| 속성 | 역할 |
|------|------|
| `objects.parent_id` | 직계 부모 참조 |
| `objects.path` | Materialized path (예: `/{db_id}/{table_id}`) |
| `objects.depth` | 계층 깊이 |

subtree 해소:

```sql
-- Containment Compound의 subtree 조회
SELECT id FROM objects
WHERE workspace_id = :ws
  AND path LIKE :compound_path || '/%'
```

### 3.3 Compound 유형 구분

본 문서에서 Compound는 두 가지로 구분한다.

| 유형 | 예시 | 소속 메커니즘 | subtree 해소 |
|------|------|---|---|
| **Containment Compound** | service, database, message_broker, cache_instance | `parent_id` 계층 | `objects.path` LIKE 필터 |
| **Affinity Compound** | domain | `object_domain_affinities` | affinity ≥ threshold 필터 |

Affinity Compound의 subtree 해소:

```sql
-- Domain(Affinity Compound)의 "가상 subtree" 조회
SELECT oda.object_id
FROM object_domain_affinities oda
WHERE oda.workspace_id = :ws
  AND oda.domain_id = :domain_id
  AND oda.affinity >= :threshold   -- 기본 0.2
```

> 이 구분은 Section 4의 Roll-up 공식과 Section 5의 Contributor Drill-down에서 `subtree()` 함수의 해소 규칙으로 적용된다.

### 3.4 Dependency 모델

기존 `object_relations` 테이블을 그대로 사용한다.

핵심 속성 (기존 스키마 참조):

| 속성 | 역할 |
|------|------|
| `workspace_id` | 멀티 워크스페이스 격리 |
| `relation_type` | call, expose, read, write, produce, consume, depend_on |
| `subject_object_id` | source object |
| `object_id` | target object |
| `interaction_kind` | CONTROL, DATA, ASYNC, STATIC |
| `confidence` | 신뢰도 (0~1) |
| `source` | MANUAL, INFERRED, ROLLUP |
| `valid_from / valid_to` | Temporal Architecture |

> 전체 스키마는 [02-data-model.md](./02-data-model.md) Section 4.1 `object_relations` 참조.

---

## 4. Compound 1-Level Dependency Graph

### 4.1 정의

Compound 간 edge는 Atomic 관계를 집계하여 파생한다.

**일반 원칙:**

```
Edge(C_src → C_dst, type)
=
count(
  relation r
  WHERE r.subject_object_id IN subtree(C_src)
    AND r.object_id IN subtree(C_dst)
    AND r.relation_type = type
)
```

> 이 공식은 개념적 원칙이다. 각 Rollup Level의 구체적 계산 규칙(call + expose 결합 등)은 [05-rollup-and-graph.md](./05-rollup-and-graph.md) Section 3을 따른다.

### 4.2 속성

| 속성 | 설명 |
|------|------|
| weight | 기여 atomic edge 수 |
| confidence | avg(base.confidence) |
| types | distinct relation_type 목록 |
| direction | directed |
| 저장 | `object_rollups`에 Materialized 저장 (기존 전략 유지) |

### 4.3 Rollup Level 매핑

Compound 유형 조합에 따라 기존 Rollup Level로 매핑된다.

| Source Compound | Target Compound | Rollup Level |
|---|---|---|
| service | service | SERVICE_TO_SERVICE |
| service | database | SERVICE_TO_DATABASE |
| service | message_broker | SERVICE_TO_BROKER |
| domain | domain | DOMAIN_TO_DOMAIN |

---

## 5. View-Level Specification

### 5.1 View 1: Compound Level Graph

**노드**: Compound 객체만 표시

**엣지**: Roll-up된 Compound edge (기존 `object_rollups` 조회)

**필터:**

| 필터 | 옵션 |
|------|------|
| direction | inbound / outbound / both |
| relation_type | call, read, write, produce, consume |
| min_weight | 최소 edge weight 임계값 |
| visibility | VISIBLE_ONLY / INCLUDE_HIDDEN |

**스코프:**

| 모드 | 설명 |
|------|------|
| SUBTREE | 선택된 root compound의 subtree 내부만 (기본) |
| GLOBAL | 전체 workspace 범위 |

**weight 시각화**: edge_weight 기반 두께 조절 가능

### 5.2 View 2: Atomic Contributor Drill-down

**목적**: 다음 질문에 답한다.

- A Compound의 Atomic들은 어떤 Compound에 의해 사용되는가? (Inbound)
- A Compound는 어떤 Compound의 Atomic을 사용하는가? (Outbound)

### 5.3 Contributor 정의

**Outbound Contributors (A → X):**

A에 속한 관계가 X에 속한 Atomic을 대상으로 하는 관계

```sql
SELECT r.*
FROM object_relations r
  JOIN objects src ON r.subject_object_id = src.id
  JOIN objects dst ON r.object_id = dst.id
WHERE src.path LIKE :compound_a_path || '%'
  AND dst.path LIKE :compound_x_path || '%'
```

**Inbound Contributors (X → A):**

X에 속한 관계가 A에 속한 Atomic을 대상으로 하는 관계

```sql
SELECT r.*
FROM object_relations r
  JOIN objects src ON r.subject_object_id = src.id
  JOIN objects dst ON r.object_id = dst.id
WHERE src.path LIKE :compound_x_path || '%'
  AND dst.path LIKE :compound_a_path || '%'
```

> Affinity Compound(domain)의 경우 `path LIKE` 대신 `object_domain_affinities` JOIN으로 대체한다.

### 5.4 Contributor View 구성

**1단계: Compound 그룹핑**

| 상대 Compound | Weight | Type Summary |
|---|---|---|
| Order Service | 12 | call(8), read(4) |
| Payment DB | 5 | write(3), read(2) |

**2단계: Atomic 상세 리스트**

edge 클릭 시 해당 Compound 쌍의 Atomic 관계를 표시한다.

| Source Object | Target Object | Type | Confidence | Evidence |
|---|---|---|---|---|
| OrderService | PaymentAPI.createPayment | call | 0.92 | OrderController.java:120 |
| OrderService | PaymentAPI.getStatus | call | 0.88 | OrderService.java:45 |

### 5.5 Grouping 전략

Contributor 목록의 그룹핑 옵션:

| groupBy | 설명 | 용도 |
|---------|------|------|
| `targetCompound` | 상대 Compound 기준 (기본) | 어떤 서비스와 관계가 있는지 개요 확인 |
| `sourceAtomic` | source 측 Atomic 기준 | 내 어떤 컴포넌트가 외부 의존을 만드는지 확인 |
| `targetAtomic` | target 측 Atomic 기준 | 상대 서비스의 어떤 인터페이스를 사용하는지 확인 |
| `relationType` | 관계 타입 기준 | call/read/write 등 상호작용 유형별 분석 |

---

## 6. UX 규칙

### 6.1 기본 원칙

- 한 화면에서 **계층(Containment) + 전체 의존(Dependency)을 동시에 펼치지 않는다**.
- 항상 **선택된 스코프(subtree)** 기준으로 렌더링한다.
- Drill-down은 **누적이 아니라 치환(replace)** 방식으로 수행한다.

### 6.2 Interaction Flow

```
[1] Compound Graph 표시
     (Architecture View: SERVICE_TO_SERVICE Rollup)
          │
          ▼ edge 클릭 (A → B)
[2] Contributor Panel 오픈
     (A → B 간 Atomic 근거 표시)
          │
          ▼ 개별 Atomic 관계 클릭
[3] Evidence Detail
     (근거 파일/라인/발췌문 표시)
```

### 6.3 기존 Navigation과의 관계

본 문서의 View는 기존 [05-rollup-and-graph.md](./05-rollup-and-graph.md) Section 10의 Navigation 전략과 다음과 같이 통합된다.

| 기존 Navigation | 본 문서의 확장 |
|---|---|
| DOMAIN_TO_DOMAIN → SERVICE_TO_SERVICE → Atomic Drill-down | 변경 없음 |
| Architecture View (SERVICE_TO_SERVICE) | Compound Graph (View 1)로 확장 |
| Object Mapping (Atomic drill-down) | Contributor Drill-down (View 2)으로 확장 |

---

## 7. Query Engine 연동

### 7.1 탐색 전략

기존 [04-query-engine.md](./04-query-engine.md)의 전략을 따른다.

- **기본 탐색**: Rollup 그래프(`object_rollups`) 기준으로 수행한다.
- **Atomic 그래프**: Drill-down 또는 Rollup 재계산 시점에만 사용한다.
- **Compound**: 필터/집계 역할을 수행한다.

### 7.2 Contributor 조회 흐름

```
1. Compound Graph에서 edge 선택 (A → B)
2. object_rollups에서 해당 rollup edge 조회 (fast path)
3. rollup의 base relation 추적 (object_relations JOIN)
4. Atomic 단위 contributor 목록 반환
5. Evidence 체인 연결 (relation_evidences → evidences)
```

### 7.3 Scope Mode

| scopeMode | 설명 |
|-----------|------|
| SUBTREE | 선택된 root compound의 하위만 탐색 (기본) |
| GLOBAL | workspace 전체 범위 탐색 |

---

## 8. 성능 전략

### 8.1 기존 인프라 활용

Compound View의 성능은 기존 Materialized Rollup 전략에 의존한다.

| 조회 유형 | 데이터 소스 | 성능 특성 |
|---|---|---|
| Compound Graph | `object_rollups` (ACTIVE generation) | O(1) ~ O(edges) |
| Contributor Drill-down | `object_relations` + `objects.path` | O(subtree_size) |
| Evidence 추적 | `relation_evidences` → `evidences` | O(evidence_count) |

### 8.2 추가 인덱스 권장

Contributor 조회 성능을 위해 다음 인덱스를 권장한다.

```sql
-- Contributor 조회: source의 path prefix 기반 탐색
CREATE INDEX ix_objects_ws_path_prefix
  ON objects(workspace_id, path text_pattern_ops);
```

> 기존 `ix_objects_ws_path` 인덱스가 LIKE 쿼리에 충분하다면 추가 불필요.

### 8.3 Rollup 저장

Compound edge는 기존 `object_rollups` 테이블에 저장된다. 별도 캐시 테이블을 추가하지 않는다.

---

## 9. Approval Queue 고려사항

기존 Approval Queue 체계([02-data-model.md](./02-data-model.md) Section 6)를 유지한다.

| 기존 트랙 | 대상 | 변경 사항 |
|---|---|---|
| Relation 승인 (`relation_candidates`) | Atomic 관계 추가/삭제 | 없음 |
| Domain 승인 (`domain_candidates`) | Domain affinity 변경 | 없음 |

Containment 변경(`parent_id` 수정)은 현재 수동 편집으로 처리되며, 별도 승인 트랙이 필요할 경우 향후 정의한다.

---

## 10. 보장되는 기능

이 View Extension을 적용하면 다음이 가능하다.

- Compound 1레벨 의존성 그래프 시각화
- A Compound의 Atomic이 어떤 Compound에 의해 사용되는지 확인 (Inbound Contributor)
- A Compound가 어떤 Compound의 Atomic을 사용하는지 확인 (Outbound Contributor)
- Atomic 단위 근거 추적 (Evidence Chain)
- 기존 Rollup 기반 정확성 보장

---

## 11. 금지 사항

- Compound ↔ Compound 관계를 `object_relations`에 직접 저장하지 않는다.
- Dependency에 parent/child(Containment) 개념을 혼입하지 않는다.
- View 확장을 누적(accumulate) 방식으로 구현하지 않는다. 항상 치환(replace) 방식을 사용한다.
- 기존 Rollup Level 계산 규칙을 본 문서에서 재정의하지 않는다.

---

## 12. 구현 체크리스트 (2026-03-02 기준)

- [x] Compound Graph View (Rollup 기반 1-level graph 렌더링)
- [x] Contributor Drill-down Panel (edge 클릭 → Atomic 근거 목록)
- [x] Contributor Grouping 옵션 (targetCompound, sourceAtomic, targetAtomic, relationType)
- [x] Affinity Compound subtree 해소 (domain의 가상 subtree 조회)
- [x] Evidence Chain 연결 (Contributor → relation_evidences → evidences)
- [x] Scope Mode 전환 (SUBTREE / GLOBAL)
- [ ] 기존 Navigation Flow 통합 (Architecture View → Contributor → Evidence)

현재 구현 범위:
- grouping `targetCompound`, `relationType`, `sourceAtomic`, `targetAtomic` 제공
- Scope Mode `SUBTREE`, `GLOBAL` 토글 제공
- Domain edge의 contributor 조회 시 `object_domain_affinities` 기반 subtree 해소 적용

---

## 관련 문서

| 문서 | 관계 |
|------|------|
| [02-data-model.md](./02-data-model.md) | Object/Relation 스키마, Approval Queue 정의 |
| [04-query-engine.md](./04-query-engine.md) | Rollup 기반 탐색 전략, Evidence Chain |
| [05-rollup-and-graph.md](./05-rollup-and-graph.md) | Rollup Level 계산 규칙, Navigation 전략 |
| [03-inference-engine.md](./03-inference-engine.md) | Relation/Domain 추론 → 승인 → Rollup 재빌드 |
