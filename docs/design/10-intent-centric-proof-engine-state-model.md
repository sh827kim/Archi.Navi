# 10. Intent-Centric Proof Engine State Model

상태: Proposed
상위 문서: [09-intent-centric-proof-engine-overview.md](./09-intent-centric-proof-engine-overview.md)
작성일: 2026-03-31
최종 정리: 2026-04-04

---

## 1. 범위

이 문서는 Intent-Centric Proof Engine의 정적/반정적 실행 상태를 정의한다.

포함 범위:

- typed extraction 레이어
- 핵심 개념
- 새 1급 테이블
- 기존 테이블과의 관계
- intent/function summary/route transform schema

---

## 2. 추출 레이어

proof 엔진이 안정적으로 동작하려면 pair-local 즉석 해석보다
재사용 가능한 추출 결과가 먼저 쌓여야 한다.

## 2.1 Endpoint Indexer

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

## 2.2 Function Summary Extractor

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

## 2.3 Alias / Config Binding Extractor

목적:

- `payment.url`, `lb://payment`, `http://payment:8080` 같은 간접 식별자를 정규화한다.

최소 출력:

- `config key -> value`
- `value -> service hint`
- `host alias -> service`
- `property override precedence`

## 2.4 Gateway Plugin + RouteTransform IR

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

## 3.1 InteractionIntent

caller 관점에서 추출된 상호작용 의도다.
불완전할 수 있지만, anchor와 최소 힌트가 있으면 버리지 않는다.

HTTP 계열은 두 family로 나뉜다.

- `http_call`: function/callsite 기반 singular call intent
- `http_gateway_route`: config-only gateway route family seed

예시:

```json
{
  "intentType": "http_call",
  "sourceFunctionId": "fn:OrderClient#getOrder",
  "sourceServiceId": "svc:order",
  "methodHint": "GET",
  "externalPathHint": "/api/orders/{id}",
  "hostHint": null,
  "configKeys": ["orders.base-url"]
}
```

```json
{
  "intentType": "http_gateway_route",
  "sourceServiceId": "svc:api-gateway",
  "gatewayKind": "zuul",
  "routeScopeKind": "prefix",
  "externalRoutePattern": "/api/orders/**",
  "targetServiceHint": "order-service",
  "methodConstraint": "unknown"
}
```

## 3.2 FunctionSummary

함수 단위 재사용 가능한 outbound summary다.

요약 대상:

- outbound HTTP
- outbound DB
- outbound message
- alias hints
- call chain hints
- extraction strategy
- summary completeness
- signal sources
- unsupported/truncated flags

## 3.3 RouteTransform

gateway/proxy/service discovery에 의해 발생하는 path/host 변환의 정규 표현이다.

예:

- `stripPrefix(1)`
- `prepend("/api")`
- `rewrite("^/external/(.*)$", "/internal/$1")`
- `hostAlias("lb://payment" -> "payment-service")`

## 3.4 ProofState

intent를 atomic target으로 닫아 가는 주 실행 상태다.
route-family seed에서 파생된 child proof lineage도 포함한다.

상태:

- `RESOLVING`
- `CLOSED_ATOMIC`
- `FRONTIER`
- `REJECTED`

## 3.5 Frontier

proof를 닫지 못했지만 의미 있는 partial state가 남아 있는 상태다.
실패 로그가 아니라 다음 액션의 입력이다.

route-family 계열 frontier는 `endpointCandidateSet`과 `routeFamilyState`를 같이 보존한다.

## 3.6 ProofPatch

deterministic extractor 또는 agent가 frontier 해소를 위해 제안하는 구조화 patch다.
relation이 아니라 slot을 채우는 단위다.

---

## 4. 데이터 모델

새 엔진은 기존 `objects`, `object_relations`, `relation_candidates`, `evidences`를 유지하되,
실행 상태를 위한 1급 테이블을 추가한다.

## 4.1 `interaction_intents`

