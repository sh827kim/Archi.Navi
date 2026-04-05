# 09. Intent-Centric Proof Engine Overview

상태: Proposed
적용 방식: Full Replacement
대상: [03-inference-engine.md](./03-inference-engine.md), [07-inference-engine-advanced.md](./07-inference-engine-advanced.md)의 핵심 추론 커널 대체
작성일: 2026-03-31
최종 정리: 2026-04-03

---

## 1. 문서 목적

이 문서는 Archi.Navi 추론 엔진을 **Intent-Centric Proof Engine**으로 재설계하는 기준 개요 문서다.

핵심 방향은 한 줄로 요약된다.

> service pair를 먼저 만들고 endpoint를 나중에 찾는 구조를 버리고, interaction intent를 seed로 삼아 atomic target까지 proof를 닫은 뒤에만 candidate를 만든다.

이번 정리에서는 기존의 장문 문서를 다음처럼 분리했다.

- 이 문서: 배경, 목표, 핵심 결정, 상위 구조
- [10-intent-centric-proof-engine-state-model.md](./10-intent-centric-proof-engine-state-model.md): 추출 레이어, 상태/데이터 모델, schema
- [11-intent-centric-proof-engine-resolution-pipeline.md](./11-intent-centric-proof-engine-resolution-pipeline.md): fixed resolution pipeline, frontier, agent, projection
- [12-intent-centric-proof-engine-adoption-plan.md](./12-intent-centric-proof-engine-adoption-plan.md): 구현 교체, UI/운영, 성능, cutover 기준

---

## 2. 문제 정의

기존 추론 구조의 한계는 아래 다섯 가지로 정리된다.

1. `service pair`를 먼저 만든 뒤 atomic target을 찾는다.
2. `candidate`를 먼저 만들고 supporting evidence와 validation을 뒤에 붙인다.
3. path-only, alias-only, wrapper-only 같은 partial evidence가 중간에 손실된다.
4. provider service가 보이면 candidate fan-out 또는 service fallback으로 precision이 깨진다.
5. LLM/Agent가 판정기처럼 동작해 해석 결과가 재사용 가능한 실행 상태로 남지 않는다.

이 구조는 service-level recall은 만들기 쉽지만, 실제 품질 기준인 **atomic closure**에는 약하다.

대표 실패 패턴:

- `service -> service`는 맞는데 어떤 `api_endpoint`인지 닫히지 않음
- `config`, `route`, `wrapper`, `endpoint bootstrap` 정보가 결합되지 않음
- unresolved가 service fallback candidate에 묻혀 재시도 전략이 흐려짐
- gateway route가 실제로는 endpoint family를 가리키는데 단일 endpoint proof 경로가 모델에 없음

문제의 본질은 튜닝 부족이 아니라 **추론 출발점과 실행 상태 모델의 선택**이다.

---

## 3. 설계 목표

## 3.1 핵심 목표

1. 추론 seed를 `service pair`에서 `interaction intent`로 교체한다.
2. candidate보다 proof 상태를 먼저 다룬다.
3. partial evidence를 영구 손실 없이 보존한다.
4. candidate fan-out 기반 endpoint 후보 생성을 금지하고, bounded child proof derivation만 허용한다.
5. frontier를 실패 로그가 아니라 엔진의 주 실행 상태로 승격한다.
6. LLM/Agent를 pair 판정기가 아니라 frontier-local proof patcher로 제한한다.
7. atomic-first promotion, approval gate, rollup 철학은 유지한다.

## 3.2 비목표

- runtime tracing 기반 자동 확정
- 승인 없는 자동 promotion
- open-world global solver
- 기존 pair-first 경로와의 장기 병행 운영
- unresolved를 service fallback candidate로 남기는 절충안

---

## 4. 핵심 결정

## 4.1 seed = `InteractionIntent`

추론의 출발점은 서비스 쌍이 아니라, caller가 실제로 시도한 상호작용 의도다.

HTTP 계열은 두 family로 구분한다.

- `HTTP_CALL_INTENT`: function/callsite 기반 singular call intent
- `HTTP_GATEWAY_ROUTE_INTENT`: config-only gateway route family seed

그 외 seed는 아래를 포함한다.

- `DB_ACCESS_INTENT`
- `MESSAGE_PUBLISH_INTENT`
- `MESSAGE_CONSUME_INTENT`

## 4.2 candidate = `Closed Proof`의 projection

`relation_candidates`는 추론의 작업 공간이 아니다.
오직 atomic target까지 닫힌 proof만 candidate로 투영된다.

`HTTP_GATEWAY_ROUTE_INTENT` 같은 route-family seed는 직접 candidate가 되지 않는다.
이 seed는 route scope와 transform으로 좁혀진 endpoint-scoped child proof를 낳는 상위 입력 상태다.

## 4.3 service ↔ service는 결과의 rollup

service-level 관계는 추론의 seed나 fallback이 아니라, approved atomic relation에서 파생되는 요약 결과다.
service-level proof closure나 service-level candidate projection은 금지한다.

