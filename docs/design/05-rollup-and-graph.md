# Archi.Navi — Roll-up 전략 및 그래프 제공

작성일: 2026-02-22
최종 갱신: 2026-03-31
문서 버전: v3.0

---

## 1. 설계 목표

Roll-up의 목적은 atomic relation을 상위 탐색용 그래프로 materialize하여
빠른 query, mapping, architecture view를 가능하게 하는 것이다.

설계 목표는 아래와 같다.

| 목표 | 설명 |
|------|------|
| **정합성 유지** | base relation 승인 결과와 rollup이 구조적으로 일치해야 한다. |
| **부분 반영 우선** | 가능한 경우 full rebuild 대신 delta rebuild를 사용한다. |
| **실시간 UI 동기화** | rollup 변경은 SSE notification으로 UI에 전파한다. |
| **증거 추적 유지** | rollup edge에서 base relation까지 provenance를 유지한다. |
| **대규모 그래프 대응** | graph cache, hub stats, progressive rendering을 조합한다. |

---

## 2. Roll-up Level

공용 상수 기준 rollup level은 아래 4개다.

| Level | 의미 |
|-------|------|
| `SERVICE_TO_SERVICE` | 서비스 간 제어/정적 의존 |
| `SERVICE_TO_DATABASE` | 서비스와 데이터 저장소 관계 |
| `SERVICE_TO_BROKER` | 서비스와 메시지 채널 관계 |
| `DOMAIN_TO_DOMAIN` | 도메인 간 집계 관계 |

---

## 3. 계산 규칙

## 3.1 SERVICE_TO_SERVICE

기본 원칙:

```text
service A --call--> api_endpoint E
service B --expose--> api_endpoint E
-----------------------------------
service A --call--> service B
```

집계 속성:

- `edgeWeight`: 기여한 base relation 수
- `confidence`: 기여 relation confidence 평균

`depend_on`은 원자 관계로 환원하기 어려운 정적 의존에 한해 예외적으로 포함될 수 있다.

## 3.2 SERVICE_TO_DATABASE

```text
service S --read/write--> db_table T
db_table T.parent = database D
-----------------------------------
service S --read/write--> database D
```

## 3.3 SERVICE_TO_BROKER

```text
service S --produce/consume--> topic T
topic T.parent = message_broker B
------------------------------------
service S --produce/consume--> message_broker B
```

## 3.4 DOMAIN_TO_DOMAIN

입력:

- service-level rollup
- `object_domain_affinities`

원칙:

- affinity threshold 이하의 약한 소속은 무시할 수 있다.
- 서비스 edge 기여도를 도메인 affinity 비율로 분배해 누적한다.
- provenance는 별도 domain 전용 테이블이 아니라
  `object_rollup_provenances` 체인을 통해 일관되게 유지한다.

---

## 4. 저장 구조

rollup 관련 저장소는 아래와 같다.

| 테이블 | 역할 |
|--------|------|
| `object_rollups` | materialized rollup edge |
| `object_rollup_provenances` | rollup edge → base relation provenance |
| `rollup_generations` | generation 상태 관리 |
| `object_graph_stats` | node별 in/out degree |

문서 기준으로는 `object_rollup_provenances`가 표준 provenance 테이블이다.

---

## 5. Generation 관리

## 5.1 기본 개념

모든 query와 graph view는 특정 `generationVersion`을 기준으로 읽는다.
명시하지 않으면 active generation을 사용한다.

## 5.2 상태

| 상태 | 의미 |
|------|------|
| `BUILDING` | rollup 생성 중 |
| `ACTIVE` | 조회 기준 generation |
| `ARCHIVED` | 과거 generation |

## 5.3 full rebuild 경로

full rebuild는 여전히 기준 경로로 남아 있다.

```text
approved relations snapshot
  ↓
new generation 생성
  ↓
level별 rollup 계산
  ↓
graph stats 계산
  ↓
ACTIVE 전환
```