추론의 seed.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `workspace_id` | text | workspace |
| `intent_type` | enum | `http_call`, `http_gateway_route`, `db_access`, `message_publish`, `message_consume` |
| `source_service_id` | text | consumer service object id |
| `source_function_id` | text nullable | caller function object id |
| `source_file_path` | text nullable | 주 근거 파일 |
| `method_hint` | text nullable | `GET`, `POST` 등 |
| `external_path_hint` | text nullable | direct call의 외부 path template |
| `gateway_kind` | text nullable | `zuul`, `spring_cloud_gateway` 등 |
| `route_scope_kind` | text nullable | `exact`, `prefix`, `regex` |
| `external_route_pattern` | text nullable | gateway 외부 route pattern |
| `provider_hint` | text nullable | gateway/provider host/service 단서 |
| `target_service_hint` | text nullable | route가 가리키는 target service 힌트 |
| `route_transform_refs` | jsonb | 관련 route transform id 목록 |
| `method_constraint` | text nullable | `unknown`, `any`, `exact` |
| `host_hint` | text nullable | host/base-url/alias |
| `resource_hint` | text nullable | table/topic/queue 등 |
| `config_keys` | jsonb | 관련 config key 목록 |
| `summary_refs` | jsonb | 관련 function summary id 목록 |
| `evidence_ids` | jsonb | provenance |
| `status` | enum | `NEW`, `RESOLVING`, `CLOSED_ATOMIC`, `FRONTIER`, `REJECTED` |
| `intent_hash` | text | dedupe / invalidation key |

`http_gateway_route`는 route-family seed다.
이 intent는 projection 대상 candidate가 아니라 child proof 생성의 입력으로 사용된다.

추가로 workspace default inference profile은 `proofConfidenceConfig`를 가진다.
proof resolver는 run 단위 preload context에서 이 profile snapshot을 한 번 읽고 재사용한다.

## 4.2 `function_summaries`

정적 분석 결과의 핵심 재사용 캐시.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `workspace_id` | text | workspace |
| `function_id` | text | function object id |
| `service_id` | text | owner service object id |
| `summary_version` | integer | schema version |
| `summary_kind` | enum | `http`, `db`, `message`, `mixed` |
| `outbound_http` | jsonb nullable | method/path/host/configKeys |
| `outbound_db` | jsonb nullable | action/schema/table |
| `outbound_message` | jsonb nullable | topic/queue/action |
| `call_chain_hints` | jsonb | downstream wrappers / targets |
| `alias_hints` | jsonb | alias 후보 |
| `signal_sources` | jsonb | AST/config/code evidence source 목록 |
| `extraction_strategy` | text | `ast_primary`, `mixed_signals`, `legacy_edges_fallback` |
| `summary_completeness` | real | slot completeness 점수 |
| `unresolved_reasons` | jsonb | 아직 닫히지 않은 요약 결손 이유 |
| `provenance_evidence_ids` | jsonb | summary를 구성한 핵심 evidence |
| `flags` | jsonb | `truncated`, `dynamicPath`, `unsupportedPattern` 등 |
| `confidence` | real | summary confidence |
| `source_hash` | text | invalidation key |

규칙:

- `summary_version`은 payload schema 변경뿐 아니라 summary confidence 계산식 변경 시에도 증가해야 한다.
- `signal_sources`와 `provenance_evidence_ids`는 deterministic patch 전후 diff를 설명할 수 있어야 한다.
- `extraction_strategy`는 `ast_primary | mixed_signals | legacy_edges_fallback` 중 하나여야 한다.
- `mixed_signals`는 AST/HYBRID primary + legacy corroboration이 함께 있을 때만 허용된다.

## 4.3 `route_transforms`

