# 50. Intent-Centric Proof Engine Resolution Pipeline (SPEC)

상태: Current
우선순위: P0
상위 문서: [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
관련 디자인 문서: [11-intent-centric-proof-engine-resolution-pipeline.md](../design/11-intent-centric-proof-engine-resolution-pipeline.md)
작성일: 2026-03-31
최종 정리: 2026-04-04
구현 메모: `intentProofEngine.ts`와 run orchestration이 따라야 하는 현재 proof closure 계약이다.

---

## 1. 범위

이 문서는 proof 상태를 atomic target까지 닫기 위한 실행 파이프라인을 정의한다.

포함 범위:

- fixed resolution pipeline
- proof 상태 전이
- frontier taxonomy와 retry strategy
- agent 역할과 patch 계약
- confidence / projection 규칙
- 증분 재계산과 invalidation

---

## 2. 기본 원칙

- 범용 solver는 채택하지 않는다.
- intent type별 고정 단계 파이프라인을 사용한다.
- proof를 닫기 전에는 candidate를 만들지 않는다.
- ambiguous 또는 unresolved 상태를 service fallback candidate로 강등하지 않는다.
- open-world graph 전체 탐색은 금지한다.
- 모든 join은 type-safe constrained join이어야 한다.
- route-family seed는 직접 candidate를 projection하지 않는다.
- child proof만 atomic target으로 닫혀 projection될 수 있다.

---

## 3. Fixed Resolution Pipeline

```text
HTTP_CALL_INTENT
1. anchorIntent
2. hydrateFromFunctionSummary
3. resolveHostAlias
4. normalizeMethodAndPath
5. applyRouteTransforms
6. matchAtomicTarget
7. validateContradictionsAndAmbiguity
8. projectCandidate

HTTP_GATEWAY_ROUTE_INTENT
1. anchorGatewayRouteSeed
2. resolveProviderAndRouteChain
3. normalizeExternalRoutePattern
4. deriveReachableEndpointSet
5. spawnEndpointScopedChildProofs
6. validateChildProofCompleteness
7. projectClosedAtomicChildren
```

공통 규칙:

- root proof는 intent 하나당 하나 생성한다.
- child proof는 route-family root proof에서만 파생된다.
- step 순서는 고정이다.
- 이전 step의 출력 슬롯만 다음 step 입력으로 사용한다.

---

## 4. HTTP Proof Family

### 4.1 `HTTP_CALL_INTENT`

#### Stage 0. `anchorIntent`

필수:

- `workspace_id`
- `intent_type=http_call`
- `source_service_id`

불만족 시 `REJECTED`.

#### Stage 1. `hydrateFromFunctionSummary`

입력:

- function summary
- raw callsite fact
- direct literal hints

보강 슬롯:

- `method`
- `externalPath`
- `hostAlias`
- `configKeys`
- `extractionStrategy`
- `summaryCompleteness`
- `signalSources`

기록:

- `truncated`
- `unsupportedPattern`

규칙:

- confidence는 active proof confidence profile에서 계산한다.
- `hydrateFromFunctionSummary` 단계는 summary payload뿐 아니라 `extractionStrategy`, `summaryCompleteness`, `signalSources`를 후속 step 입력으로 남겨야 한다.

#### Stage 2. `resolveHostAlias`

입력:

- `host_hint`
- `config_keys`
- `alias_hints`
- `alias_bindings`

출력:

- `provider_service_id?`
- `resolved_host?`

실패 시 frontier:

- `HOST_ALIAS_UNRESOLVED`
- `CONFIG_BINDING_MISSING`
- `PROVIDER_SERVICE_AMBIGUOUS`

#### Stage 3. `normalizeMethodAndPath`

입력:

- `method_hint`
- `external_path_hint`
- summary outbound HTTP

출력:

- `method_resolved`
- `external_path_resolved`

실패 시 frontier:

- `METHOD_UNKNOWN`
- `PATH_TEMPLATE_UNKNOWN`
- `PATH_PARAM_NORMALIZATION_FAILED`

#### Stage 4. `applyRouteTransforms`

입력:

- provider service 또는 alias 기반 service 후보
- `external_path_resolved`
- `route_transforms`

출력:

- `internal_path_resolved`
- `route_chain`

실패 시 frontier:

- `ROUTE_TRANSFORM_UNRESOLVED`
- `ROUTE_TARGET_SERVICE_UNKNOWN`
- `PATH_REWRITE_CONFLICT`

#### Stage 5. `matchAtomicTarget`

입력:

- `provider_service_id`
- `method_resolved`
- `internal_path_resolved`

출력:

- `target_object_id` (`api_endpoint`)

규칙:

- endpoint 전체 fan-out 금지
- method/path가 닫히지 않았으면 매칭 시도 금지
- exact > normalized > token-compatible 순으로 좁힌다

실패 시 frontier:

- `PROVIDER_ENDPOINT_NOT_FOUND`
- `ENDPOINT_MATCH_AMBIGUOUS`
- `PROVIDER_ENDPOINT_INDEX_EMPTY`

#### Stage 6. `validateContradictionsAndAmbiguity`

검증:

- method contradiction
- path contradiction
- provider contradiction
- route conflict
- unsupported summary conflict

결과:

- 치명적 contradiction이면 `REJECTED`
- ambiguity가 남으면 `FRONTIER`
- 단일 후보면 `CLOSED_ATOMIC`

#### Stage 7. `projectCandidate`

`CLOSED_ATOMIC` 상태만 `relation_candidates`에 projection한다.

생성 규칙:

- relation type: `CALL`
- subject: consumer service object
- object: provider endpoint object
- metadata에 `proof_state_id` 포함

추가 규칙:

- method/path가 닫히지 않았으면 `FRONTIER`를 유지한다.
- path-only unique match는 이 파이프라인의 예외가 아니라 `HTTP_GATEWAY_ROUTE_INTENT` child proof derivation 규칙이다.

### 4.2 `HTTP_GATEWAY_ROUTE_INTENT`

config-only gateway route family proof를 담당한다.

#### Stage 0. `anchorGatewayRouteSeed`

필수:

- `workspace_id`
- `intent_type=http_gateway_route`
- `source_service_id`
- `external_route_pattern`
- `route_scope_kind`

불만족 시 `REJECTED`.

#### Stage 1. `resolveProviderAndRouteChain`

입력:

- `provider_hint`
- `target_service_hint`
- `route_transform_refs`
- `route_transforms`
- `alias_bindings`

출력:

- `provider_service_id?`
- `route_chain`
- `routeFamilyState=seed_only`

실패 시 frontier:

- `HOST_ALIAS_UNRESOLVED`
- `ROUTE_TARGET_SERVICE_UNKNOWN`
- `ROUTE_TRANSFORM_UNRESOLVED`

#### Stage 2. `normalizeExternalRoutePattern`

입력:

- `external_route_pattern`
- `route_scope_kind`
- `method_constraint`

출력:

- `external_path_resolved`
- `internal_path_resolved?`
- `method_constraint_resolved`

실패 시 frontier:

- `PATH_TEMPLATE_UNKNOWN`
- `METHOD_CONSTRAINT_MISSING`
- `ROUTE_TO_ENDPOINT_COMPOSITION_FAILED`

#### Stage 3. `deriveReachableEndpointSet`

입력:

- `provider_service_id`
- `route_scope_kind`
- `internal_path_resolved`
- `route_chain`
- endpoint index

출력:

- `endpointCandidateSet.objectIds[]`
- `endpointCandidateSet.count`
- `endpointCandidateSet.matchBasis`
- `routeFamilyState=derived_children | frontier`

규칙:

- route scope + transform composition으로 좁혀진 endpoint만 허용한다.
- provider service 전체를 candidate로 projection하지 않는다.
- unbounded endpoint 전체 fan-out을 허용하지 않는다.
- path-only unique match는 여기서 child proof derivation으로 승격된다.

실패 시 frontier:

- `PROVIDER_ENDPOINT_INDEX_EMPTY`
- `ROUTE_FAMILY_DERIVATION_EMPTY`
- `ENDPOINT_SET_OPEN`
- `ROUTE_FAMILY_TOO_BROAD`

#### Stage 4. `spawnEndpointScopedChildProofs`

입력:

- `endpointCandidateSet`
- `method_constraint_resolved`
- route family lineage

출력:

- endpoint-scoped child proof 목록

규칙:

- child proof는 endpoint 단위로 생성한다.
- root seed 자체는 candidate를 만들지 않는다.
- child proof는 `origin_intent_id`를 공유하고 `parent_proof_state_id`를 가져야 한다.

#### Stage 5. `validateChildProofCompleteness`

결과:

- 단일 child proof가 atomic으로 닫히면 `CLOSED_ATOMIC`
- 다수 child proof가 frontier면 root proof도 `FRONTIER`
- service target으로 proof를 닫는 것은 금지한다

#### Stage 6. `projectClosedAtomicChildren`

규칙:

- child proof 중 `CLOSED_ATOMIC`만 `relation_candidates`에 projection한다.
- route-family root는 직접 projection하지 않는다.

---

## 5. DB / Message 파이프라인

HTTP proof와 동일하게 단계별 step logging, contradiction 검증, atomic-only projection을 유지해야 한다.
DB/message proof도 HTTP와 동일한 active confidence profile을 사용한다.

### 5.1 DB_ACCESS_INTENT

```text
1. anchorDbIntent
2. hydrateFromFunctionSummary
3. resolveDatasourceBinding
4. normalizeTableHint
5. matchAtomicTarget
6. validateContradictionsAndAmbiguity
7. projectCandidate
```

규칙:

- `SELECT`는 `READ(service -> db_table)`
- `INSERT`, `UPDATE`, `DELETE`, `UPSERT`는 `WRITE(service -> db_table)`
- datasource alias가 닫히지 않으면 `FRONTIER(DATASOURCE_ALIAS_UNRESOLVED)`다.
- schema가 없으면 기본 schema 룰을 적용하되, 다수 DB가 있으면 `FRONTIER(DB_SCHEMA_AMBIGUOUS)`다.
- table이 결정되지 않으면 `FRONTIER(DB_TABLE_UNRESOLVED)`다.
- 복수 table이 동일 점수면 `FRONTIER(TABLE_MATCH_AMBIGUOUS)`다.
- DB pipeline도 HTTP와 동일한 granularity로 step 로그를 남겨야 한다.

### 5.2 MESSAGE_PUBLISH / MESSAGE_CONSUME

```text
1. anchorMessageIntent
2. hydrateFromFunctionSummary
3. resolveBrokerBinding
4. normalizeTopicOrQueue
5. matchAtomicTarget
6. validateContradictionsAndAmbiguity
7. projectCandidate
```

relation mapping:

- `message_publish` → `PUBLISH(service -> topic|queue)`
- `message_consume` → `SUBSCRIBE(service -> topic|queue)`
- broker binding이 닫히지 않으면 `FRONTIER(BROKER_BINDING_UNRESOLVED)`다.
- topic/queue object가 결정되지 않으면 `FRONTIER(MESSAGE_TARGET_UNRESOLVED)`다.
- 복수 target이 동일 점수면 `FRONTIER(TOPIC_MATCH_AMBIGUOUS)`다.
- broker binding, topic/queue normalization, contradiction step을 별도 proof step으로 남겨야 한다.

---

## 6. Proof 상태 전이

```text
NEW
  → RESOLVING
    → CLOSED_ATOMIC
    → FRONTIER
    → REJECTED
```

### 6.1 `CLOSED_ATOMIC`

조건:

- provider/target type이 명확
- atomic target이 단일 object로 매칭됨
- 치명적 contradiction 없음

### 6.2 `FRONTIER`

조건:

- 닫히지 않았지만 의미 있는 partial state가 남아 있음
- deterministic resolver 또는 agent가 추가 patch로 해소 가능함

### 6.3 `REJECTED`

조건:

- anchor 불충분
- contradiction 치명적
- unsupported pattern + recoverability 없음
- 매칭 대상 타입 자체가 잘못됨

---

## 7. Frontier taxonomy

frontier는 충분히 세분화되어야 한다.
`INSUFFICIENT_CONTEXT` 같은 뭉뚱그린 사유는 금지한다.

### 7.1 ALIAS 계열

- `HOST_ALIAS_UNRESOLVED`
- `CONFIG_BINDING_MISSING`
- `SERVICE_DISCOVERY_ALIAS_UNRESOLVED`
- `PROVIDER_SERVICE_AMBIGUOUS`

### 7.2 SUMMARY 계열

- `FUNCTION_SUMMARY_MISSING`
- `CALL_CHAIN_TRUNCATED`
- `WRAPPER_SUMMARY_MISSING`
- `UNSUPPORTED_DYNAMIC_HOST`
- `UNSUPPORTED_DYNAMIC_PATH`

### 7.3 ROUTE 계열

- `ROUTE_TRANSFORM_UNRESOLVED`
- `ROUTE_TARGET_SERVICE_UNKNOWN`
- `PATH_REWRITE_CONFLICT`
- `GATEWAY_PLUGIN_UNAVAILABLE`
- `ROUTE_FAMILY_TOO_BROAD`
- `ROUTE_TO_ENDPOINT_COMPOSITION_FAILED`

### 7.4 PATH / METHOD / ACTION 계열

- `METHOD_UNKNOWN`
- `METHOD_CONSTRAINT_MISSING`
- `PATH_TEMPLATE_UNKNOWN`
- `PATH_PARAM_NORMALIZATION_FAILED`
- `METHOD_PATH_CONFLICT`
- `DB_ACTION_UNKNOWN`

### 7.5 TARGET 계열

- `PROVIDER_ENDPOINT_INDEX_EMPTY`
- `PROVIDER_ENDPOINT_NOT_FOUND`
- `ENDPOINT_MATCH_AMBIGUOUS`
- `ROUTE_FAMILY_DERIVATION_EMPTY`
- `ENDPOINT_SET_OPEN`
- `DB_SCHEMA_AMBIGUOUS`
- `DB_TABLE_UNRESOLVED`
- `TABLE_MATCH_AMBIGUOUS`
- `MESSAGE_TARGET_UNRESOLVED`
- `TOPIC_MATCH_AMBIGUOUS`

### 7.6 CONTRADICTION / UNSUPPORTED 계열

- `CONFLICTING_EVIDENCE`
- `UNSUPPORTED_FRAMEWORK_PATTERN`
- `UNSUPPORTED_GENERATED_CLIENT_PATTERN`

---

## 8. Retry 전략

frontier는 실패 로그가 아니라 다음 액션을 위한 입력이다.

지원 전략:

- `deterministic`: extractor/plugin/index 갱신 후 재해석
- `agent_patch`: frontier-local agent 호출
- `manual_review`: 사람 승인/수정 필요

규칙:

- 모든 frontier를 agent에 보내지 않는다.
- frontier reason이 구체적이어야 retry 가능하다.
- unresolved를 low confidence candidate로 우회 저장하지 않는다.

---

## 9. Agent / LLM 설계

### 9.1 역할

agent는 relation 생성기가 아니다.
frontier를 해소하기 위한 **proof patch 생성기**다.

### 9.2 입력

- `frontier_reason`
- `source_service`
- `source_function`
- 관련 function summary
- 관련 config snippet
- 관련 route transform 후보
- 관련 endpoint index 후보
- 최근 proof steps
- 필요한 최소 파일 subset

### 9.3 출력

agent는 아래 patch 타입만 생성할 수 있다.

#### 2026-04-04 MVP 범위

- 1차 main path에는 `alias_binding`, `route_transform_patch`, `endpoint_disambiguation`만 연결한다.
- `function_summary_patch`는 summary v2가 닫힌 뒤 2차 범위로 연기한다.
- agent 미연결 상태는 `NOT_SUPPORTED_IN_INTENT_PROOF` 같은 임시 성공값이 아니라 명시적 disabled reason으로만 노출해야 한다.

#### `alias_binding`

```json
{
  "patchType": "alias_binding",
  "aliasKey": "orders.base-url",
  "resolvedService": "svc:order-service",
  "resolvedHost": "lb://order-service",
  "confidence": 0.82
}
```

#### `function_summary_patch`

```json
{
  "patchType": "function_summary_patch",
  "functionId": "fn:OrderApiClient#getOrder",
  "outboundHttp": {
    "method": "GET",
    "path": "/orders/{id}"
  }
}
```

#### `route_transform_patch`

```json
{
  "patchType": "route_transform_patch",
  "gatewayKind": "custom",
  "matchPath": "/api/orders/**",
  "stripPrefixCount": 1,
  "targetServiceHint": "order-service"
}
```

#### `endpoint_disambiguation`

```json
{
  "patchType": "endpoint_disambiguation",
  "providerServiceId": "svc:order-service",
  "method": "GET",
  "path": "/orders/{id}",
  "endpointId": "obj:endpoint:123"
}
```

### 9.4 금지 사항

agent는 아래를 직접 반환하면 안 된다.

- 최종 relation candidate
- approval 결과
- service-level rollup relation
- 복수 endpoint fan-out

### 9.5 patch 검증

모든 patch는 deterministic validator를 통과해야 한다.

- schema validation
- object existence validation
- conflicting patch detection
- evidence/provenance validation
- proof applicability check

검증 실패 patch는 `REJECTED`로 기록되고 proof state는 frontier를 유지한다.

---

## 10. Confidence와 projection

### 10.1 원칙

confidence는 candidate를 만들기 위한 값이 아니라, proof 상태가 닫혔을 때 그 닫힘의 신뢰도를 표현한다.

### 10.2 구성 요소

- slot completeness
- source corroboration count
- contradiction penalty
- summary confidence
- alias binding confidence
- route transform confidence
- endpoint match specificity

### 10.3 계산 원칙

- unresolved frontier는 high confidence가 될 수 없다.
- ambiguity가 남은 상태는 `CLOSED_ATOMIC`가 될 수 없다.
- confidence가 높아도 contradiction가 치명적이면 `REJECTED`다.
- 최종 confidence는 `summary quality + slot completeness + corroboration + match specificity - contradiction penalty` 구조여야 한다.
- `confidence_breakdown`은 proof step output과 closed proof metadata에 함께 남아야 한다.

### 10.4 feedback 보정

v1에서는 ML ranker를 도입하지 않는다.
대신 approval/reject 이력은 hierarchical calibration으로 제한해 사용한다.

우선순위:

1. relation type
2. relation type + source family
3. relation type + source family + signal kind
4. relation type + source family + signal kind + target object type
5. relation type + source family + signal kind + framework + language

### 10.5 projection 규칙

`relation_candidates` 생성 조건:

- 오직 `CLOSED_ATOMIC` proof만 projection 가능

금지 규칙:

- provider service만 알았다고 service fallback candidate 생성
- endpoint 전체 fan-out 후보 생성
- route-family seed를 직접 relation candidate로 projection
- unresolved frontier를 low confidence candidate로 저장

rollup 규칙:

- service ↔ service 관계는 approved atomic relation에서만 파생

### 10.6 Projection metadata

metadata에는 최소 아래를 포함한다.

- `source = PROOF_ENGINE`
- `signalKind = closed_atomic_proof`
- `proofStateId`
- `intentId`
- `originIntentId`
- `parentProofStateId?`
- `analysisMode = deterministic | agent_patched`
- `patchIds[]`
- `routeTransformIds[]`
- `resolutionTraceDigest`
- `confidenceBreakdown`

---

## 11. 증분 재계산과 invalidation

단계적 마이그레이션은 하지 않지만, 엔진은 증분 재계산을 지원해야 한다.

### 11.1 invalidation 단위

- function source hash 변경 → 해당 function summary 무효화
- config file hash 변경 → 관련 alias binding 무효화
- gateway config hash 변경 → 관련 route transforms 무효화
- endpoint inventory hash 변경 → 관련 proof states 재평가
- patch 승인/거절 → 관련 proof states 재평가

### 11.2 재계산 범위

- 변경된 summary를 참조하는 intents 재해석
- 변경된 alias binding에 의존하는 frontier 재해석
- 변경된 route transform chain에 의존하는 frontier 재해석
- 이미 닫힌 proof도 dependency hash mismatch 시 재검증

### 11.3 full rescan

허용되지만 기본 동작은 아니다.
기본은 dependency-aware 증분 재계산이다.

---

## 12. 금지 사항

아래는 구현 금지다.

1. proof가 닫히기 전에 candidate를 먼저 만드는 것
2. `targetType = service` relation candidate 생성
3. unresolved를 service fallback candidate로 저장하는 것
4. provider service 발견 후 endpoint 전체 fan-out 생성
5. route-family seed를 직접 candidate로 projection하는 것
6. agent가 relation을 직접 저장하는 것
7. proof state를 candidate metadata 부속물로만 취급하는 것
8. 기존 pair-first 엔진을 fallback path로 유지하는 것
