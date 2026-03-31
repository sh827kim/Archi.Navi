# Archi.Navi — Compound View / Mapping Graph

작성일: 2026-02-23
최종 갱신: 2026-03-31
문서 버전: v2.0
상태: Shipped 기준 문서
구현 SPEC: [03-compound-view-implementation-spec.md](../spec/03-compound-view-implementation-spec.md)

---

## 1. 목적

Compound View는 atomic relation 저장 원칙을 깨지 않으면서,
운영자가 상위 구조를 빠르게 탐색하고 필요 시 atomic 증거까지 내려갈 수 있게 하는
**mapping graph 전용 projection**이다.

제품에서는 `/mapping-graph` 화면이 이 문서의 구현 대상이다.

---

## 2. UI 범위

mapping graph는 단일 “compound graph”를 넘어 아래 view level을 제공한다.

| View Level | 설명 |
|------------|------|
| `SERVICE_TO_SERVICE` | 서비스 간 rollup 관계 |
| `SERVICE_TO_DATABASE` | 서비스-데이터 저장소 관계 |
| `SERVICE_TO_BROKER` | 서비스-브로커 관계 |
| `DOMAIN_TO_DOMAIN` | 도메인 간 관계 |
| `COMPOUND_VIEW` | 여러 compound 유형을 함께 보는 통합 뷰 |
| `UNUSED_ATOMIC` | 사용되지 않는 atomic object 탐색 |

즉, Compound View는 “compound 관계 1개 화면”이 아니라
**rollup graph 기반 탐색 워크벤치**에 가깝다.

---

## 3. 핵심 설계 원칙

## 3.1 Containment와 Dependency 분리

| 구분 | Containment | Dependency |
|------|-------------|------------|
| 의미 | 포함/소속 | 호출/읽기/쓰기/발행/구독/정적 의존 |
| 주 저장소 | `objects.parent_id`, `objects.path` | `object_relations` |
| 상위 시각화 | subtree 해소 | rollup edge |
| 목적 | 탐색 범위, drill-down 기준 | 영향도와 연결 흐름 |

## 3.2 Atomic 저장, Compound 파생

- base relation은 가능한 한 atomic 기준으로 저장한다.
- compound 간 edge는 `object_rollups`에서 파생한다.
- contributor drill-down은 rollup edge를 다시 atomic relation으로 펼쳐 보여준다.

## 3.3 Domain은 Affinity Compound

`service`, `database`, `message_broker`는 containment compound지만,
`domain`은 subtree를 `parent_id`가 아니라 `object_domain_affinities`로 해석하는
**affinity compound**다.

---

## 4. 데이터 소스

| 목적 | 기본 데이터 소스 |
|------|------------------|
| 상위 그래프 렌더링 | `object_rollups` |
| hub 판정 | `object_graph_stats` |
| contributor drill-down | `object_relations` + evidence |
| domain membership | `object_domain_affinities` |
| 실시간 갱신 | `/api/rollup-events` |

상위 그래프는 rollup을 기준으로 하고,
필요할 때만 atomic relation과 evidence를 열어보는 구조를 기준으로 한다.

---

## 5. Interaction 모델

## 5.1 3D 그래프 렌더러

mapping graph는 `3d-force-graph` 기반 렌더러를 사용한다.

목적:

- 대규모 그래프에서 depth 분리
- hover/click highlight
- node focus camera 이동
- compound/atomic/hub 구분을 색상과 크기로 표현

## 5.2 Domain-first / Service drill-down

대규모 그래프를 한 번에 펼치지 않기 위해 UI는 아래 흐름을 지원한다.

```text
도메인 선택
  ↓
해당 서비스 범위 집중
  ↓
서비스 또는 링크 선택
  ↓
roll-down / contributor 패널
```

이 방식은 “전체 그래프를 다 본다”보다
**탐색 범위를 단계적으로 좁힌다**는 방향에 가깝다.

## 5.3 Hub 제어

허브는 숨기지 않지만 기본적으로 접힌 상태로 시작할 수 있다.

제어 요소:

- hub threshold
- collapsed/expanded 상태
- hub node count 표시

## 5.4 실시간 반영

mapping graph는 `/api/rollup-events`의 `rollup-change`를 받아 뷰를 다시 조회한다.

- SSE 지원 시 EventSource 사용
- 실패 시 polling fallback

---

## 6. Contributor Drill-down

Contributor View는 compound edge의 “왜 이런 연결이 생겼는가”를 설명하는 핵심 기능이다.

## 6.1 질의

라우트:

```text
GET /api/mapping/contributors
```

지원 축:

- `groupBy`
  - `targetCompound`
  - `relationType`
  - `sourceAtomic`
  - `targetAtomic`
- `scopeMode`
  - `SUBTREE`
  - `GLOBAL`

## 6.2 표시 구조

contributor 패널은 아래 순서로 정보를 노출한다.

1. summary
   - total count
   - relation type별 분포
2. grouped relations
3. 개별 atomic relation
4. evidence 목록

즉, 상위 엣지에서 바로 파일 근거까지 내려갈 수 있어야 한다.

## 6.3 의미

Contributor는 단순 부가 기능이 아니라,
rollup graph가 “블랙박스 집계”로 보이지 않게 만드는 explainability 장치다.

---

## 7. Roll-down / Unused Atomic

mapping graph는 contributor 외에도 두 가지 보조 탐색을 지원한다.

## 7.1 Roll-down

선택한 compound에 대해:

- 어떤 atomic이 외부에 노출되어 있는지
- 어떤 atomic이 외부 compound를 참조하는지

를 패널 형태로 보여준다.

## 7.2 Unused Atomic

`UNUSED_ATOMIC` 뷰는 어떤 atomic object가 사용되지 않는지 확인한다.

이 뷰의 목적은 orphan endpoint/table/topic처럼
구조상 존재하지만 연결되지 않은 요소를 빠르게 찾는 것이다.

---

## 8. Compound 해석 규칙

## 8.1 Containment Compound

예시:

- `service`
- `database`
- `message_broker`
- `cache_instance`

subtree 해소는 `objects.path` 또는 `parent_id` 기반이다.

## 8.2 Affinity Compound

예시:

- `domain`

subtree 해소는 `object_domain_affinities`와 threshold 기반이다.

compound view는 이 둘을 같은 그래프에 보여줄 수 있지만,
subtree 해소 규칙은 내부적으로 다르다.

---

## 9. 설계 방향

## 9.1 유지하는 방향

- 상위 구조는 rollup으로 단순화하고, 세부는 contributor/roll-down으로 단계적으로 공개한다.
- domain-first, hub collapse, 3D renderer를 조합해 대규모 그래프를 탐색 가능하게 만든다.
- SSE refetch 기반으로 뷰를 최신 rollup 상태에 맞춘다.
- compound view는 시각화 자체보다 “설명 가능한 탐색”을 우선한다.

## 9.2 아직 하지 않는 것

- rollup edge delta를 클라이언트 그래프에 직접 patch
- 실시간 공동 편집
- 복수 그래프 뷰 간 복잡한 linked selection 상태 공유

---

## 10. 관련 문서

- [05-rollup-and-graph.md](./05-rollup-and-graph.md)
- [../spec/02-object-mapping-3d-renderer-spec.md](../spec/02-object-mapping-3d-renderer-spec.md)
- [../spec/03-compound-view-implementation-spec.md](../spec/03-compound-view-implementation-spec.md)
- [../spec/07-progressive-rendering-spec.md](../spec/07-progressive-rendering-spec.md)
- [../spec/08-domain-first-navigation-spec.md](../spec/08-domain-first-navigation-spec.md)