gateway/proxy/ingress를 위한 공통 IR 저장소.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `workspace_id` | text | workspace |
| `plugin_key` | text nullable | route를 추출한 gateway plugin 식별자 |
| `plugin_version` | text nullable | 추출 plugin 버전 |
| `gateway_kind` | enum | `zuul`, `spring_cloud_gateway`, `kong`, `envoy`, `ingress`, `custom` |
| `owner_service_id` | text nullable | 소유 서비스 |
| `match_host` | text nullable | 호스트 조건 |
| `match_path` | text | 외부 path pattern |
| `match_mode` | text | `exact`, `prefix`, `regex` |
| `strip_prefix_count` | integer nullable | prefix strip 개수 |
| `prepend_prefix` | text nullable | path prepend |
| `rewrite_regex` | text nullable | rewrite regex |
| `rewrite_replacement` | text nullable | rewrite replacement |
| `path_capture_policy` | text nullable | wildcard/regex capture 정책 |
| `route_mount_prefix` | text nullable | gateway mount base prefix |
| `target_service_hint` | text nullable | target service alias |
| `target_host_alias` | text nullable | target host alias |
| `target_path_base_hint` | text nullable | provider 내부 path base 힌트 |
| `priority` | integer | 정렬 우선순위 |
| `evidence_ids` | jsonb | provenance |
| `source_hash` | text | invalidation key |

## 4.4 `alias_bindings`

host/base-url/service discovery alias 해석 결과의 정규 캐시.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `workspace_id` | text | workspace |
| `binding_kind` | enum | `base_url`, `service_discovery`, `gateway_target`, `property_alias` |
| `owner_service_id` | text nullable | alias를 선언한 서비스 |
| `alias_key` | text | 예: `orders.base-url`, `lb://payment` |
| `alias_value` | text | 원본 값 |
| `resolved_service_id` | text nullable | 해석된 service object id |
| `resolved_host` | text nullable | 해석된 host |
| `evidence_ids` | jsonb | provenance |
| `confidence` | real | binding confidence |
| `source_hash` | text | invalidation key |

## 4.5 `proof_states`

추론의 핵심 실행 상태.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `workspace_id` | text | workspace |
| `intent_id` | text | root intent 또는 owning intent |
| `origin_intent_id` | text | root seed intent id |
| `parent_proof_state_id` | text nullable | route-family root 또는 parent proof |
| `proof_type` | enum | intent type와 동일 |
| `status` | enum | `RESOLVING`, `CLOSED_ATOMIC`, `FRONTIER`, `REJECTED` |
| `consumer_service_id` | text | source service |
| `source_function_id` | text nullable | source function |
| `provider_service_id` | text nullable | resolved provider service |
| `target_object_type` | text nullable | `api_endpoint`, `db_table`, `topic`, `queue` |
| `target_object_id` | text nullable | endpoint/table/topic object id |
| `method_resolved` | text nullable | 해석된 method |
| `external_path_resolved` | text nullable | 정규화된 외부 path |
| `internal_path_resolved` | text nullable | route 적용 후 path |
| `route_chain` | jsonb | 적용된 transform id 목록 |
| `slot_state` | jsonb | 슬롯별 상태, `endpointCandidateSet`, `routeFamilyState` 포함 |
| `ambiguity_count` | integer | 후보 개수 |
| `contradiction_count` | integer | 모순 카운트 |
| `confidence` | real | 최종 confidence |
| `confidence_breakdown` | jsonb | summary quality, slot completeness, corroboration, penalty factor, `confidenceProfileName`, `confidenceProfileVersion` |
| `closed_reason` | text nullable | 닫힌 이유 |
| `rejected_reason` | text nullable | 거절 이유 |

route-family root proof는 seed 상태를 보존하고,
endpoint-scoped child proof는 `parent_proof_state_id`를 통해 lineage를 추적한다.

## 4.6 `proof_steps`

proof 상태 변화의 구조화 로그.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `proof_state_id` | text | FK |
| `step_order` | integer | 순서 |
| `step_type` | enum | `anchor`, `hydrate_summary`, `resolve_alias`, `apply_route`, `derive_endpoint_set`, `spawn_child_proof`, `match_endpoint`, `validate`, `reject`, `frontier` |
| `status` | enum | `APPLIED`, `SKIPPED`, `FAILED` |
| `input_snapshot` | jsonb | 입력 |
| `output_snapshot` | jsonb | 출력 |
| `evidence_ids` | jsonb | provenance |
| `message` | text nullable | 설명 |

