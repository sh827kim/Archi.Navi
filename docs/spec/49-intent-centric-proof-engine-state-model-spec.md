# 49. Intent-Centric Proof Engine State Model (SPEC)

상태: Current
우선순위: P0
상위 문서: [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
관련 디자인 문서: [10-intent-centric-proof-engine-state-model.md](../design/10-intent-centric-proof-engine-state-model.md)
작성일: 2026-03-31
최종 정리: 2026-04-04
구현 메모: proof 실행 상태와 frontier/patch 저장 모델의 현재 기준 문서다.

---

## 1. 범위

이 문서는 Intent-Centric Proof Engine의 정적/반정적 실행 상태를 정의한다.

포함 범위:

- typed extraction 레이어
- 핵심 개념
- 새 1급 테이블
- 기존 테이블과의 관계
- canonical hash와 dedupe 규칙

---

## 2. 추출 레이어

proof 엔진은 pair-local 즉석 해석보다 재사용 가능한 추출 결과를 먼저 쌓아야 한다.

### 2.1 Endpoint Indexer

목적:

- provider service의 endpoint를 searchable index로 정규화한다.

최소 출력:

- `service_id`
- `endpoint_object_id`
- `http_method`
- `normalized_path`
- `path_tokens`
- `normalized_path_signature`
- `segment_count`
- `path_token_kinds`
- `source_rank`
- `source` (`openapi`, `code_expose`, `manual`)

실행 계약:

- endpoint index는 전용 테이블 또는 run-scoped materialized cache로 구현할 수 있다.
- resolver hot path는 raw `objects` 전체 탐색 대신 preload/batch lookup 계약만 사용해야 한다.
- 각 index row는 `evidenceIds[]` 또는 동등한 provenance digest를 보존해야 한다.

### 2.2 Function Summary Extractor

목적:

- wrapper/facade/shared client를 pair 단위로 즉석 추적하지 않고, 재사용 가능한 outbound summary로 저장한다.

반드시 수집할 항목:

- `httpMethod?`
- `pathTemplate?`
- `hostHint?`
- `configKeys[]`
- `downstreamFunctionRefs[]`
- `aliasHints[]`
- `dbTableHints[]`
- `topicHints[]`
- `signalSources[]`
- `extractionStrategy`
- `provenanceEvidenceIds[]`
- `unresolvedReasons[]`
- `summaryCompleteness`

규칙:

- stable summary여야 한다.
- `ast` 또는 `hybrid` 기반 function-owned signal이 하나라도 있으면 그것을 primary source로 사용해야 한다.
- `codeCallEdges`는 AST/HYBRID primary가 있을 때 corroboration source로만 사용하고 primary payload를 덮어쓰면 안 된다.
- AST/native signal provenance가 주 입력이어야 하며, AST/HYBRID signal이 없을 때만 `legacy_edges_fallback`으로 `codeCallEdges` 기반 summary를 허용한다.
- extractor는 `ast_primary | mixed_signals | legacy_edges_fallback` 전략을 반드시 기록해야 한다.
- source hash 기반 재생성이 가능해야 한다.
- wrapper가 wrapper를 호출해도 합성 가능해야 한다.

### 2.3 Alias / Config Binding Extractor

목적:

- `payment.url`, `lb://payment`, `http://payment:8080` 같은 간접 식별자를 정규화한다.

최소 출력:

- `config key -> value`
- `value -> service hint`
- `host alias -> service`
- `property override precedence`

### 2.4 Gateway Plugin + RouteTransform IR

목적:

- vendor별 gateway 설정을 공통 IR로 정규화한다.
- route family를 endpoint-scoped child proof까지 안전하게 좁힐 수 있는 정보를 남긴다.

플러그인 계약:

```ts
interface GatewayPlugin {
  kind: string;
  pluginVersion: string;
  matchPriority: number;
  detect(files: SourceFile[]): boolean;
  extractRouteTransforms(files: SourceFile[]): RouteTransform[];
}
```

규칙:

- 플러그인은 vendor raw 설정을 읽을 수 있지만, 저장소와 resolver에는 vendor-neutral IR만 남겨야 한다.
- 지원 플러그인이 없으면 `GATEWAY_PLUGIN_UNAVAILABLE` frontier로 표면화해야 한다.

---

## 3. 핵심 개념

### 3.1 InteractionIntent

caller 관점에서 추출된 상호작용 의도다.
불완전할 수 있지만 anchor와 최소 힌트가 있으면 버리지 않는다.

HTTP 계열은 아래 두 family를 가진다.

- `http_call`
- `http_gateway_route`

### 3.2 FunctionSummary

함수 단위 재사용 가능한 outbound summary다.

### 3.3 RouteTransform

gateway/proxy/service discovery에 의해 발생하는 path/host 변환의 정규 표현이다.

### 3.4 ProofState

intent를 atomic target으로 닫아 가는 주 실행 상태다.
route-family root proof와 child proof lineage를 포함한다.

상태:

- `NEW`
- `RESOLVING`
- `CLOSED_ATOMIC`
- `FRONTIER`
- `REJECTED`

### 3.5 Frontier

proof를 닫지 못했지만 의미 있는 partial state가 남아 있는 상태다.
실패 로그가 아니라 다음 액션의 입력이다.

### 3.6 ProofPatch

deterministic extractor 또는 agent가 frontier 해소를 위해 제안하는 구조화 patch다.
relation이 아니라 slot을 채우는 단위다.

---

## 4. 데이터 모델

새 엔진은 기존 `objects`, `object_relations`, `relation_candidates`, `evidences`를 유지하되, 실행 상태를 위한 1급 테이블을 추가한다.

### 4.1 `interaction_intents`

추론의 seed다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `workspace_id` | text | N | workspace |
| `created_run_id` | text | N | 최초 생성 run |
| `updated_run_id` | text | N | 마지막 갱신 run |
| `intent_type` | text | N | `http_call`, `http_gateway_route`, `db_access`, `message_publish`, `message_consume` |
| `source_service_id` | text | N | consumer service object id |
| `source_function_id` | text | Y | caller function object id |
| `source_file_path` | text | Y | 주 근거 파일 |
| `method_hint` | text | Y | `GET`, `POST`, DB action 등 |
| `external_path_hint` | text | Y | direct call의 외부 path template |
| `gateway_kind` | text | Y | `zuul`, `spring_cloud_gateway` 등 |
| `route_scope_kind` | text | Y | `exact`, `prefix`, `regex` |
| `external_route_pattern` | text | Y | gateway 외부 route pattern |
| `provider_hint` | text | Y | gateway/provider host/service 단서 |
| `target_service_hint` | text | Y | route가 가리키는 target service 힌트 |
| `route_transform_refs` | json | N | 관련 route transform id 목록 |
| `method_constraint` | text | Y | `unknown`, `any`, `exact` |
| `host_hint` | text | Y | host/base-url/alias |
| `resource_hint` | text | Y | table/topic/queue 등 |
| `config_keys` | json | N | 관련 config key 목록 |
| `summary_refs` | json | N | 관련 function summary id 목록 |
| `evidence_ids` | json | N | provenance |
| `status` | text | N | `NEW`, `RESOLVING`, `CLOSED_ATOMIC`, `FRONTIER`, `REJECTED` |
| `intent_hash` | text | N | dedupe / invalidation key |
| `anchor_hash` | text | N | anchor hash |
| `created_at` | timestamp | N | 생성 시각 |
| `updated_at` | timestamp | N | 수정 시각 |

제약:

- PK: `id`
- UNIQUE: `(workspace_id, intent_hash)`
- CHECK: `status IN ('NEW', 'RESOLVING', 'CLOSED_ATOMIC', 'FRONTIER', 'REJECTED')`
- CHECK: `route_scope_kind IS NULL OR route_scope_kind IN ('exact', 'prefix', 'regex')`
- CHECK: `method_constraint IS NULL OR method_constraint IN ('unknown', 'any', 'exact')`

인덱스:

- `idx_interaction_intents_ws_status (workspace_id, status)`
- `idx_interaction_intents_ws_source (workspace_id, source_service_id, intent_type)`
- `idx_interaction_intents_ws_function (workspace_id, source_function_id)`

규칙:

- anchor는 반드시 `workspace_id`, `intent_type`, `source_service_id`를 가진다.
- `config_keys`, `summary_refs`, `evidence_ids`, `route_transform_refs`는 중복 제거 후 정렬된 배열이어야 한다.
- `source_service_id`가 없으면 intent를 저장해서는 안 된다.
- 최소 1개 이상의 downstream slot 힌트가 있어야 한다.
- `intent_type=http_gateway_route`이면 `gateway_kind`, `route_scope_kind`, `external_route_pattern`이 필수다.
- `http_gateway_route`는 projection 대상 candidate가 아니라 route-family seed다.

### 4.2 `function_summaries`

정적 분석 결과의 핵심 재사용 캐시다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `workspace_id` | text | N | workspace |
| `created_run_id` | text | N | 생성 run |
| `updated_run_id` | text | N | 갱신 run |
| `function_id` | text | N | function object id |
| `service_id` | text | N | owner service object id |
| `summary_version` | integer | N | schema version |
| `summary_kind` | text | N | `http`, `db`, `message`, `mixed` |
| `outbound_http` | json | Y | method/path/host/configKeys |
| `outbound_db` | json | Y | action/schema/table |
| `outbound_message` | json | Y | topic/queue/action |
| `call_chain_hints` | json | N | downstream wrappers / targets |
| `alias_hints` | json | N | alias 후보 |
| `signal_sources` | json | N | AST/config/code evidence source 목록 |
| `extraction_strategy` | text | N | `ast_primary`, `mixed_signals`, `legacy_edges_fallback` |
| `summary_completeness` | real | N | slot completeness 점수 |
| `unresolved_reasons` | json | N | 아직 닫히지 않은 요약 결손 이유 |
| `provenance_evidence_ids` | json | N | summary를 구성한 핵심 evidence |
| `flags` | json | N | `truncated`, `dynamicPath`, `unsupportedPattern` 등 |
| `confidence` | real | N | summary confidence |
| `source_hash` | text | N | invalidation key |
| `status` | text | N | `ACTIVE`, `SUPERSEDED`, `INVALIDATED` |
| `created_at` | timestamp | N | 생성 시각 |
| `updated_at` | timestamp | N | 수정 시각 |

제약:

- PK: `id`
- UNIQUE: `(workspace_id, function_id, summary_version)`
- CHECK: `status IN ('ACTIVE', 'SUPERSEDED', 'INVALIDATED')`

규칙:

- `outbound_http`, `outbound_db`, `outbound_message` 중 최소 1개는 값이 있어야 한다.
- accepted patch로 summary가 바뀌면 기존 row를 덮어쓰지 않고 `summary_version + 1` row를 생성해야 한다.
- `summary_version`은 payload schema 변경뿐 아니라 summary confidence 계산식 변경 시에도 증가해야 한다.
- `signal_sources`와 `provenance_evidence_ids`는 deterministic patch 전후 diff를 설명할 수 있어야 한다.
- `extraction_strategy`는 `ast_primary | mixed_signals | legacy_edges_fallback` 중 하나여야 한다.
- `mixed_signals`는 AST/HYBRID primary + legacy corroboration이 함께 있을 때만 허용된다.

### 4.2.1 `domain_inference_profiles.proofConfidenceConfig`

workspace default inference profile은 proof confidence 계산 설정을 가진다.

기본 shape:

```json
{
  "name": "intent-proof-default",
  "version": "v1",
  "weights": {
    "summaryQuality": 0.45,
    "slotCompleteness": 0.25,
    "corroborationPerSignal": 0.05,
    "corroborationCap": 0.2,
    "contradictionPenaltyPerItem": 0.2,
    "contradictionPenaltyCap": 0.6
  },
  "slotWeights": {
    "http": {
      "method": 0.2,
      "externalPath": 0.2,
      "internalPath": 0.2,
      "providerService": 0.2,
      "targetObject": 0.2
    },
    "db": {
      "action": 0.25,
      "table": 0.25,
      "schema": 0.15,
      "datasource": 0.1,
      "targetObject": 0.25
    },
    "message": {
      "channel": 0.4,
      "broker": 0.2,
      "objectType": 0.15,
      "targetObject": 0.25
    }
  }
}
```

규칙:

- profile이 없거나 필드가 비어 있으면 위 기본값을 사용한다.
- resolver는 run 단위 preload context에서 이 profile snapshot을 한 번 읽고 재사용한다.

### 4.3 `route_transforms`

gateway/proxy/ingress를 위한 공통 IR 저장소다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `workspace_id` | text | N | workspace |
| `plugin_key` | text | Y | route를 추출한 gateway plugin 식별자 |
| `plugin_version` | text | Y | 추출 plugin 버전 |
| `created_run_id` | text | N | 생성 run |
| `updated_run_id` | text | N | 갱신 run |
| `gateway_kind` | text | N | `zuul`, `spring_cloud_gateway`, `kong`, `envoy`, `ingress`, `custom` |
| `owner_service_id` | text | Y | 소유 서비스 |
| `match_host` | text | Y | 호스트 조건 |
| `match_path` | text | N | 외부 path pattern |
| `match_mode` | text | N | `exact`, `prefix`, `regex` |
| `strip_prefix_count` | integer | Y | prefix strip 개수 |
| `prepend_prefix` | text | Y | path prepend |
| `rewrite_regex` | text | Y | rewrite regex |
| `rewrite_replacement` | text | Y | rewrite replacement |
| `path_capture_policy` | text | Y | wildcard/regex capture 정책 |
| `route_mount_prefix` | text | Y | gateway mount base prefix |
| `target_service_hint` | text | Y | target service alias |
| `target_host_alias` | text | Y | target host alias |
| `target_path_base_hint` | text | Y | provider 내부 path base 힌트 |
| `priority` | integer | N | 정렬 우선순위 |
| `evidence_ids` | json | N | provenance |
| `source_hash` | text | N | invalidation key |
| `created_at` | timestamp | N | 생성 시각 |
| `updated_at` | timestamp | N | 수정 시각 |

제약:

- PK: `id`
- UNIQUE: `(workspace_id, source_hash)`
- CHECK: `match_mode IN ('exact', 'prefix', 'regex')`

인덱스:

- `idx_route_transforms_ws_owner (workspace_id, owner_service_id, gateway_kind)`
- `idx_route_transforms_ws_targethint (workspace_id, target_service_hint)`
- `idx_route_transforms_ws_path (workspace_id, match_path)`

규칙:

- vendor-specific raw payload만 저장해서는 안 된다.
- resolver는 `RouteTransform IR`만 읽어야 한다.
- route transform chain은 순서 보장된 리스트로 적용되어야 한다.

### 4.4 `alias_bindings`

host/base-url/service discovery alias 해석 결과의 정규 캐시다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `workspace_id` | text | N | workspace |
| `created_run_id` | text | N | 생성 run |
| `updated_run_id` | text | N | 갱신 run |
| `binding_kind` | text | N | `base_url`, `service_discovery`, `gateway_target`, `property_alias` |
| `owner_service_id` | text | Y | alias를 선언한 서비스 |
| `alias_key` | text | N | 예: `orders.base-url`, `lb://payment` |
| `alias_value` | text | N | 원본 값 |
| `resolved_service_id` | text | Y | 해석된 service object id |
| `resolved_host` | text | Y | 해석된 host |
| `evidence_ids` | json | N | provenance |
| `confidence` | real | N | binding confidence |
| `source_hash` | text | N | invalidation key |
| `status` | text | N | `ACTIVE`, `INVALIDATED` |
| `created_at` | timestamp | N | 생성 시각 |
| `updated_at` | timestamp | N | 수정 시각 |

제약:

- PK: `id`
- UNIQUE: `(workspace_id, source_hash)`
- CHECK: `status IN ('ACTIVE', 'INVALIDATED')`

규칙:

- `resolved_service_id`와 `resolved_host` 중 최소 1개는 값이 있어야 한다.
- heuristic binding은 deterministic binding보다 우선할 수 없다.

### 4.5 `proof_states`

추론의 핵심 실행 상태다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `workspace_id` | text | N | workspace |
| `intent_id` | text | N | root intent 또는 owning intent |
| `origin_intent_id` | text | N | root seed intent id |
| `parent_proof_state_id` | text | Y | route-family root 또는 parent proof |
| `proof_type` | text | N | intent type와 동일 |
| `status` | text | N | `NEW`, `RESOLVING`, `CLOSED_ATOMIC`, `FRONTIER`, `REJECTED` |
| `consumer_service_id` | text | N | source service |
| `source_function_id` | text | Y | source function |
| `provider_service_id` | text | Y | resolved provider service |
| `target_object_type` | text | Y | `api_endpoint`, `db_table`, `topic`, `queue` |
| `target_object_id` | text | Y | endpoint/table/topic/queue object id |
| `method_resolved` | text | Y | 해석된 method |
| `external_path_resolved` | text | Y | 정규화된 외부 path |
| `internal_path_resolved` | text | Y | route 적용 후 path |
| `route_chain` | json | N | 적용된 transform id 목록 |
| `slot_state` | json | N | 슬롯별 상태 |
| `ambiguity_count` | integer | N | 후보 개수 |
| `contradiction_count` | integer | N | 모순 카운트 |
| `confidence` | real | N | 최종 confidence |
| `confidence_breakdown` | json | N | summary quality, slot completeness, corroboration, penalty factor, `confidenceProfileName`, `confidenceProfileVersion` |
| `frontier_code` | text | Y | frontier reason |
| `rejected_reason` | text | Y | 거절 이유 |
| `created_at` | timestamp | N | 생성 시각 |
| `updated_at` | timestamp | N | 수정 시각 |

제약:

- PK: `id`
- CHECK: `status IN ('NEW', 'RESOLVING', 'CLOSED_ATOMIC', 'FRONTIER', 'REJECTED')`
- CHECK: `target_object_type IS NULL OR target_object_type IN ('api_endpoint', 'db_table', 'topic', 'queue')`
- CHECK: `NOT (status = 'CLOSED_ATOMIC' AND target_object_id IS NULL)`

인덱스:

- `idx_proof_states_ws_status (workspace_id, status)`
- `idx_proof_states_ws_consumer_status (workspace_id, consumer_service_id, status)`
- `idx_proof_states_ws_provider_status (workspace_id, provider_service_id, status)`
- `idx_proof_states_ws_target (workspace_id, target_object_id)`
- `idx_proof_states_ws_origin (workspace_id, origin_intent_id, status)`
- `idx_proof_states_ws_parent (workspace_id, parent_proof_state_id, status)`

규칙:

- direct `http_call` root proof는 intent당 정확히 하나여야 한다.
- `http_gateway_route`는 root proof 하나와 복수 child proof를 가질 수 있다.
- child proof는 `origin_intent_id`를 공유하고 `parent_proof_state_id`를 가져야 한다.
- `slot_state`에는 route-family frontier인 경우 `endpointCandidateSet`과 `routeFamilyState`가 포함돼야 한다.

### 4.6 `proof_steps`

proof 상태 변화의 구조화 로그다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `proof_state_id` | text | N | FK |
| `step_order` | integer | N | 순서 |
| `step_type` | text | N | `anchor`, `hydrate_summary`, `resolve_alias`, `apply_route`, `derive_endpoint_set`, `spawn_child_proof`, `match_endpoint`, `validate`, `reject`, `frontier` |
| `status` | text | N | `APPLIED`, `SKIPPED`, `FAILED` |
| `input_snapshot` | json | N | 입력 |
| `output_snapshot` | json | N | 출력 |
| `evidence_ids` | json | N | provenance |
| `message` | text | Y | 설명 |
| `created_at` | timestamp | N | 생성 시각 |

규칙:

- `proof_steps`는 append-only여야 한다.

### 4.7 `proof_frontiers`

frontier를 별도 인덱싱해 재시도와 UI를 단순화한다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `proof_state_id` | text | N | PK/FK |
| `workspace_id` | text | N | workspace |
| `frontier_reason` | text | N | 세부 reason |
| `frontier_class` | text | N | `ALIAS`, `ROUTE`, `PATH`, `METHOD`, `TARGET`, `SUMMARY`, `CONTRADICTION`, `UNSUPPORTED` |
| `detail` | json | N | 슬롯 누락 상세 |
| `retry_strategy` | text | N | `DETERMINISTIC_ONLY`, `AGENT_ALLOWED`, `MANUAL_REVIEW` |
| `priority` | integer | N | agent 우선순위 |

규칙:

- `detail`은 route-family frontier면 `endpointCandidateSet.objectIds[]`, `endpointCandidateSet.count`, `endpointCandidateSet.matchBasis`, `routeFamilyState`를 포함해야 한다.
- `frontier_reason`은 `INSUFFICIENT_CONTEXT` 같은 뭉뚱그린 값을 허용하지 않는다.

### 4.8 `proof_patches`

agent/deterministic plugin이 생성한 patch다.

| 컬럼 | 타입 | Nullable | 설명 |
|---|---|---:|---|
| `id` | text | N | PK |
| `workspace_id` | text | N | workspace |
| `proof_state_id` | text | Y | 특정 frontier 대상 |
| `patch_type` | text | N | `alias_binding`, `function_summary_patch`, `route_transform_patch`, `method_path_patch`, `endpoint_disambiguation`, `reject_patch` |
| `payload` | json | N | 구조화 결과 |
| `source_kind` | text | N | `deterministic`, `agent`, `manual` |
| `validation_status` | text | N | `PENDING`, `ACCEPTED`, `REJECTED` |
| `evidence_ids` | json | N | provenance |

---

## 5. 기존 테이블과의 관계

- `objects`: atomic/compound object catalog의 source of truth
- `evidences`: provenance 저장소로 유지
- `relation_candidates`: closed proof projection 전용
- `relation_candidate_evidences`: proof를 닫는 데 사용된 evidence만 연결
- `object_relations`: 승인 후 promoted relation 저장소
- `object_rollups`: service ↔ service / compound projection

---

## 6. InteractionIntent 스키마

intent는 slot 기반으로 강하게 정의한다.

### 6.1 공통 anchor

모든 intent는 아래 anchor를 반드시 가진다.

- `workspace_id`
- `intent_type`
- `source_service_id`

### 6.2 HTTP_CALL_INTENT 슬롯

- `method_hint`
- `external_path_hint`
- `host_hint`
- `config_keys`
- `summary_refs`

### 6.3 HTTP_GATEWAY_ROUTE_INTENT 슬롯

- `gateway_kind`
- `route_scope_kind`
- `external_route_pattern`
- `provider_hint` 또는 `target_service_hint`
- `route_transform_refs`
- `method_constraint`

규칙:

- `method_constraint='unknown'`을 허용한다.
- method가 없다고 route-family seed를 버리지 않는다.
- route-family seed는 direct candidate projection 대상이 아니다.

### 6.4 DB_ACCESS_INTENT 슬롯

- `db_action_hint`
- `schema_hint`
- `table_hint`
- `query_fragment_hash`

### 6.5 MESSAGE_* 슬롯

- `broker_kind`
- `topic_hint`
- `queue_hint`
- `routing_key_hint`

### 6.6 partial intent 규칙

- method만 있음
- path만 있음
- host alias만 있음
- config key만 있음
- route family만 있고 method가 없음
- function summary가 truncated지만 outbound hint가 있음

단, 아래는 강제한다.

- anchor는 반드시 존재
- 최소 1개 이상의 downstream slot 힌트 존재
- 같은 anchor + normalized hint set 조합은 dedupe

---

## 7. 핵심 불변식

1. `relation_candidates.object`는 `api_endpoint | db_table | topic | queue`만 허용한다.
2. `targetType = service` projection은 금지한다.
3. `http_gateway_route`는 root seed와 child proof lineage를 가진다.
4. route-family frontier는 `endpointCandidateSet`을 구조화 상태로 남겨야 한다.
5. legacy `configCodeBinding`식 endpoint fan-out은 상태 모델에 복원하지 않는다.