이 경로는 parity 기준선이자 recovery 경로다.

---

## 6. 기본 운영 경로: Delta Rollup

shipped 동작의 중심은 full rebuild가 아니라 **delta rollup**이다.

## 6.1 입력 이벤트

rollup 변경 이벤트는 아래 mutation에서 발생한다.

- 관계 후보 승인
- 수동 relation 추가
- 승인된 base relation 삭제
- `expose` 변경
- endpoint batch mapping

## 6.2 처리 흐름

```text
mutation 발생
  ↓
change event 생성
  ↓
applyRollupChanges(db, workspaceId, events)
  ↓
incrementalRebuild(...)
  ↓
publishRollupChangeNotification(...)
```

## 6.3 운영 원칙

- 가능한 한 generation 전체를 다시 만들지 않는다.
- 여러 endpoint mapping change는 batch로 묶어 1회 delta rebuild 한다.
- full rebuild와 delta rebuild의 최종 상태는 parity 기준으로 검증한다.

---

## 7. 그래프 제공 계층

## 7.1 Graph Index

`packages/core/src/graph-index`는 generation별 graph cache를 관리한다.

역할:

- generation/version별 graph instance 재사용
- query engine의 탐색 성능 확보
- rollup level별 adjacency 기반 계산 지원

## 7.2 Graph Stats

`object_graph_stats`는 UI가 허브 노드를 빠르게 판단하도록 돕는다.

활용:

- hub threshold 기반 collapse
- architecture/mapping view에서 node 강조 및 필터링

---

## 8. 실시간 동기화

UI 실시간 반영 계약은 **edge delta push**가 아니라
**SSE notification + 뷰 refetch**다.

## 8.1 서버 계약

연결:

```text
GET /api/rollup-events?workspaceId={id}
```

이벤트:

- `connected`
- `rollup-change`

`rollup-change`는 rollup 재계산 원인이 된 change event 요약을 포함한다.

## 8.2 클라이언트 계약

- `EventSource` 지원 시 SSE 연결
- `rollup-change` 수신 시 뷰 refetch
- 미지원/생성 실패/에러 시 polling fallback
- 기본 polling 주기: `5000ms`

즉, 제품은 실시간성을 유지하되,
클라이언트 상태 동기화를 과도하게 복잡한 프로토콜로 만들지 않는다.

---

## 9. UI 성능 전략

graph UI는 rollup 자체뿐 아니라 렌더링 전략과 함께 설계된다.

| 전략 | 적용 위치 |
|------|-----------|
| progressive rendering | mapping graph / 대규모 그래프 렌더링 |
| hub collapse | mapping graph, layered architecture |
| 3D renderer | object mapping graph |
| contributor drill-down | rollup edge 상세 확인 |
| domain-first navigation | 대규모 graph 범위 축소 |

즉, rollup 문서는 계산만이 아니라 “어떻게 UI에 안전하게 노출할 것인가”까지 포함해야 한다.

---

## 10. 설계 방향

## 10.1 유지하는 방향

- atomic relation을 기준으로 rollup을 materialize한다.
- 운영 경로는 delta rebuild를 기본으로 하고, full rebuild는 기준선/복구선으로 유지한다.
- UI 실시간 반영은 SSE notification + refetch로 단순화한다.
- provenance와 graph stats를 rollup의 부속 정보가 아니라 필수 정보로 간주한다.

## 10.2 아직 하지 않는 것

- WebSocket 기반 edge delta patch protocol
- 다중 사용자 협업 동기화
- 클라이언트에서 rollup edge를 직접 patch하는 복잡한 상태 머신

---

## 11. 관련 문서

- [04-query-engine.md](./04-query-engine.md)
- [06-compound-view.md](./06-compound-view.md)
- [../spec/05-incremental-rollup-rebuild-spec.md](../spec/05-incremental-rollup-rebuild-spec.md)
- [../spec/21-realtime-rollup-spec.md](../spec/21-realtime-rollup-spec.md)