## 4.4 proof와 frontier는 실행 상태

proof/trace는 설명용 부가 정보가 아니다.
엔진이 실제로 읽고 쓰는 1급 실행 상태다.

route-family root proof는 “어떤 endpoint family까지 좁혀졌는가”를 보존하고,
child proof는 “어떤 atomic target까지 닫혔는가”를 보존한다.

## 4.5 실행은 범용 solver가 아니라 `Fixed Resolution Pipeline`

proof 상태를 저장하되, 해석은 타입별 고정 단계 파이프라인으로 제한한다.

예:

- summary hydrate
- host alias 해석
- provider service 결정
- route transform 적용
- route-family endpoint set derivation
- endpoint-scoped child proof spawn
- endpoint/table/topic 매칭
- contradiction/ambiguity 검증

## 4.6 agent는 frontier-local patcher

LLM/Agent는 relation truth를 선언하지 않는다.
대신 frontier 해소에 필요한 구조화 patch만 제안한다.

예:

- alias binding patch
- function summary patch
- route transform patch
- endpoint disambiguation hint

## 4.7 gateway route family는 상위 seed다

config-only gateway route는 단일 endpoint를 직접 가리키지 않을 수 있다.
따라서 이 경우의 proof 단위는 두 층으로 나뉜다.

- 상위 seed: `HTTP_GATEWAY_ROUTE_INTENT`
- 하위 child proof: endpoint-scoped atomic proof

“proof 하나당 하나의 atomic target” 규칙은 child proof 기준으로 적용한다.
route-family seed 자체는 projection 대상이 아니다.

---

## 5. 유지할 것과 버릴 것

## 5.1 유지할 것

- workspace 중심 격리
- approval gate
- approved relation만 `object_relations`에 반영
- atomic-first promotion
- compound/service view는 rollup과 projection으로 제공
- deterministic-first, AI-assisted 원칙

## 5.2 제거할 것

- `service pair`를 추론 seed로 두는 구조
- `configCodeBinding`의 provider endpoint fan-out
- partial evidence의 조기 skip
- pair-scoped Smart pipeline 중심 사고
- unresolved를 service fallback candidate 안에 묻는 구조
- route-family seed를 service-level candidate로 닫는 구조
- candidate 생성 뒤 confidence만 조정하는 late validation 중심 모델

---

## 6. 상위 아키텍처

```text
Source Scan
  ↓
Typed Extraction
  - endpoint index
  - function summaries
  - alias/config bindings
  - route transforms
  - schema/topic index
  ↓
Intent Extraction
  - http_call
  - http_gateway_route
  - db_access
  - message_publish
  - message_consume
  ↓
Proof State Creation
  - root proof per intent
  ↓
Fixed Resolution Pipeline
  1. anchor consumer / route seed
  2. hydrate summary slots
  3. resolve alias / provider
  4. normalize method/path or route pattern
  5. apply route transforms
  6. derive route-family endpoint set
  7. spawn endpoint-scoped child proofs
  8. match atomic target
  9. validate contradiction / ambiguity
  ↓
Result
  - CLOSED_ATOMIC (child proof only)
  - FRONTIER
  - REJECTED
  ↓
Projection
  - CLOSED_ATOMIC -> relation_candidates
  - FRONTIER -> proof_frontiers
  ↓
Approval
  ↓
object_relations / rollups / query / chat
```

핵심 규칙:

> proof가 닫히기 전에는 relation candidate가 생성되지 않는다.
>
> route-family seed는 child proof를 낳을 수 있지만, 직접 relation candidate로 projection되지 않는다.

---

## 7. 문서별 역할

| 문서 | 역할 |
|------|------|
| [10-intent-centric-proof-engine-state-model.md](./10-intent-centric-proof-engine-state-model.md) | 추출 레이어, core state, 테이블, schema, IR |
| [11-intent-centric-proof-engine-resolution-pipeline.md](./11-intent-centric-proof-engine-resolution-pipeline.md) | fixed pipeline, frontier, agent, confidence, projection, invalidation |
| [12-intent-centric-proof-engine-adoption-plan.md](./12-intent-centric-proof-engine-adoption-plan.md) | 대체 매핑, 패키지 구조, UI, 성능, cutover 기준, 리스크 |

---

## 8. 최종 결정 요약

이 재설계의 본질은 아래 다섯 줄이다.

1. service pair를 seed로 삼지 않는다.
2. candidate보다 proof 상태를 먼저 다룬다.
3. 닫힌 atomic proof만 candidate로 투영한다.
4. route-family seed는 child proof 생성의 상위 상태로만 다룬다.
5. frontier와 patch를 엔진의 주 실행 상태로 다룬다.

결과적으로 추론 엔진은 다음으로 전환된다.

- 이전: `candidate-first + pair-first + fallback-heavy`
- 이후: `intent-first + proof-first + route-family-aware + frontier-driven`
