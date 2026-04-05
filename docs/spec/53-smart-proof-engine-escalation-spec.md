# 53. Smart Proof Engine Escalation (SPEC)

상태: Proposed
우선순위: P0
상위 문서:
- [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
- [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md)
관련 설계 문서:
- [09-intent-centric-proof-engine-overview.md](../design/09-intent-centric-proof-engine-overview.md)
- [11-intent-centric-proof-engine-resolution-pipeline.md](../design/11-intent-centric-proof-engine-resolution-pipeline.md)
- [13-smart-proof-engine-escalation.md](../design/13-smart-proof-engine-escalation.md)
작성일: 2026-04-05

---

## 1. 목적

이 문서는 [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)와
[50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md)
위에 추가되는 `Smart Proof Engine`의 확장 계약만 정의한다.

핵심 목표는 하나다.

> **결정론적 proof engine을 유지한 채, frontier-local LLM escalation으로 unresolved proof를 atomic closure에 더 가깝게 밀어 넣는다.**

즉, 이 문서는 proof engine 공통 철학을 다시 정의하지 않고,
아래 세 가지에만 집중한다.

1. `smartProof` 실행 계약
2. frontier-local LLM 개입 category
3. 예산, acceptance, audit 규칙

---

## 2. 배경

proof engine 공통 원칙은 `48/50`을 따른다.
이 문서가 다루는 문제는 그 위에서 남는 Smart 전용 갭이다.

1. `frontierAgent`는 현재 결정론적 patcher라서 recall 회복 폭이 제한적이다.
2. 일부 `HOST_ALIAS_UNRESOLVED`, `CONFIG_BINDING_MISSING`, `ENDPOINT_MATCH_AMBIGUOUS`, `METHOD_UNKNOWN` 케이스는 정적 규칙만으로 닫기 어렵다.
3. 기존 Smart 문서인 [37-smart-pipeline-atomic-redesign-spec.md](./deprecated/37-smart-pipeline-atomic-redesign-spec.md), [42-agent-assisted-smart-atomic-spec.md](./deprecated/42-agent-assisted-smart-atomic-spec.md)는 pair-scoped Smart pipeline 계약을 중심으로 작성되어 있어, 현재 proof engine 아키텍처와 직접 맞물리지 않는다.

따라서 현재 제품 계약에서 Smart는
`proof engine 이후의 선택적 escalation`으로만 해석한다.

---

## 3. 범위

### 3.1 포함

- deterministic proof engine 이후의 선택적 Smart escalation
- `smartProof` 실행 계약
- frontier-local structured patch proposal
- validator 기반 acceptance/review/skip 흐름
- Smart 호출 감사 로그, 예산, 메트릭
- 1차 frontier reason 범위 정의

### 3.2 제외

- pair-first Smart pipeline의 재도입
- relation candidate 직접 생성
- proof validator 우회
- repo 전체를 무제한 탐색하는 자율 에이전트
- 승인 없는 자동 relation promotion

---

## 4. 기본 원칙

1. Smart는 `48/50`의 proof engine을 대체하지 않고 그 뒤에 붙는다.
2. LLM은 relation truth가 아니라 patch만 제안한다.
3. 모든 Smart patch는 기존 deterministic validator를 통과해야 한다.
4. Smart 전용 추가 규칙은 예산 상한, acceptance 기준, audit 가능성이다.

---

## 5. 제품 계약

### 5.1 모드 정의

```text
Static Mode
  deterministic proof engine
  + deterministic frontier agent

Smart Mode
  deterministic proof engine
  + deterministic frontier agent
  + selective LLM escalation
```

정리하면:

- Static는 순수 결정론적 실행이다.
- Smart는 결정론적 실행을 대체하지 않고, frontier-local escalation만 추가한다.

### 5.2 Smart의 역할

Smart는 아래 역할만 수행한다.

- frontier 해소를 위한 slot-level patch 제안
- ambiguity 해소를 위한 구조화 ranking 제안
- summary 품질 부족 함수에 대한 제한적 enhancement 제안
- 저신뢰도 proof에 대한 contradiction challenge 제안

Smart가 수행하지 않는 역할:

- relation truth 선언
- candidate 직접 upsert
- approval/reject 판정 대체
- 서비스 쌍 자체를 새로 생성하는 seed 단계 대체

---

## 6. API 계약

### 6.1 요청 계약

`POST /api/inference/run`은 장기 표준 진입점으로 유지한다.

```ts
interface InferenceRunRequest {
  workspaceId: string;
  sources?: Array<{ type: 'local'; ref: string }>;
  smartProof?: boolean | SmartProofConfig;
}
```

`smartProof: true`는 기본 설정으로 Smart 모드를 활성화한다.
`smartProof`를 생략하거나 `false`로 보내면 Static 모드다.

### 6.2 Smart 전용 래퍼

`POST /api/inference/smart`는 당분간 thin wrapper로 유지할 수 있다.

규칙:

- 내부적으로는 `run + smartProof` 계약으로 수렴해야 한다.
- legacy `analysisMode` 같은 pair-first Smart 입력은 더 이상 제품 계약으로 유지하지 않는다.
- Smart 전용 라우트는 UX 호환 계층이지 별도 추론 엔진 엔드포인트가 아니다.

### 6.3 SmartProofConfig

```ts
interface SmartProofConfig {
  enabled: boolean;
  categories: {
    preResolutionEnhancement: boolean;
    frontierResolution: boolean;
    ambiguityResolution: boolean;
    crossProofCorrelation: boolean;
    contradictionDetection: boolean;
  };
  budget: {
    maxLlmCallsPerRun: number;
    maxLlmCallsPerIntent: number;
    maxInputTokensPerCall: number;
    maxTotalTokensPerRun: number;
  };
  thresholds: {
    autoAcceptConfidence: number;
    reviewConfidence: number;
    skipConfidence: number;
  };
  model?: string;
  temperature?: number;
}
```

기본값:

- `frontierResolution=true`
- 나머지 category는 점진적으로 활성화
- `autoAcceptConfidence=0.80`
- `reviewConfidence=0.50`
- `skipConfidence=0.30`

---

## 7. 실행 순서

Smart의 실행 순서는 아래를 따른다.

```text
1. deterministic proof engine run
2. deterministic frontier agent pass
3. Smart escalation pass
   3a. Category A: Pre-Resolution Enhancement
   3b. Category B: Frontier Resolution
   3c. Category C: Ambiguity Resolution
   3d. Category D: Cross-Proof Correlation
   3e. Category E: Contradiction Detection
4. accepted patch에 한해 proof re-run
5. final proof summary 집계
```

1차 구현에서는 Category B를 핵심 경로로 본다.

---

## 8. Category 정의

### 8.1 Category A. Pre-Resolution Enhancement

목적:

- function summary 품질 부족으로 frontier가 반복되는 함수를 선별 보강한다.

제한:

- `legacy_edges_fallback`
- `dynamicPath` 또는 `dynamicHost` 또는 `truncated`
- `summaryCompleteness < 0.6`

주의:

- AST/HYBRID primary signal 품질이 기준선에 도달하기 전에는 기본 활성화하지 않는다.

### 8.2 Category B. Frontier Resolution

목적:

- deterministic 단계가 남긴 frontier를 LLM structured patch로 해소 시도한다.

현재 지원 frontier reason:

- `HOST_ALIAS_UNRESOLVED`
- `CONFIG_BINDING_MISSING`
- `ENDPOINT_MATCH_AMBIGUOUS`
- `METHOD_UNKNOWN`
- `ROUTE_FAMILY_DERIVATION_EMPTY`
- `ROUTE_TO_ENDPOINT_COMPOSITION_FAILED`

후속 확장 후보:

- `PATH_TEMPLATE_UNKNOWN`
- `DB_TABLE_UNRESOLVED`
- `DB_SCHEMA_AMBIGUOUS`
- `MESSAGE_TARGET_UNRESOLVED`
- `PATH_REWRITE_CONFLICT`

`ROUTE_FAMILY_DERIVATION_EMPTY`, `ROUTE_TO_ENDPOINT_COMPOSITION_FAILED`는 이미 1차 지원이 완료되어 후속 확장 후보에서 제외한다.

### 8.3 Category C. Ambiguity Resolution

목적:

- Category B 이후에도 남는 ambiguous frontier를 ranking 기반으로 좁힌다.

조건:

- deterministic unique match가 실패한 경우만 허용
- top-1 선택 근거와 대안 ranking을 함께 남겨야 한다

### 8.4 Category D. Cross-Proof Correlation

목적:

- 동일 서비스/동일 패턴 frontiers를 묶어 batch resolution 효율을 높인다.

조건:

- 개별 frontier보다 강한 공통 패턴 증거가 있어야 한다
- batch 결과도 proof별 patch로 환원 가능해야 한다

### 8.5 Category E. Contradiction Detection

목적:

- 저신뢰도 `CLOSED_ATOMIC` proof를 재검토해 오탐을 줄인다.

조건:

- proof를 직접 reject하지 않고 `CHALLENGE`를 제안한다
- challenge 이후 상태 전이는 deterministic 규칙에 따라 수행한다

---

## 9. Smart Frontier Resolver 계약

### 9.1 입력

각 Smart resolver는 최소한 아래 정보를 입력으로 받는다.

```ts
interface FrontierResolutionContext {
  intent: {
    type: string;
    sourceService: string;
    methodHint: string | null;
    pathHint: string | null;
    hostHint: string | null;
    configKeys: string[];
  };
  proofState: {
    currentSlots: Record<string, unknown>;
    appliedSteps: string[];
    frontierReason: string;
    frontierDetail: Record<string, unknown>;
  };
  functionSummary?: unknown;
  codeSnippet?: string;
  availableServices?: Array<{ id: string; name: string; endpointCount: number }>;
  candidateEndpoints?: Array<{ id: string; method: string; path: string; serviceName: string }>;
  aliasBindings?: Array<{ key: string; value: string; resolvedService: string | null }>;
  routeTransforms?: Array<{ matchPath: string; targetService: string | null; rewriteRule: string | null }>;
  relatedProofs?: Array<{ intentType: string; status: string; resolvedService: string | null; resolvedEndpoint: string | null }>;
}
```

### 9.2 출력

LLM 출력은 자연어가 아니라 구조화 schema를 따라야 한다.

규칙:

- `resolved: false`를 명시적으로 반환 가능해야 한다
- confidence는 `0..1` 범위여야 한다
- reasoning은 audit 목적의 짧은 설명만 허용한다
- patch payload는 LLM이 직접 저장하지 않고 adapter가 생성한다

### 9.3 Patch 변환

Smart resolver 결과는 기존 `ProofPatch` 형식으로 변환되어야 한다.

추가 규칙:

- `sourceKind = 'smart_agent'`
- evidence에는 `smart-agent:<frontierReason>` 같은 provenance를 남긴다
- patch 저장 후에도 반드시 validator와 proof re-run을 거친다

---

## 10. 수락 흐름

Smart patch의 수락 흐름은 아래를 따른다.

```text
LLM 제안
  ↓
1. structured schema validation
  ↓
2. deterministic patch validation
  ↓
3. confidence gate
  ↓
4. accepted patch만 proof re-run
  ↓
5. re-run 결과가 CLOSED_ATOMIC일 때만 해소 성공
```

confidence gate 규칙:

- `confidence >= autoAcceptConfidence`
  - `ACCEPTED`
- `reviewConfidence <= confidence < autoAcceptConfidence`
  - `PENDING_REVIEW`
- `confidence < reviewConfidence`
  - `SKIPPED`

중요 규칙:

- Smart patch acceptance는 relation acceptance가 아니다.
- `PENDING_REVIEW` patch는 저장되더라도 proof 상태를 자동 확정하지 않는다.
- validator 실패 patch는 audit만 남기고 proof를 오염시키지 않는다.

---

## 11. 데이터 모델 변경

### 11.1 `proof_patches`

`source_kind`는 아래 값을 허용해야 한다.

- `deterministic`
- `agent`
- `smart_agent`
- `manual`

### 11.2 `smart_proof_llm_calls`

Smart LLM 호출 추적용 테이블을 추가한다.

최소 컬럼:

- `id`
- `workspace_id`
- `run_id`
- `proof_state_id`
- `call_category`
- `frontier_reason`
- `model`
- `temperature`
- `input_tokens`
- `output_tokens`
- `estimated_cost_usd`
- `prompt_hash`
- `response_hash`
- `prompt_snapshot`
- `response_snapshot`
- `confidence`
- `accepted`
- `patch_id`
- `duration_ms`
- `created_at`

### 11.3 inference profile

`domain_inference_profiles` 또는 동등한 실행 설정 저장소에 `smart_proof_config`를 저장할 수 있어야 한다.

원칙:

- profile default는 `enabled=false`
- Smart 실행은 요청별 override를 허용한다

---

## 12. 요약 메트릭

`ProofEngineSummary`는 Smart 모드 메트릭을 포함해야 한다.

```ts
interface SmartModeSummary {
  enabled: boolean;
  llmCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  frontierResolvedByLlm: number;
  summaryEnhancedByLlm: number;
  contradictionsChallenged: number;
  autoAcceptedCount: number;
  pendingReviewCount: number;
  skippedCount: number;
  resolutionByCategory: Record<string, number>;
  resolutionByFrontierReason: Record<string, number>;
}
```

run summary는 최소한 아래 질문에 답할 수 있어야 한다.

1. Smart가 켜졌는가
2. 몇 번 호출했는가
3. 얼마나 비용을 썼는가
4. 어떤 frontier를 얼마나 줄였는가
5. 몇 개가 auto-accept / review / skip 되었는가

---

## 13. 단계별 구현 범위

### Phase 1. 공통 인프라

- `SmartProofConfig`
- `smart_agent` source kind
- `smart_proof_llm_calls`
- Smart summary 메트릭
- run route / smart route 계약 정리

### Phase 2. Category B 1차

- `HOST_ALIAS_UNRESOLVED`
- `CONFIG_BINDING_MISSING`
- `ENDPOINT_MATCH_AMBIGUOUS`
- `METHOD_UNKNOWN`

목표:

- frontier 비율을 실질적으로 줄일 첫 번째 ROI 구간 확보

### Phase 3. Category A

- 제한적 summary enhancement
- enhancement 후 관련 intent만 재실행

### Phase 4. Category C / D

- ambiguity ranking
- correlation batch resolution

### Phase 5. Category E

- 저신뢰도 proof challenge

---

## 14. 수용 기준

| ID | 기준 |
|---|---|
| T1 | Smart는 deterministic proof engine 이후에만 실행된다 |
| T2 | Smart는 relation candidate를 직접 생성하지 않는다 |
| T3 | Smart patch는 항상 deterministic validator를 통과해야 한다 |
| T4 | `smartProof` 계약으로 Static/Smart를 구분할 수 있다 |
| T5 | `HOST_ALIAS_UNRESOLVED`, `CONFIG_BINDING_MISSING`, `ENDPOINT_MATCH_AMBIGUOUS`, `METHOD_UNKNOWN`에 대한 1차 Smart resolver가 존재한다 |
| T6 | Smart 호출 이력과 patch 수락 여부를 run/proof 단위로 추적할 수 있다 |
| T7 | Smart run summary에서 호출 수, 토큰 수, 비용, frontier 해소 수를 확인할 수 있다 |
| T8 | validator 실패 또는 저신뢰도 patch는 proof를 잘못 닫지 않는다 |
| T9 | Static run 결과는 Smart 미사용 시 기존과 동일해야 한다 |
| T10 | Smart route는 별도 pair-first 추론 엔진이 아니라 run 계약의 wrapper로 수렴한다 |

---

## 15. 테스트 전략

### 15.1 단위 테스트

- Smart config parsing
- budget tracker
- frontier reason별 prompt context assembly
- schema validation 및 patch adapter
- confidence gate

### 15.2 통합 테스트

- `executeInferenceRun()`에서 Smart off/on parity
- accepted patch 후 proof re-run
- validator reject 시 frontier 유지
- run summary 메트릭 기록

### 15.3 벤치마크

- static vs smart frontier rate 비교
- resolved frontier당 비용 측정
- false positive rate 측정

---

## 16. 기존 Smart 문서와의 관계

아래 문서는 삭제 대상은 아니지만, 현재 제품 계약의 직접 기준은 아니다.

- [37-smart-pipeline-atomic-redesign-spec.md](./deprecated/37-smart-pipeline-atomic-redesign-spec.md)
- [42-agent-assisted-smart-atomic-spec.md](./deprecated/42-agent-assisted-smart-atomic-spec.md)

정리 원칙:

- 37/42는 pair-scoped Smart pipeline의 역사적 설계 기록으로 남긴다.
- 현재 구현과 향후 확장 기준은 이 문서와 [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md), [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md)를 우선 참조한다.

---

## 17. 최종 결정 요약

이번 Smart Proof Engine의 본질은 아래 다섯 줄이다.

1. Smart는 별도 추론 엔진이 아니라 proof engine 위의 escalation 레이어다.
2. deterministic pipeline과 frontier agent는 그대로 유지한다.
3. LLM은 frontier-local structured patch proposer로만 동작한다.
4. validator와 proof re-run이 최종 판정 권한을 가진다.
5. 1차 구현은 Category B의 4개 frontier reason부터 시작한다.