## 4.7 `proof_frontiers`

frontier를 별도 인덱싱해 재시도와 UI를 단순화한다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `proof_state_id` | text | PK/FK |
| `workspace_id` | text | workspace |
| `frontier_reason` | enum | 세부 reason |
| `frontier_class` | enum | `ALIAS`, `ROUTE`, `PATH`, `METHOD`, `TARGET`, `SUMMARY`, `CONTRADICTION`, `UNSUPPORTED` |
| `detail` | jsonb | 슬롯 누락 상세, `endpointCandidateSet`, `routeFamilyState` 표준 구조 포함 |
| `retry_strategy` | enum | `DETERMINISTIC_ONLY`, `AGENT_ALLOWED`, `MANUAL_REVIEW` |
| `priority` | integer | agent 우선순위 |

## 4.8 `proof_patches`

agent/deterministic plugin이 생성한 patch.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text | PK |
| `workspace_id` | text | workspace |
| `proof_state_id` | text nullable | 특정 frontier 대상 |
| `patch_type` | enum | `alias_binding`, `function_summary_patch`, `route_transform_patch`, `method_path_patch`, `endpoint_disambiguation`, `reject_patch` |
| `payload` | jsonb | 구조화 결과 |
| `source_kind` | enum | `deterministic`, `agent`, `manual` |
| `validation_status` | enum | `PENDING`, `ACCEPTED`, `REJECTED` |
| `evidence_ids` | jsonb | provenance |

## 4.9 기존 테이블과의 관계

- `objects`: atomic/compound object catalog의 source of truth
- `evidences`: provenance 저장소로 유지
- `relation_candidates`: closed proof projection 전용
- `relation_candidate_evidences`: proof를 닫는 데 사용된 evidence만 연결
- `object_relations`: 승인 후 promoted relation 저장소
- `object_rollups`: service ↔ service / compound projection

---

## 5. 왜 fact를 전부 evidences에 넣지 않는가

증거 저장과 추론 실행은 목적이 다르다.

- `evidences`: provenance, 설명, 파일/설정/스키마 출처 연결
- `interaction_intents`, `function_summaries`, `route_transforms`, `proof_states`: resolver가 직접 조회·조합·업데이트하는 실행 상태

따라서 **evidence-only 설계는 채택하지 않는다**.
성능과 실행 단위 명확성을 위해 핵심 fact/state는 별도 1급 테이블로 둔다.

---

## 6. InteractionIntent 스키마

intent는 slot 기반으로 강하게 정의한다.

## 6.1 공통 anchor

모든 intent는 아래 anchor를 반드시 가진다.

- `workspace_id`
- `intent_type`
- `source_service_id`

가능하면 아래도 가진다.

- `source_function_id`
- `source_file_path`

## 6.2 HTTP_CALL_INTENT 슬롯

- `method_hint`
- `external_path_hint`
- `host_hint`
- `config_keys`
- `summary_refs`

## 6.3 HTTP_GATEWAY_ROUTE_INTENT 슬롯

- `gateway_kind`
- `route_scope_kind`
- `external_route_pattern`
- `provider_hint` 또는 `target_service_hint`
- `route_transform_refs`
- `method_constraint`

## 6.4 DB_ACCESS_INTENT 슬롯

- `db_action_hint`
- `schema_hint`
- `table_hint`
- `query_fragment_hash`

## 6.5 MESSAGE_* 슬롯

- `broker_kind`
- `topic_hint`
- `queue_hint`
- `routing_key_hint`

## 6.6 partial intent 규칙

다음 조건에서는 intent를 버리지 않는다.

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

## 7. 설계 메모

- route-family seed는 proof 실행의 입력 상태이지 승인 대상 candidate가 아니다.
- service-level relation은 projection이 아니라 approved atomic relation의 rollup으로만 생성된다.
- child proof derivation은 bounded deterministic join이어야 하며, legacy endpoint fan-out을 대체하지만 복원하지는 않는다.
