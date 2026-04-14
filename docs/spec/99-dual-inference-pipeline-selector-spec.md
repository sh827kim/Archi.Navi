# 99. Dual Inference Pipeline Selector (SPEC)

상태: Proposed
우선순위: P0
상위 문서:
- [12-inference-run-orchestration-spec.md](./12-inference-run-orchestration-spec.md)
- [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
- [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md)
- [51-intent-centric-proof-engine-adoption-plan-spec.md](./51-intent-centric-proof-engine-adoption-plan-spec.md)
관련 문서:
- [88-inference-engine-design-aligned-recommendation-2026-04-06.md](./88-inference-engine-design-aligned-recommendation-2026-04-06.md)
- [93-common-http-signal-extraction-coverage-spec.md](./93-common-http-signal-extraction-coverage-spec.md)
- [94-framework-specific-code-scanner-spec.md](./94-framework-specific-code-scanner-spec.md)
- [95-framework-config-parser-hook-spec.md](./95-framework-config-parser-hook-spec.md)
- [96-config-code-binding-completeness-spec.md](./96-config-code-binding-completeness-spec.md)
- [97-multi-module-service-boundary-calibration-spec.md](./97-multi-module-service-boundary-calibration-spec.md)
- [98-bootstrap-engine-policy-alignment-spec.md](./98-bootstrap-engine-policy-alignment-spec.md)
작성일: 2026-04-14

---

## 1. 목적

`보강형(reinforced)` 개선안과 `완전 재설계(redesign)` 개선안을 같은 제품/API 표면 아래에서 선택적으로 실행할 수 있도록, 추론 파이프라인 selector와 내부 전략 분기 계약을 정의한다.

이 문서의 핵심 목표는 다음과 같다.

- 외부 API는 최대한 유지하면서 내부 추론 본체를 두 갈래로 분기할 수 있게 한다.
- 기존 proof-engine-first 경로를 즉시 폐기하지 않고, 보강형 경로를 계속 운영 가능하게 한다.
- 재설계 경로를 별도 코드 경로로 구현하되, 현재 제품이 기대하는 결과 스키마와 운영 관측 계약은 유지한다.
- 저장소 격리는 도입하지 않고도 구현 가능한 범위를 명시한다.

---

## 2. 배경

현재 코드베이스는 사실상 하나의 실행 외피 안에 여러 추론 단계를 직렬로 쌓아 둔 구조다.

- 실행 외피:
  - run claim / source resolve / cancel check / warning/error 누적 / final stats 저장
- 현재 파이프라인 본체:
  - config 추출
  - code 추출
  - bootstrap
  - proof resolution
  - smart proof
  - compat deterministic 후보 생성

이 구조는 다음 두 요구를 동시에 만족시키기 어렵다.

1. 현재 경로를 유지하면서 signal coverage 보강을 즉시 반영해야 한다.
2. 동시에 더 큰 구조 개편을 시험할 수 있는 별도 구현 경로가 필요하다.

본 SPEC은 이를 해결하기 위해 `run envelope(shared)`와 `pipeline body(strategy)`를 분리한다.

---

## 3. 범위

포함 범위:

- `POST /api/inference/run`
- `POST /api/inference/runs`
- `POST /api/inference/smart`
- `createInferenceRun()` / `executeInferenceRun()`의 selector 계약
- `reinforced` / `redesign` 파이프라인 정의
- shared envelope와 pipeline strategy 인터페이스
- run stats / summary / event 계약
- cutover artifact 생성 시 파이프라인 식별 계약
- 테스트 및 수용 기준

제외 범위:

- 파이프라인별 저장소 분리
- 파이프라인별 별도 DB 테이블 도입
- approval UI의 대규모 재설계
- `/api/scan` selector 지원
- 하나의 run에서 두 파이프라인을 동시에 실행하는 dual-run mode
- 두 파이프라인 간 결과 arbitration / merge engine

---

## 4. 비목표

이 문서는 다음을 목표로 하지 않는다.

- `reinforced`와 `redesign` 결과를 row-level로 완전히 분리 저장하는 것
- 두 파이프라인의 산출물을 동시에 truth source로 병합하는 것
- 기존 `intent_proof` 요약 계약을 즉시 폐기하는 것
- 현재 proof/frontier 저장 모델을 전부 새 IR 저장소로 교체하는 것

즉, 본 문서는 `실행 경로 분기`를 정의하는 SPEC이며, `저장 스키마 독립화` SPEC이 아니다.

---

## 5. 기본 결정

### 5.1 Selector 이름

파이프라인 이름은 아래 두 값으로 고정한다.

- `reinforced`
- `redesign`

### 5.2 기본값

selector가 생략되면 기본값은 항상 `reinforced`다.

### 5.3 외부 엔진 표기

외부 응답의 `engine` 필드는 하위 호환성을 위해 계속 `intent_proof`를 유지한다.

파이프라인 차이는 별도 필드로 드러낸다.

- `pipeline`
- `pipelineVersion`
- `requestedPipeline`
- `effectivePipeline`

### 5.4 저장소 공유

두 파이프라인은 같은 workspace와 같은 기존 테이블에 write할 수 있다.

본 SPEC은 아래 사실을 명시적으로 허용한다.

- row-level 결과는 파이프라인별로 격리되지 않는다.
- 후속 run이 이전 run의 `updatedRunId` 기준 가시성을 덮어쓸 수 있다.
- 동일 workspace에서 두 파이프라인을 연속 실행했을 때, run-level truth는 `run.stats`와 `cutoverArtifact`가 담당한다.

### 5.5 run 단위 선택

하나의 run은 정확히 하나의 pipeline만 선택한다.

둘 다 비교하려면 run을 두 번 실행해야 한다.

---

## 6. 용어

### 6.1 Shared Envelope

모든 pipeline이 공통으로 사용하는 실행 외피.

포함 책임:

- run claim
- source resolve
- workspace/source 상태 전이
- warning/error 누적
- cancel check
- run event 기록
- proof summary build
- cutover artifact build
- final stats 저장

### 6.2 Pipeline Body

shared envelope 안에서 실제 추론 로직을 수행하는 전략 구현.

### 6.3 Reinforced Pipeline

현재 proof-engine-first 구조를 유지하되, 93~98번 coverage 보강을 통합하는 경로.

### 6.4 Redesign Pipeline

새로운 Evidence IR 중심 경로. 입력 보존과 frontier 보존을 우선하고, 기존 proof/candidate 저장 계약으로 최종 materialize한다.

### 6.5 Effective Pipeline

요청값 정규화와 기능 제약을 거친 실제 실행 pipeline.

예:

- 요청 `redesign`
- 정규화 후도 `redesign`

또는

- 요청 `redesign`, `codeEngine=regex`
- pipeline은 `redesign` 유지
- code engine은 `hybrid`로 승격

---

## 7. 공개 API 계약

## 7.1 `POST /api/inference/run`

### 7.1.1 요청 모델

기존 요청 모델에 아래 필드를 추가한다.

```json
{
  "workspaceId": "ws_123",
  "modes": ["config", "code", "db"],
  "repoRoots": ["/repo"],
  "pipeline": "reinforced",
  "codeEngine": "hybrid",
  "incremental": true,
  "compatDeterministicCandidates": false,
  "smartProof": true
}
```

추가 필드:

- `pipeline?: 'reinforced' | 'redesign'`

정규화 규칙:

1. 생략 시 `reinforced`
2. 공백/대소문자 normalize 후 비교
3. 미지원 값이면 `400 BAD_REQUEST`

### 7.1.2 응답 모델

기존 응답에 아래 필드를 추가한다.

```json
{
  "ok": true,
  "runId": "run_123",
  "engine": "intent_proof",
  "pipeline": "reinforced",
  "pipelineVersion": "reinforced-v1",
  "summary": {
    "engine": "intent_proof",
    "pipeline": "reinforced",
    "pipelineVersion": "reinforced-v1",
    "intentCount": 12
  },
  "run": {
    "stats": {
      "requestedPipeline": {
        "name": "reinforced",
        "source": "request"
      },
      "effectivePipeline": {
        "name": "reinforced",
        "version": "reinforced-v1"
      }
    }
  }
}
```

추가 응답 필드:

- top-level `pipeline`
- top-level `pipelineVersion`
- `summary.pipeline`
- `summary.pipelineVersion`

### 7.1.3 호환성 규칙

- 기존 클라이언트가 `pipeline`을 보내지 않아도 동작해야 한다.
- 기존 클라이언트가 `engine === 'intent_proof'`만 확인해도 계속 동작해야 한다.
- 신규 클라이언트는 `pipeline`을 우선 사용해야 한다.

## 7.2 `POST /api/inference/runs`

`POST /api/inference/run`과 같은 selector 계약을 따른다.

추가 필드:

- `pipeline?: 'reinforced' | 'redesign'`

응답:

- `runId`
- `status`
- `requestedModes`
- `requestedPipeline`
- `effectivePipeline`는 상세 조회 또는 완료 후 summary에서 확인 가능

## 7.3 `POST /api/inference/smart`

Smart route도 동일 selector를 받는다.

규칙:

- `analysisMode`는 여전히 금지한다.
- `pipeline`만 새로 허용한다.
- Smart는 pipeline을 직접 의미하지 않는다.
- Smart는 선택된 pipeline이 만든 frontier/proof state를 후속 처리하는 계층이다.

예시:

```json
{
  "workspaceId": "ws_123",
  "repoRoots": ["/repo"],
  "pipeline": "redesign",
  "smartProof": {
    "enabled": true
  }
}
```

## 7.4 `GET /api/inference/runs` / `GET /api/inference/runs/:id`

상세/목록 응답에서 run row는 아래 정보를 포함해야 한다.

- `stats.requestedPipeline`
- `stats.effectivePipeline`
- `stats.pipelineExecution`
- `stats.proofSummary.pipeline`
- `stats.proofSummary.pipelineVersion`

목록 API는 축약 summary를 유지해도 되지만, 최소한 `requestedPipeline.name` 또는 `effectivePipeline.name`을 표시할 수 있어야 한다.

## 7.5 에러 계약

### 7.5.1 invalid pipeline

```json
{
  "error": "pipeline must be one of: reinforced, redesign"
}
```

### 7.5.2 redesign + compat deterministic

`redesign`에서 `compatDeterministicCandidates=true`는 금지한다.

이유:

- compat deterministic은 현재 reinforced 경로의 legacy sidecar 의미를 가진다.
- redesign와 함께 허용하면 selector 의미가 흐려진다.

응답:

```json
{
  "error": "compatDeterministicCandidates is only supported for pipeline=reinforced"
}
```

### 7.5.3 redesign + regex-only code engine

`redesign`는 `regex` 단독 엔진을 지원하지 않는다.

정책:

- API는 실패시키지 않는다.
- 대신 `effectiveCodeEngine='hybrid'`로 승격한다.
- warning을 남긴다.

warning 예시:

- `pipeline redesign does not support regex-only extraction; effective codeEngine upgraded to hybrid`

---

## 8. Run Stats 계약

`inference_runs.stats`는 아래 필드를 추가로 포함해야 한다.

```ts
interface RequestedPipelineStats {
  name: 'reinforced' | 'redesign';
  source: 'default' | 'request';
}

interface EffectivePipelineStats {
  name: 'reinforced' | 'redesign';
  version: string;
}

interface PipelineStageStats {
  stage: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  warningCount: number;
  errorCount: number;
  metrics: Record<string, number | string | boolean | null>;
}

interface PipelineExecutionStats {
  selectedPipeline: 'reinforced' | 'redesign';
  pipelineVersion: string;
  stageOrder: string[];
  stages: PipelineStageStats[];
}
```

필수 필드:

- `requestedPipeline`
- `effectivePipeline`
- `pipelineExecution`

기존 필드 유지:

- `requestedAgentPatches`
- `requestedSmartProof`
- `requestedCompatDeterministic`
- `proofSummary`
- `config`
- `code`
- `db`
- `bootstrap`
- `proofResolution`
- `frontierAgent`
- `summary`
- `cutoverArtifact`

---

## 9. Proof Summary 계약

`buildProofEngineSummaryForRun()`가 반환하는 summary는 아래 필드를 추가로 포함해야 한다.

```ts
interface ProofEngineSummary {
  engine: 'intent_proof';
  pipeline: 'reinforced' | 'redesign';
  pipelineVersion: string;
  intentCount: number;
  dynamicUriIntentCount: number;
  pathOnlyIntentCount: number;
  gatewayRouteSeedCount: number;
  derivedEndpointProofCount: number;
  proofClosedAtomicCount: number;
  proofFrontierCount: number;
  routeFamilyFrontierCount: number;
  proofRejectedCount: number;
  projectedCandidateCount: number;
  serviceTargetProjectionCount: number;
  agentFrontierCount: number;
  agentPatchedFrontierCount: number;
  confidenceProfileName: string | null;
  confidenceProfileVersion: string | null;
  functionSummaryExtractionBreakdown: Record<string, number>;
  frontierBreakdown: Record<string, number>;
  frontierReasonBreakdown: Record<string, number>;
  targetBreakdown: Record<string, number>;
  smartMode: SmartModeSummary;
}
```

불변식:

1. `engine`은 계속 `intent_proof`
2. `pipeline`은 반드시 존재
3. `pipelineVersion`은 반드시 존재
4. `serviceTargetProjectionCount`는 기존 proof-engine 원칙을 그대로 따른다

---

## 10. 내부 모듈 구조

권장 구조:

```text
packages/inference/src/orchestration/
  inferenceRuns.ts
  pipelines/
    types.ts
    selector.ts
    shared/
      pipelineStats.ts
      pipelineEvents.ts
      pipelineContext.ts
    reinforced/
      index.ts
      configStage.ts
      codeStage.ts
      bootstrapStage.ts
      proofStage.ts
      smartStage.ts
      compatStage.ts
    redesign/
      index.ts
      evidenceStage.ts
      bindingStage.ts
      seedStage.ts
      proofGraphStage.ts
      closureStage.ts
      projectionStage.ts
      smartInteropStage.ts
```

`inferenceRuns.ts`는 shared envelope만 담당하고, 세부 파이프라인 로직은 `pipelines/*`로 이동한다.

---

## 11. Strategy 인터페이스

```ts
export type InferencePipelineName = 'reinforced' | 'redesign';

export interface PipelineSettings {
  pipeline: InferencePipelineName;
  pipelineVersion: string;
  codeEngine: CodeSignalEngine;
  smartProof: SmartProofConfig;
  compatDeterministic: {
    enabled: boolean;
  };
}

export interface PipelineExecutionArtifacts {
  configResult: Record<string, unknown>;
  codeResult: Record<string, unknown>;
  bootstrapResult: Record<string, unknown>;
  dbResult: Record<string, unknown> | null;
  proofResolution: Record<string, unknown>;
  frontierAgent: Record<string, unknown>;
  pipelineStageStats: PipelineStageStats[];
}

export interface InferencePipelineContext {
  db: DbClient;
  workspaceId: string;
  runId: string;
  run: InferenceRunRow;
  modeSet: ReadonlySet<InferenceMode>;
  sources: LocalSource[];
  warnings: string[];
  errors: Array<{ mode: string; repoRoot?: string; message: string }>;
  settings: PipelineSettings;
  smartGenerateFn?: GenerateSmartResolutionFn<unknown>;
  isCanceled(): Promise<boolean>;
  appendEvent(input: PipelineEventInput): Promise<void>;
}

export interface InferencePipelineStrategy {
  readonly name: InferencePipelineName;
  readonly version: string;
  execute(ctx: InferencePipelineContext): Promise<PipelineExecutionArtifacts>;
}
```

핵심 원칙:

- shared envelope는 strategy 내부 구현을 몰라야 한다.
- strategy는 shared envelope가 제공하는 취소 체크, event append, warning/error 버퍼만 사용해야 한다.
- strategy는 최종 run finalize를 직접 수행하지 않는다.

---

## 12. Shared Envelope 책임

`executeInferenceRun()`는 아래 순서를 강제해야 한다.

1. run row 조회
2. claim (`QUEUED -> RUNNING`)
3. source row 조회
4. source resolve
5. requested pipeline 정규화
6. effective settings 계산
7. `PIPELINE_SELECTED` 이벤트 기록
8. pipeline strategy 실행
9. proof summary 생성
10. cutover artifact 생성
11. final stats 저장
12. source status flush
13. detail 응답 반환

shared envelope는 아래 로직을 계속 소유한다.

- `resolveRunnableSources`
- `flushSourceStatuses`
- `returnCurrentRunDetail`
- `buildProofEngineSummaryForRun`
- `buildIntentProofCutoverArtifact`

---

## 13. Reinforced Pipeline 상세 계약

## 13.1 목적

기존 proof-engine-first 구조를 유지하면서, signal coverage program(93~98)의 보강을 현재 제품 경로에 반영한다.

## 13.2 stage 순서

```text
reinforced
1. config_extraction
2. code_extraction
3. bootstrap_atomic
4. proof_resolution
5. smart_resolution
6. compat_deterministic (optional)
```

## 13.3 Stage 계약

### 13.3.1 `config_extraction`

입력:

- local source repo root
- `modes`에 `config` 포함 여부

수행:

- config alias binding 추출
- route transform 추출
- config route intent 추출
- config file count 집계

기존 구현 매핑:

- `extractAliasBindingsFromConfig`
- `extractRouteTransformsFromConfig`
- `extractInteractionIntentsFromConfigRoutes`

출력 메트릭:

- `repoCount`
- `fileCount`
- `processedFileCount`
- `skippedFileCount`
- `aliasBindingCount`
- `routeTransformCount`
- `interactionIntentCount`
- `gatewayRouteSeedCount`

### 13.3.2 `code_extraction`

입력:

- local source repo root
- normalized `codeEngine`

수행:

- `extractCodeSignalsWithEngine`
- `extractFunctionSummariesFromCodeSignals`
- `extractAliasBindingsFromCodeSignals`
- `extractInteractionIntentsFromCodeSignals`

추가 강화 의무:

- 93: partial HTTP metadata 보존
- 94: framework-specific scanner/plugin 적용
- 95: parser hook + parser registry 적용
- 96: config-code binding completeness를 위한 hint 보존
- 97: module boundary calibration 반영
- 98: hybrid 기본 정책 유지

출력 메트릭:

- `repoCount`
- `fileCount`
- `artifactCount`
- `signalCount`
- `skippedCount`
- `aliasBindingCount`
- `functionSummaryCount`
- `interactionIntentCount`
- `enginesUsed`
- `fallbackCount`
- `scanFailures`

### 13.3.3 `bootstrap_atomic`

수행:

- `runCommonBootstrapForRepo(..., skipExtraction=true, bootstrapOnly=true)`

역할:

- endpoint/topic/queue/database/db_table bootstrap
- proof resolution이 사용할 원자 object index 보강

출력 메트릭:

- `analyzedRepoCount`
- `signalCount`
- `candidateCount`
- `createdEndpointCount`
- `createdTopicCount`
- `createdQueueCount`
- `createdDatabaseCount`
- `createdDbTableCount`
- `createdAtomicCount`

### 13.3.4 `proof_resolution`

수행:

- impacted intent 식별
- `buildIntentProofResolverContext`
- `resolveInteractionIntentProof`

불변식:

- 닫히지 않은 proof는 candidate를 만들지 않는다.
- service fallback candidate는 만들지 않는다.
- `interactionIntents.updatedRunId`는 현재 run으로 업데이트된다.

출력 메트릭:

- `intentCount`
- `closedAtomicCount`
- `frontierCount`
- `rejectedCount`

### 13.3.5 `smart_resolution`

수행:

- 현행 smart proof category 실행
- frontier / ambiguity / contradiction / correlation 보강

규칙:

- Smart는 pipeline selector를 대체하지 않는다.
- Smart는 reinforced pipeline의 후속 단계다.

### 13.3.6 `compat_deterministic`

수행 조건:

- `compatDeterministicCandidates=true`

수행:

- `inferRelationsFromConfig`
- `inferRelationsFromCodeSignals`
- `bindConfigToCodeEndpoints`

규칙:

- reinforced에서만 허용한다.
- summary에 proof/compat를 분리 집계한다.

---

## 14. Redesign Pipeline 상세 계약

## 14.1 목적

partial signal을 frontier 이전에 버리지 않고 보존하기 위해, `Evidence IR -> Intent Seed IR -> Proof IR -> Projection` 구조를 사용한다.

## 14.2 stage 순서

```text
redesign
1. evidence_intake
2. binding_synthesis
3. seed_materialization
4. proof_graph_build
5. atomic_closure
6. projection
7. smart_interop
```

## 14.3 핵심 원칙

- path-only / host-only / config-backed / dynamic-uri evidence를 1급 상태로 취급한다.
- route-family는 child proof derivation 전용으로 유지한다.
- proof를 닫기 전에는 candidate를 만들지 않는다.
- 최종 출력은 현재 저장 계약에 맞게 materialize한다.

## 14.4 IR 계약

### 14.4.1 `EvidenceIR`

```ts
interface EvidenceIR {
  id: string;
  transport: 'http' | 'db' | 'message';
  sourceKind: 'code' | 'config' | 'db';
  sourceServiceId: string;
  sourceFunctionId?: string | null;
  sourceFilePath?: string | null;
  methodHint?: string | null;
  pathHint?: string | null;
  hostHint?: string | null;
  configKeys: string[];
  routeHints: string[];
  aliasHints: string[];
  dynamicHost: boolean;
  dynamicPath: boolean;
  gatewayKind?: string | null;
  boundaryContext?: {
    moduleBoundaryScore: number;
    candidateOwnerServices: string[];
  } | null;
  evidenceRefs: string[];
}
```

요구사항:

- partial field가 비어 있어도 evidence 자체를 버리지 않는다.
- `dynamicHost`, `dynamicPath`는 boolean으로 명시한다.
- framework/plugin parser에서 얻은 보조 힌트도 evidence에 흡수한다.

### 14.4.2 `BindingIR`

```ts
interface BindingIR {
  aliasKey: string;
  aliasValue?: string | null;
  resolvedHost?: string | null;
  resolvedServiceId?: string | null;
  confidence: number;
  sourceEvidenceIds: string[];
}
```

역할:

- config/annotation/property/parser/plugin에서 얻은 binding을 하나의 계층으로 통합한다.

### 14.4.3 `IntentSeedIR`

```ts
interface IntentSeedIR {
  id: string;
  intentType: 'http_call' | 'http_gateway_route' | 'db_access' | 'message_publish' | 'message_consume';
  sourceServiceId: string;
  sourceFunctionId?: string | null;
  methodHint?: string | null;
  externalPathHint?: string | null;
  hostHint?: string | null;
  configKeys: string[];
  bindingRefs: string[];
  routeTransformRefs: string[];
  sourceEvidenceIds: string[];
}
```

### 14.4.4 `ProofIR`

```ts
interface ProofIR {
  id: string;
  intentSeedId: string;
  proofType: 'http_call' | 'http_gateway_route' | 'db_access' | 'message';
  status: 'NEW' | 'RESOLVING' | 'CLOSED_ATOMIC' | 'FRONTIER' | 'REJECTED';
  slotState: Record<string, unknown>;
  ambiguityCount: number;
  contradictionCount: number;
  targetObjectType?: string | null;
  targetObjectId?: string | null;
  routeChain: Array<Record<string, unknown>>;
  frontierReason?: string | null;
}
```

---

## 15. Redesign Stage 계약

### 15.1 `evidence_intake`

입력:

- code/config/db source

수행:

- code signal 추출 결과와 config parser 결과를 `EvidenceIR`로 정규화
- partial signal을 skip하지 않고 저장
- DB schema signal도 transport 별 evidence로 흡수

출력 메트릭:

- `evidenceCount`
- `httpEvidenceCount`
- `partialHttpEvidenceCount`
- `dynamicUriEvidenceCount`
- `configEvidenceCount`
- `dbEvidenceCount`

### 15.2 `binding_synthesis`

수행:

- alias binding
- property alias
- service discovery binding
- gateway target binding

를 하나의 `BindingIR` 계층으로 통합한다.

출력 메트릭:

- `bindingCount`
- `resolvedBindingCount`
- `unresolvedBindingCount`

### 15.3 `seed_materialization`

수행:

- `EvidenceIR + BindingIR`에서 `IntentSeedIR` 생성
- route-family seed와 direct call seed를 분리
- path-only / host-only seed도 버리지 않음

출력 메트릭:

- `intentSeedCount`
- `httpCallSeedCount`
- `gatewayRouteSeedCount`
- `pathOnlySeedCount`
- `dynamicHostSeedCount`

### 15.4 `proof_graph_build`

수행:

- `IntentSeedIR`에서 `ProofIR` 생성
- root proof 및 child proof graph 구성
- route-family child proof derivation

규칙:

- route-family root는 직접 projection 금지
- child proof만 atomic target candidate 생성 가능

출력 메트릭:

- `proofNodeCount`
- `childProofCount`
- `routeFamilyProofCount`

### 15.5 `atomic_closure`

수행:

- provider/service/endpoint/table/topic/queue를 deterministic closure
- ambiguity/contradiction 처리
- 닫히지 않으면 frontier 유지

규칙:

- path-only unique match는 endpoint family narrowing 규칙을 거쳐야 한다.
- service-level fallback projection 금지

출력 메트릭:

- `closedAtomicCount`
- `frontierCount`
- `rejectedCount`
- `derivedEndpointProofCount`

### 15.6 `projection`

수행:

- `interaction_intents`
- `function_summaries`
- `alias_bindings`
- `route_transforms`
- `proof_states`
- `proof_frontiers`
- `relation_candidates`

에 현재 제품 계약에 맞게 materialize한다.

규칙:

- 새 테이블은 도입하지 않는다.
- run-level 비교 truth는 `run.stats`와 `cutoverArtifact`가 담당한다.

### 15.7 `smart_interop`

redesign도 Smart를 사용할 수 있어야 한다.

초기 버전 계약:

- redesign는 proof/frontier를 현재 테이블에 materialize한 후 Smart를 실행한다.
- frontier reason은 가능한 기존 taxonomy로 매핑한다.
- 신규 reason 도입은 본 SPEC 범위에서 허용하지 않는다.

즉, redesign v1은 Smart 계층과의 상호 운용을 위해 기존 frontier taxonomy를 재사용해야 한다.

---

## 16. Shared 저장 계약

본 SPEC은 저장소 공유를 허용한다.

운영 의미:

- 같은 workspace에서 두 pipeline을 번갈아 실행할 수 있다.
- row-level 결과가 섞여도 허용한다.
- per-run 비교는 `cutoverArtifact`와 `run.stats`로 수행한다.

필수 규칙:

1. 한 run의 최종 판단은 해당 run의 `proofSummary`와 `cutoverArtifact`를 기준으로 한다.
2. row-level 테이블의 현재 상태를 “pipeline별 분리 결과”로 해석하면 안 된다.
3. 같은 workspace에 대한 동시 다중 run은 기존 동작을 유지하되, 운영상 serialized execution을 권장한다.

---

## 17. Cutover / 비교 계약

cutover artifact는 selector와 무관하게 계속 생성한다.

추가 요구사항:

- artifact metadata에 `pipeline`을 포함해야 한다.
- artifact label은 `run:${runId}`를 유지한다.
- baseline/candidate 비교는 두 run의 stored artifact를 사용한다.

예시:

```json
{
  "label": "run:abc",
  "pipeline": "redesign",
  "pipelineVersion": "redesign-v1"
}
```

의미:

- redesign run이 이후 reinforced run에 의해 row-level 상태가 덮여도, redesign run의 artifact는 run stats에 고정 보존된다.

---

## 18. Event 계약

신규 event type:

- `PIPELINE_SELECTED`
- `PIPELINE_STAGE_STARTED`
- `PIPELINE_STAGE_COMPLETED`
- `PIPELINE_STAGE_FAILED`
- `PIPELINE_STAGE_SKIPPED`

### 18.1 `PIPELINE_SELECTED`

payload:

- `requestedPipeline`
- `effectivePipeline`
- `pipelineVersion`
- `requestedCodeEngine`
- `effectiveCodeEngine`

### 18.2 stage events

payload:

- `pipeline`
- `pipelineVersion`
- `stage`
- `durationMs`
- `metrics`
- `warningCount`
- `errorCount`

---

## 19. 구현 단계

## 19.1 Phase 1 — selector skeleton

목표:

- API에 `pipeline` 추가
- run stats에 `requestedPipeline` / `effectivePipeline` 추가
- `executeInferenceRun()`를 strategy dispatch 구조로 정리
- 기본 pipeline은 `reinforced`

수용 기준:

- selector 없이 기존 테스트가 그대로 통과
- `pipeline=reinforced` 명시와 생략 결과가 동일

## 19.2 Phase 2 — reinforced extraction hardening

목표:

- 93~98 보강안이 reinforced pipeline의 공식 동작이 되도록 통합

## 19.3 Phase 3 — redesign deterministic core

목표:

- `EvidenceIR`
- `BindingIR`
- `IntentSeedIR`
- `ProofIR`

를 도입하고, current proof/candidate 저장 모델로 materialize

## 19.4 Phase 4 — smart interop and cutover

목표:

- redesign frontier를 current Smart 계층에 연결
- representative fixture 기준 cutover 비교 가능하게 함

---

## 20. 테스트 요구사항

## 20.1 단위 테스트

- pipeline selector normalize
- invalid pipeline 거부
- redesign + compat deterministic 거부
- redesign + regex 요청 시 hybrid 승격
- strategy registry dispatch
- proof summary에 `pipeline` / `pipelineVersion` 반영

## 20.2 통합 테스트

- quick run에서 `pipeline=reinforced`
- quick run에서 `pipeline=redesign`
- async run에서 `requestedPipeline` / `effectivePipeline` 저장
- smart run에서 selector 전달
- cutover artifact에 pipeline 정보 반영
- 같은 workspace에서 sequential reinforced -> redesign 실행 후 두 run의 artifact 비교 가능

## 20.3 회귀 테스트

- selector 생략 시 기존 `intent_proof` 경로와 동일 결과
- reinforced pipeline은 기존 tests를 가능한 한 그대로 통과해야 함
- approval UI가 `engine: intent_proof` 전제만으로 깨지지 않아야 함

## 20.4 fixture 테스트

- 대표 fixture에서 reinforced / redesign 둘 다 `SUCCEEDED`
- redesign가 partial HTTP evidence를 frontier 또는 closed proof로 보존
- redesign가 service fallback candidate를 만들지 않음

---

## 21. 수용 기준

1. `POST /api/inference/run`, `POST /api/inference/runs`, `POST /api/inference/smart`가 `pipeline` selector를 받는다.
2. selector 생략 시 `reinforced`가 기본값이다.
3. run stats에 `requestedPipeline`, `effectivePipeline`, `pipelineExecution`이 저장된다.
4. proof summary에 `pipeline`, `pipelineVersion`이 포함된다.
5. `engine` 필드는 계속 `intent_proof`를 유지한다.
6. reinforced pipeline은 현재 proof-engine-first 커널을 유지한다.
7. redesign pipeline은 별도 전략 구현으로 분기된다.
8. redesign pipeline도 현재 저장 계약(`interaction_intents`, `proof_states`, `relation_candidates`)으로 materialize할 수 있다.
9. redesign는 `regex` 단독 요청을 허용하지 않고 `hybrid`로 승격한다.
10. redesign는 `compatDeterministicCandidates=true`를 거부한다.
11. cutover artifact는 두 pipeline 모두에서 생성된다.
12. row-level 저장 결과가 pipeline별로 섞일 수 있다는 사실이 문서에 명시된다.
13. per-run 비교 truth는 `run.stats`와 `cutoverArtifact`를 기준으로 한다.
14. selector 추가 후 기존 클라이언트가 깨지지 않는다.

---

## 22. 오픈 이슈

1. `/api/scan`에도 selector를 노출할지 여부
2. redesign에서 current frontier taxonomy만으로 충분한지 여부
3. redesign 전용 메트릭을 approval/debug UI에 어디까지 노출할지 여부
4. 같은 workspace 동시 실행을 나중에 금지할지 여부

초기 구현에서는 위 항목을 미해결 상태로 두되, selector와 shared envelope 분리가 먼저 완료되어야 한다.
