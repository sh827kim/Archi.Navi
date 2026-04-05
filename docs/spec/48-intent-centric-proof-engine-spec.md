# 48. Intent-Centric Proof Engine Overview (SPEC)

상태: Proposed
우선순위: P0
적용 방식: Full Replacement
작성일: 2026-03-31
최종 정리: 2026-04-03
관련 디자인 문서:
- [09-intent-centric-proof-engine-overview.md](../design/09-intent-centric-proof-engine-overview.md)
- [10-intent-centric-proof-engine-state-model.md](../design/10-intent-centric-proof-engine-state-model.md)
- [11-intent-centric-proof-engine-resolution-pipeline.md](../design/11-intent-centric-proof-engine-resolution-pipeline.md)
- [12-intent-centric-proof-engine-adoption-plan.md](../design/12-intent-centric-proof-engine-adoption-plan.md)

---

## 1. 목적

이 문서는 Archi.Navi의 기존 relation inference 경로를 **Intent-Centric Proof Engine**으로 전면 교체하기 위한 상위 SPEC 개요다.

핵심 목표는 하나다.

> **Service ↔ Service 수준에서 멈추는 추론을 없애고, interaction intent를 atomic target까지 proof로 닫은 뒤에만 candidate를 생성한다.**

세부 구현 계약은 분할 문서에서 다룬다.

- [49-intent-centric-proof-engine-state-model-spec.md](./49-intent-centric-proof-engine-state-model-spec.md): 추출 레이어, 상태/데이터 모델, schema
- [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md): fixed resolution pipeline, frontier, agent, projection, invalidation
- [51-intent-centric-proof-engine-adoption-plan-spec.md](./51-intent-centric-proof-engine-adoption-plan-spec.md): 구현 교체, 패키지 구조, UI/운영, 성능, cutover 기준

Smart / LLM escalation 자체의 제품 계약은 이 문서가 아니라
[53-smart-proof-engine-escalation-spec.md](./53-smart-proof-engine-escalation-spec.md)를 따른다.

---

## 2. 문제 정의

기존 추론 구조의 핵심 한계는 아래 다섯 가지다.

1. `service pair`를 먼저 만든 뒤 atomic target을 찾는다.
2. `candidate`를 먼저 만들고 supporting evidence와 validation을 뒤에 붙인다.
3. path-only, alias-only, wrapper-only 같은 partial evidence가 중간에 손실된다.
4. provider service가 보이면 candidate fan-out 또는 service fallback으로 precision이 깨진다.
5. LLM/Agent가 판정기처럼 동작해 해석 결과가 재사용 가능한 실행 상태로 남지 않는다.

추가로 config-only gateway route는 단일 endpoint가 아니라 endpoint family를 가리키는 경우가 많다.
이 family를 1급 모델로 두지 않으면 구현은 service fallback으로 미끄러지거나 legacy fan-out에 의존하게 된다.

---

## 3. 설계 목표

### 3.1 핵심 목표

1. 추론 seed를 `service pair`에서 `interaction intent`로 교체한다.
2. candidate보다 proof 상태를 먼저 다룬다.
3. partial evidence를 영구 손실 없이 보존한다.
4. candidate fan-out 기반 endpoint 후보 생성을 금지하고, bounded child proof derivation만 허용한다.
5. frontier를 실패 로그가 아니라 엔진의 주 실행 상태로 승격한다.
6. LLM/Agent를 pair 판정기가 아니라 frontier-local proof patcher로 제한한다.
7. atomic-first promotion, approval gate, rollup 철학은 유지한다.

### 3.2 비목표

- runtime tracing 기반 자동 확정
- 승인 없는 자동 promotion
- open-world global solver
- 기존 pair-first 경로와의 장기 병행 운영
- unresolved를 service fallback candidate로 남기는 절충안

---

## 4. 핵심 결정

### 4.1 Seed = `InteractionIntent`

추론의 출발점은 서비스 쌍이 아니라 caller가 실제로 시도한 상호작용 의도다.

HTTP 계열 seed는 아래 두 family를 가진다.

- `HTTP_CALL_INTENT`
- `HTTP_GATEWAY_ROUTE_INTENT`

### 4.2 Candidate = `Closed Proof`의 projection

`relation_candidates`는 추론의 작업 공간이 아니다.
오직 atomic target까지 닫힌 proof만 candidate로 투영된다.

`HTTP_GATEWAY_ROUTE_INTENT`는 route-family seed이며,
직접 candidate가 아니라 endpoint-scoped child proof 생성의 상위 입력 상태다.

### 4.3 Service ↔ Service는 rollup 결과다

service-level 관계는 추론의 seed나 fallback이 아니라, approved atomic relation에서 파생되는 요약 결과다.
service-level proof closure와 service-level candidate projection은 금지한다.

### 4.4 Proof와 Frontier는 실행 상태다

proof/trace는 설명용 부가 정보가 아니다.
엔진이 실제로 읽고 쓰는 1급 실행 상태다.

### 4.5 실행은 `Fixed Resolution Pipeline`으로 제한한다

proof 상태를 저장하되, 해석은 타입별 고정 단계 파이프라인으로 제한한다.

route-family seed는 아래 단계를 추가로 가진다.

- route-family endpoint set derivation
- endpoint-scoped child proof spawn

### 4.6 Agent는 frontier-local patcher다

LLM/Agent는 relation truth를 선언하지 않는다.
대신 frontier 해소에 필요한 구조화 patch만 제안한다.

Smart 모드의 실행 계약, 예산, category 정의는 `53`에서 별도로 다룬다.

---

## 5. 교체 범위

### 5.1 유지하는 것

- workspace 중심 격리
- approval gate
- approved relation만 `object_relations`에 반영
- atomic-first promotion
- compound/service view는 rollup과 projection으로 제공
- deterministic-first, AI-assisted 원칙

### 5.2 제거하는 것

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

> **proof가 닫히기 전에는 relation candidate가 생성되지 않는다.**
>
> **route-family seed는 child proof를 낳을 수 있지만, 직접 relation candidate로 projection되지 않는다.**

---

## 7. 분할 문서 역할

| 문서 | 역할 |
|------|------|
| [49-intent-centric-proof-engine-state-model-spec.md](./49-intent-centric-proof-engine-state-model-spec.md) | 추출 레이어, core state, 테이블, schema, hash 규칙 |
| [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md) | fixed pipeline, frontier, agent, confidence, projection, invalidation |
| [51-intent-centric-proof-engine-adoption-plan-spec.md](./51-intent-centric-proof-engine-adoption-plan-spec.md) | 대체 매핑, 패키지 구조, API/운영, UI, 성능, cutover 기준, 리스크 |

---

## 8. 최종 결정 요약

이 재설계의 본질은 아래 다섯 줄이다.

1. service pair를 seed로 삼지 않는다.
2. candidate보다 proof 상태를 먼저 다룬다.
3. 닫힌 atomic proof만 candidate로 투영한다.
4. route-family seed는 child proof 생성의 상위 상태로만 다룬다.
5. frontier와 patch를 엔진의 주 실행 상태로 다룬다.
