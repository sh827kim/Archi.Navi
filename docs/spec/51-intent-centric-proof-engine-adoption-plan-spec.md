# 51. Intent-Centric Proof Engine Adoption Plan (SPEC)

상태: Transition Reference
우선순위: P0
상위 문서: [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
관련 디자인 문서: [12-intent-centric-proof-engine-adoption-plan.md](../design/12-intent-centric-proof-engine-adoption-plan.md)
작성일: 2026-03-31
최종 정리: 2026-04-04
상태 메모: proof engine 전환의 큰 축은 반영되었고, 이 문서는 컷오버/운영 기준을 남긴 전환 기록으로 유지한다.

---

## 1. 범위

이 문서는 Intent-Centric Proof Engine을 실제 코드베이스와 제품 경험에 연결하는 교체 계획을 다룬다.

포함 범위:

- 기존 컴포넌트 대체 매핑
- 구현 패키지 구조
- 내부 서비스 경계
- API/운영 진입점
- UI/설명가능성
- 성능 원칙
- cutover 기준과 리스크

---

## 2. 기존 컴포넌트 대체 매핑

| 기존 컴포넌트 | 새 상태 | 설명 |
|---|---|---|
| `codeBased.ts` | 대체 | candidate 생성 대신 intent 추출 + function summary 생성 |
| `configBased.ts` | 대체 | alias binding / route transform 추출 + gateway route family seed 추출 |
| `configCodeBinding.ts` | 제거 | service candidate → endpoint fan-out 구조 폐기 |
| `routeFamilyDeriver` | 신규 | gateway route family seed에서 endpoint-scoped child proof를 결정적으로 파생 |
| `crossSignalValidation.ts` | 대체 | proof slot validation + contradiction handling으로 전환 |
| `smartPipeline.ts` | 대체 | pair-scoped pipeline 제거, frontier agent orchestration으로 교체 |
| `candidateStore.ts` | 축소 | closed proof projection 저장 전용 |
| `feedbackLoop.ts` | 축소 | hierarchical calibration 적용 |
| `approveRelationCandidate.ts` | 유지/수정 | proof metadata를 보여주도록 수정 |

---

## 3. 구현 패키지 구조

```text
packages/inference/src/
  extraction/
    functionSummary/
    intents/
    aliasBindings/
    routeTransforms/
  resolver/
    pipeline/
      httpCallResolver.ts
      httpGatewayRouteResolver.ts
      dbAccessResolver.ts
      messageResolver.ts
    steps/
      hydrateSummary.ts
      resolveHostAlias.ts
      normalizeMethodPath.ts
      applyRouteTransforms.ts
      deriveEndpointSet.ts
      spawnChildProofs.ts
      matchEndpoint.ts
      validateProof.ts
    frontier/
      frontierClassifier.ts
      frontierQueue.ts
    projection/
      projectClosedProof.ts
  agent/
    proofPatchPrompts.ts
    proofPatchValidator.ts
    frontierAgent.ts
  storage/
    intentsStore.ts
    summariesStore.ts
    aliasBindingsStore.ts
    routeTransformsStore.ts
    proofStateStore.ts
    frontierStore.ts
    proofPatchStore.ts
  orchestration/
    proofEngineRun.ts
```

---

## 4. 내부 서비스 경계

### 4.1 서비스 인터페이스

```ts
interface IntentExtractor {
  extract(workspaceId: string, changedFiles?: string[]): Promise<InteractionIntent[]>;
}

interface ProofResolver {
  resolveIntent(intentId: string): Promise<ProofResolutionResult>;
}

interface FrontierAgent {
  patch(frontierId: string): Promise<ProofPatch[]>;
}

interface CandidateProjector {
  projectClosedProof(proofStateId: string): Promise<void>;
}
```

route-family child proof spawning은 `ProofResolver` 내부 구현으로 캡슐화한다.
외부 인터페이스는 intent 단위 진입점을 유지한다.

### 4.2 실행 순서

1. extraction
2. summary / alias / route cache 갱신
3. intent 생성
4. route-family root proof / child proof 생성
5. fixed pipeline 실행
6. frontier 생성 또는 closed atomic child proof projection
7. optional agent patch
8. proof 재실행
9. candidate approval

---

## 5. API 계약

기존 UI/운영 진입점은 유지하되, 내부 엔진은 모두 Intent-Centric Proof Engine으로 통일한다.

### 5.1 `POST /api/inference/run`

동기 quick run entrypoint.

```json
{
  "workspaceId": "ws_...",
  "sources": [
    {
      "type": "local",
      "path": "/repo"
    }
  ],
  "transports": ["http", "db", "message"],
  "enableAgentPatches": true,
  "maxAgentFrontiers": 50,
  "forceRescan": false
}
```

### 5.2 `POST /api/inference/runs`

비동기 run 생성 entrypoint.
요청 body는 `POST /api/inference/run`과 동일하다.

### 5.2.1 `GET/PUT /api/inference/profiles/default`

이 endpoint는 workspace default proof confidence profile의 공식 설정면이다.

규칙:

- `proofConfidence` 블록을 응답에 항상 포함한다.
- partial update를 허용하되, 누락 필드는 기존 저장값 또는 기본값을 유지한다.
- run 생성 API(`POST /api/inference/run`, `POST /api/inference/runs`)는 별도 profile override 파라미터를 받지 않는다.

### 5.3 `POST /api/inference/smart`

기존 Smart UI 진입점은 유지하되 semantics를 교체한다.

규칙:

- 내부적으로는 동일한 proof engine을 호출한다.
- `analysisMode` 필드는 더 이상 지원하지 않는다.
- `pair_pack`, `agent_assisted`, `full_agent` 모드는 제거된다.
- agent는 `enableAgentPatches = true`일 때 frontier에만 사용된다.

### 5.4 공통 Response summary

```json
{
  "runId": "run_...",
  "engine": "intent_proof",
  "intentCount": 142,
  "gatewayRouteSeedCount": 21,
  "derivedEndpointProofCount": 37,
  "proofClosedAtomicCount": 81,
  "proofFrontierCount": 34,
  "routeFamilyFrontierCount": 9,
  "proofRejectedCount": 27,
  "projectedCandidateCount": 81,
  "agentFrontierCount": 18,
  "agentPatchedFrontierCount": 9,
  "confidenceProfileName": "intent-proof-default",
  "confidenceProfileVersion": "v1",
  "functionSummaryExtractionBreakdown": {
    "ast_primary": 91,
    "mixed_signals": 18,
    "legacy_edges_fallback": 7
  },
  "frontierBreakdown": {
    "HOST_ALIAS_UNRESOLVED": 11,
    "ENDPOINT_SET_OPEN": 8
  },
  "targetBreakdown": {
    "api_endpoint": 63,
    "db_table": 12,
    "topic": 6
  }
}
```

불변식:

- `serviceTargetProjectionCount = 0`
- `targetBreakdown`에는 `service`가 포함될 수 없다

### 5.5 제거되는 핵심 summary 필드

- `servicePairCount`
- `serviceFallbackCount`
- `fallbackReasonBreakdown`
- `analysisMode = pair_pack | agent_assisted | full_agent`

---

## 6. UI / 설명가능성

### 6.1 Approval UI

approval 화면은 candidate 중심 흐름을 유지하되 proof metadata를 추가한다.

표시 항목:

- source service / source function
- resolved provider endpoint
- route-family root 여부 / parent child lineage
- method/path/route chain
- supporting evidence
- contradiction
- proof steps
- frontier history
- patch history

### 6.2 Frontier UI

frontier는 별도 목록으로 노출한다.

필수 표시:

- frontier reason
- endpoint candidate set 크기 / match basis
- missing slots
- relevant file/config/gateway snippets
- last attempted resolution step
- agent patch 여부
- retry 가능 여부

### 6.3 Compound View

compound/service view는 계속 rollup을 사용한다.
다만 drill-down은 relation candidate가 아니라 **proof chain**까지 내려갈 수 있어야 한다.

---

## 7. 정확도와 탐색 비용에 대한 설계 근거

### 7.1 왜 더 정확한가

- service pair를 seed로 만들지 않으므로 잘못된 provider fan-out을 초기에 차단한다.
- partial evidence를 버리지 않고 intent/proof 상태로 남기므로 wrapper/alias/path-only 케이스를 재시도 가능하게 만든다.
- route-family seed를 별도 모델로 두므로 config-only gateway route를 service fallback 없이 다룰 수 있다.
- 닫힌 proof만 candidate로 투영하므로 approval 목록의 noise가 줄어든다.
- proof step과 patch가 구조화 상태로 남아 설명가능성과 재사용성이 동시에 올라간다.

### 7.2 왜 search explosion을 피할 수 있는가

- provider service가 보였다고 endpoint 전체를 직접 candidate로 순회하지 않는다.
- route-family child proof derivation은 route scope와 transform으로 좁혀진 endpoint 집합에서만 허용한다.
- resolver는 global graph 탐색이 아니라 명시적 슬롯과 타입 제약으로만 join한다.
- frontier를 세분화해 필요한 retry만 수행한다.
- summary/alias/route 결과를 재사용하므로 동일 탐색을 반복하지 않는다.

---

## 8. 성능 원칙

### 8.1 candidate fan-out 금지

provider service가 보였다고 endpoint 전체를 순회하며 후보를 생성하지 않는다.
endpoint index 조회는 method/path/provider 또는 route-family scope 기준으로 좁혀진 뒤에만 수행한다.
route-family derivation은 child proof 생성까지만 허용되며 direct candidate fan-out은 금지한다.

### 8.2 type-safe join

resolver는 global graph 탐색을 하지 않는다.
명시적 슬롯과 타입 제약으로만 join한다.

### 8.3 frontier 우선순위 큐

모든 frontier를 agent에 보내지 않는다.
우선순위 계산은 아래를 반영한다.

- business critical relation type
- proof slot completeness
- frontier reason recoverability
- candidate impact radius
- repeated occurrence count

### 8.4 summary 재사용

동일 function의 summary는 재사용하며, 증분 변경 시에만 다시 계산한다.

---

## 9. 관측 지표

엔진은 아래 메트릭을 기본 노출해야 한다.

- `intentCount`
- `gatewayRouteSeedCount`
- `derivedEndpointProofCount`
- `proofClosedAtomicCount`
- `proofFrontierCount`
- `routeFamilyFrontierCount`
- `confidenceProfileName`
- `confidenceProfileVersion`
- `functionSummaryExtractionBreakdown`
- `proofRejectedCount`
- `projectedCandidateCount`
- `frontierBreakdown`
- `frontierOpenCount`
- `agentFrontierCount`
- `agentPatchedFrontierCount`
- `patchAcceptanceRate`
- `proofAverageResolutionSteps`
- `projectionByTargetType`

더 이상 핵심 메트릭이 아닌 것:

- `servicePairCount`
- `serviceFallbackCount`

---

## 10. 교체 원칙

이 설계는 단계적 migration을 전제로 하지 않는다.

### 10.1 cutover 원칙

- 새 엔진 구현 완료 전까지는 기존 엔진 유지
- 교체 시점에는 기존 inference 경로 비활성화
- 새 엔진을 유일한 inference source of truth로 사용
- 기존 candidate store는 projection sink로만 유지

### 10.2 출시 전 검증

- validated corpus
- hard-case corpus
  - wrapper/facade chain
  - gateway rewrite
  - path-only / alias-only
  - discovery alias
  - endpoint ambiguity
- open-workspace smoke set
- approval workload 비교
- frontier recoverability 비교
- atomic precision/recall 비교
- `intentProofBenchmarkGate`
- `inferenceCutoverFixture`

샘플 저장소가 부족하면 benchmark corpus bootstrap을 선행 milestone로 둔다.

### 10.3 2026-04-04 보강 단계

1. Baseline / SPEC delta
   - benchmark gate와 cutover fixture를 기준선으로 고정한다.
   - function summary v2, frontier agent MVP, composite confidence, gateway plugin 계약을 문서에 반영한다.
2. Function Summary v2
   - AST provenance, signal source, unresolved reason, completeness를 저장한다.
   - extractor는 `AST-first, edges-fallback`으로 동작하며 `extractionStrategy`를 `ast_primary | mixed_signals | legacy_edges_fallback`으로 기록한다.
3. Frontier Agent MVP
   - `alias_binding`, `route_transform_patch`, `endpoint_disambiguation`만 main path에 연결한다.
   - `/api/inference/run`이 더 이상 `NOT_SUPPORTED_IN_INTENT_PROOF`를 정상 흐름처럼 반환하지 않게 한다.
4. Confidence / Endpoint Index / Transport parity
   - composite confidence와 batch/preload endpoint index를 도입한다.
   - DB/message pipeline의 step logging과 contradiction 처리를 HTTP 수준으로 끌어올린다.
5. 운영 하드닝
   - embedded postgres 설정을 환경변수 기반으로 전환한다.
   - frontier/proof chain 관측 지표와 UI drill-down을 마감한다.

---

## 11. 수용 기준

### 11.1 정확도

- validated corpus 기준 atomic precision이 기존 엔진 대비 유의미하게 상승
- validated corpus + hard-case corpus 기준 atomic recall이 비회귀여야 한다
- open-workspace smoke set 기준 closure ratio와 frontier 분포가 악화되지 않아야 한다

### 11.2 구조 불변식

- service fallback candidate가 0이어야 한다
- route-family seed direct projection이 0이어야 한다
- projected candidate의 target type은 atomic only여야 한다

### 11.3 운영성

- frontier reason taxonomy가 실제 unresolved를 설명 가능
- same workspace 재실행 시 frontier patch 재사용 가능
- partial intent가 재해석 가능한 상태로 유지됨

### 11.4 사용자 체감

- 사람이 endpoint를 직접 이어주는 케이스가 눈에 띄게 감소
- approval 목록의 endpoint fan-out noise가 사라짐
- “왜 이 관계가 나왔는가”를 proof step으로 설명 가능

---

## 12. 리스크

### 12.1 function summary 품질

summary 품질이 낮으면 proof 전체가 흔들릴 수 있다.
extractor 품질은 새 엔진의 핵심 선행 조건이다.

### 12.2 frontier 남용

frontier taxonomy가 거칠면 unresolved가 다시 쓰레기통이 된다.
frontier는 구체적이고 재시도 가능한 이유여야 한다.

### 12.3 과도한 partial intent 생성

partial intent를 무조건 많이 만들면 탐색 공간이 퍼질 수 있다.
anchor와 최소 슬롯 규칙을 강하게 유지해야 한다.

### 12.4 patch 오염

agent patch가 검증 없이 누적되면 잘못된 alias/route가 전파될 수 있다.
deterministic validator와 invalidation이 필요하다.

### 12.5 benchmark / fixture 드리프트

synthetic benchmark만 녹색이고 cutover fixture가 깨진 상태를 방치하면 실제 adoption readiness를 잘못 판정할 수 있다.
benchmark gate와 cutover fixture는 둘 다 실행 가능한 상태로 유지되어야 한다.
