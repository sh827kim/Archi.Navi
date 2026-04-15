# 13. Smart Proof Engine Escalation

상태: Current
상위 문서:
- [09-intent-centric-proof-engine-overview.md](./09-intent-centric-proof-engine-overview.md)
- [11-intent-centric-proof-engine-resolution-pipeline.md](./11-intent-centric-proof-engine-resolution-pipeline.md)
관련 SPEC:
- [53-smart-proof-engine-escalation-spec.md](../spec/53-smart-proof-engine-escalation-spec.md)
작성일: 2026-04-05

---

## 1. 문서 목적

이 문서는 Intent-Centric Proof Engine 위에 동작하는 **Smart Proof Engine**의 기술 설계를 정의한다.

제품 계약과 수용 기준은 [53-smart-proof-engine-escalation-spec.md](../spec/53-smart-proof-engine-escalation-spec.md)를 따른다.
이 문서는 그 SPEC을 만족하기 위한 구현 수준의 아키텍처, 프롬프트 설계, 데이터 모델, 오케스트레이션 흐름을 다룬다.

핵심 목표는 하나다.

> **결정론적 proof engine을 유지한 채, frontier-local LLM escalation으로 unresolved proof를 atomic closure에 더 가깝게 밀어 넣는다.**

---

## 2. 배경

현재 proof engine은 deterministic-first 구조로 동작한다. `frontierAgent.ts` 기반의 결정론적 frontier 처리와, `smartGenerateFn`을 통한 선택적 LLM escalation 경로가 함께 존재한다. 다만 환경/예산/검증 제약 때문에 모든 frontier가 Smart 경로를 기본으로 타는 상태는 아니며, 문서의 나머지 범위는 그 확장 기준을 정의한다.

---

## 3. 범위

### 3.1 포함

- deterministic proof engine 이후의 선택적 Smart escalation
- frontier-local structured patch proposal (LLM → Patch → Validator → Re-run)
- 5개 LLM 개입 카테고리(A~E)의 프롬프트 설계와 구조화 출력 스키마
- Budget tracker, audit log, 메트릭 수집
- 수락 흐름(confidence gating, review, skip)

### 3.2 제외

- pair-first Smart pipeline의 재도입
- relation candidate 직접 생성 (LLM이 candidate를 직접 upsert하지 않는다)
- proof validator 우회 (LLM 제안도 반드시 deterministic validator를 통과해야 한다)
- repo 전체를 무제한 탐색하는 자율 에이전트
- approval/reject 판정 대체 (LLM은 판사가 아닌 제안자)
- 승인 없는 자동 relation promotion

---

## 4. 기존 Smart 문서와의 관계

pair-first Smart 3-Phase 문서와 코드는 제거되었다.
현재 구현과 향후 확장 기준은 이 문서와 [53-smart-proof-engine-escalation-spec.md](../spec/53-smart-proof-engine-escalation-spec.md)를 우선 참조한다.

---

## 5. Mode 아키텍처

### 5.1 핵심 원칙

```
Static Mode:  Intent → [결정론적 8단계 파이프라인] → [결정론적 Agent] → 결과
Smart Mode:   Intent → [결정론적 8단계 파이프라인] → [결정론적 Agent] → [LLM 개입 5단계] → 결과
```

- **결정론적 파이프라인은 항상 먼저 실행** — Smart 모드도 동일한 파이프라인을 거침
- **LLM은 결정론적 엔진이 실패한 지점에서만 개입** — 대체가 아닌 보완
- **LLM 제안도 기존 `validateAndApplyProofPatch()` 검증을 통과해야 함** — LLM은 판사가 아닌 제안자

### 5.2 모드 설정

```typescript
// packages/inference/src/orchestration/types.ts

interface SmartProofConfig {
  enabled: boolean;

  // LLM 개입 카테고리 ON/OFF
  categories: {
    preResolutionEnhancement: boolean;   // Category A: summary 보강
    frontierResolution: boolean;         // Category B: frontier 해소
    ambiguityResolution: boolean;        // Category C: 후보 순위화
    crossProofCorrelation: boolean;      // Category D: 교차 추론
    contradictionDetection: boolean;     // Category E: 오류 탐지
  };

  // 비용 제어
  budget: {
    maxLlmCallsPerRun: number;           // 기본 100
    maxLlmCallsPerIntent: number;        // 기본 5
    maxInputTokensPerCall: number;       // 기본 4000
    maxTotalTokensPerRun: number;        // 기본 500_000
  };

  // 수락 임계치
  thresholds: {
    autoAcceptConfidence: number;        // 기본 0.80 — 이상이면 자동 수락
    reviewConfidence: number;            // 기본 0.50 — 이상이면 PENDING_REVIEW
    skipConfidence: number;              // 기본 0.30 — 미만이면 건너뜀
  };

  // LLM 모델 설정
  model?: string;                        // 기본값: provider default
  temperature?: number;                  // 기본값: 0.1
}
```

### 5.3 API 진입점

```typescript
// POST /api/inference/run
interface InferenceRunRequest {
  // ... 기존 필드
  smartProof?: SmartProofConfig | boolean; // true = default config
}
```

`smartProof: true`이면 기본 config로 Smart 모드 활성화. `false` 또는 생략이면 Static 모드.

`POST /api/inference/smart`는 thin wrapper로 유지하며, 내부적으로 `run + smartProof` 계약으로 수렴한다. legacy `analysisMode` 같은 pair-first Smart 입력은 더 이상 제품 계약으로 유지하지 않는다.

---

## 6. LLM 개입 5단계 (Categories A~E)

### 6.1 실행 순서

```
[결정론적 파이프라인 완료]
    ↓
[Category A] Pre-Resolution Enhancement (선택적)
  - dynamicPath/dynamicHost 플래그가 있는 function summary를 LLM으로 보강
  - 보강된 summary로 해당 intent만 재실행
    ↓
[Category B] Frontier Resolution (핵심)
  - FRONTIER 상태 proof를 LLM이 해소 시도
  - frontier reason별 특화 프롬프트
  - 해소된 proof → CLOSED_ATOMIC
    ↓
[Category C] Ambiguity Resolution (Category B 실패 시)
  - 여전히 FRONTIER인 ambiguity 케이스
  - LLM이 후보 순위를 매겨 top-1 선택
  - top-1 선택 근거와 대안 ranking을 함께 남겨야 한다
    ↓
[Category D] Cross-Proof Correlation (배치)
  - 같은 패턴의 frontier를 묶어서 한 번에 해소
  - batch 결과도 proof별 patch로 환원 가능해야 한다
    ↓
[Category E] Contradiction Detection (검증)
  - CLOSED_ATOMIC proof 중 저신뢰도를 LLM이 검증
  - proof를 직접 reject하지 않고 CHALLENGE를 제안한다
  - challenge 이후 상태 전이는 deterministic 규칙에 따라 수행한다
```

### 6.2 Category별 지원 범위

| Category | 1차 구현 | 후속 확장 |
|---|---|---|
| A | `legacy_edges_fallback` + dynamicPath/dynamicHost/truncated | AST/HYBRID primary signal 품질 기준선 달성 후 확대 |
| B | HOST_ALIAS_UNRESOLVED, CONFIG_BINDING_MISSING, ENDPOINT_MATCH_AMBIGUOUS, METHOD_UNKNOWN | PATH_TEMPLATE_UNKNOWN, ROUTE_FAMILY_DERIVATION_EMPTY, DB_TABLE_UNRESOLVED 등 |
| C | deterministic unique match 실패 케이스 | - |
| D | 동일 서비스/동일 frontier reason 그룹 | 서비스 간 패턴 |
| E | confidence < 0.65인 CLOSED_ATOMIC | - |

---

## 7. Category B: Frontier Resolution (핵심 설계)

### 7.1 아키텍처

```typescript
// packages/inference/src/agent/smartFrontierResolver.ts

interface SmartFrontierResolverInput {
  workspaceId: string;
  proofStateId: string;
  runId: string;
  config: SmartProofConfig;
}

interface SmartFrontierResolution {
  proofStateId: string;
  frontierReason: string;
  resolved: boolean;
  patch: ProofPatch | null;
  llmCallId: string;               // audit 추적용
  confidence: number;
  reasoning: string;
  tokensUsed: { input: number; output: number };
}

// frontier reason → resolver 매핑
const SMART_FRONTIER_RESOLVERS: Record<string, SmartFrontierResolverFn> = {
  HOST_ALIAS_UNRESOLVED: resolveHostAliasByLlm,
  CONFIG_BINDING_MISSING: resolveConfigBindingByLlm,
  ENDPOINT_MATCH_AMBIGUOUS: resolveEndpointAmbiguityByLlm,
  METHOD_UNKNOWN: resolveMethodByLlm,
  PATH_TEMPLATE_UNKNOWN: resolvePathTemplateByLlm,
  ROUTE_FAMILY_DERIVATION_EMPTY: resolveRouteFamilyByLlm,
  ROUTE_TO_ENDPOINT_COMPOSITION_FAILED: resolveRouteCompositionByLlm,
  DB_TABLE_UNRESOLVED: resolveDbTableByLlm,
  DB_SCHEMA_AMBIGUOUS: resolveDbSchemaByLlm,
  MESSAGE_TARGET_UNRESOLVED: resolveMessageTargetByLlm,
  PROVIDER_SERVICE_AMBIGUOUS: resolveProviderAmbiguityByLlm,
  PATH_REWRITE_CONFLICT: resolvePathRewriteByLlm,
};
```

### 7.2 컨텍스트 조립 전략

LLM에게 보내는 컨텍스트는 frontier reason에 따라 다르다:

```typescript
interface FrontierResolutionContext {
  // 항상 포함
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

  // frontier reason에 따라 선택적 포함
  functionSummary?: {               // 소스 함수 요약
    kind: string;
    outbound: Record<string, unknown>;
    flags: Record<string, boolean>;
  };
  codeSnippet?: string;             // 소스 함수 코드 (최대 80줄)
  availableServices?: Array<{       // 워크스페이스 서비스 목록
    id: string;
    name: string;
    endpointCount: number;
  }>;
  candidateEndpoints?: Array<{      // 매칭 후보 엔드포인트
    id: string;
    method: string;
    path: string;
    serviceName: string;
  }>;
  aliasBindings?: Array<{           // 관련 alias
    key: string;
    value: string;
    resolvedService: string | null;
  }>;
  routeTransforms?: Array<{         // 관련 route transform
    matchPath: string;
    targetService: string | null;
    rewriteRule: string | null;
  }>;
  relatedProofs?: Array<{           // 같은 서비스의 다른 proof 결과 (Category D 힌트)
    intentType: string;
    status: string;
    resolvedService: string | null;
    resolvedEndpoint: string | null;
  }>;
}
```

### 7.3 Frontier별 프롬프트 설계

#### HOST_ALIAS_UNRESOLVED / CONFIG_BINDING_MISSING

```typescript
function buildHostAliasResolutionPrompt(ctx: FrontierResolutionContext): string {
  return `You are resolving a microservice dependency. A service is making an HTTP call but we cannot determine which target service it's calling.

## Source Context
- Source service: ${ctx.intent.sourceService}
- Config keys used: ${ctx.intent.configKeys.join(', ')}
- Host hint from code: ${ctx.intent.hostHint ?? 'none'}
- HTTP method: ${ctx.intent.methodHint ?? 'unknown'}
- Path hint: ${ctx.intent.pathHint ?? 'unknown'}

## Function Summary
${JSON.stringify(ctx.functionSummary?.outbound, null, 2)}

## Source Code (relevant section)
\`\`\`
${ctx.codeSnippet ?? 'not available'}
\`\`\`

## Available Services in Workspace
${ctx.availableServices?.map(s =>
  `- ${s.name} (${s.endpointCount} endpoints)`
).join('\n')}

## Existing Alias Bindings
${ctx.aliasBindings?.map(a =>
  `- ${a.key} = ${a.value} → ${a.resolvedService ?? 'unresolved'}`
).join('\n') ?? 'none'}

## Other Resolved Proofs from Same Source Service
${ctx.relatedProofs?.filter(p => p.status === 'CLOSED_ATOMIC').map(p =>
  `- ${p.intentType}: → ${p.resolvedService} ${p.resolvedEndpoint}`
).join('\n') ?? 'none'}

## Task
Determine which service this HTTP call targets. Consider:
1. Config key naming conventions (e.g., "auth.base-url" likely points to auth service)
2. Host hint patterns (e.g., "lb://order-service" is service discovery)
3. Code imports and class names
4. Other resolved calls from the same service
5. Service name similarity to hints

If you cannot determine with reasonable confidence, say so.`;
}
```

**구조화된 출력 스키마:**

```typescript
const HostAliasResolutionSchema = z.object({
  resolved: z.boolean(),
  selectedServiceId: z.string().nullable(),
  selectedServiceName: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  aliasBinding: z.object({
    aliasKey: z.string(),
    aliasValue: z.string(),
    bindingKind: z.enum(['base_url', 'service_discovery', 'gateway_target', 'property_alias']),
  }).nullable(),
});
```

#### ENDPOINT_MATCH_AMBIGUOUS

```typescript
function buildEndpointDisambiguationPrompt(ctx: FrontierResolutionContext): string {
  return `You are disambiguating API endpoint matching. Multiple endpoints match the same HTTP call pattern.

## Call Context
- Method: ${ctx.proofState.currentSlots['methodResolved']}
- Resolved internal path: ${ctx.proofState.currentSlots['internalPathResolved']}
- Provider service: ${ctx.proofState.currentSlots['providerServiceId']}

## Source Function
${ctx.codeSnippet ?? 'not available'}

## Candidate Endpoints (all match the normalized path pattern)
${ctx.candidateEndpoints?.map((ep, i) =>
  `${i + 1}. [${ep.id}] ${ep.method} ${ep.path}`
).join('\n')}

## Task
Select the single most likely endpoint. Consider:
1. Parameter naming: source code uses "${extractParamName(ctx)}" — which endpoint parameter name matches?
2. Function semantics: function name "${extractFunctionName(ctx)}" suggests specific operation
3. REST conventions: standard CRUD mapping
4. If endpoints differ only in parameter name ({id} vs {userId}), prefer the one matching source code variable names

If genuinely ambiguous (e.g., different operations at same path), explain why.`;
}
```

**구조화된 출력:**

```typescript
const EndpointDisambiguationSchema = z.object({
  selectedEndpointId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  alternativeRanking: z.array(z.object({
    endpointId: z.string(),
    score: z.number(),
  })).optional(),
});
```

#### METHOD_UNKNOWN

```typescript
function buildMethodInferencePrompt(ctx: FrontierResolutionContext): string {
  return `You are inferring the HTTP method of a service call from code context.

## Source Function
\`\`\`
${ctx.codeSnippet ?? 'not available'}
\`\`\`

## Function Summary
- Function name: ${extractFunctionName(ctx)}
- Known path: ${ctx.intent.pathHint ?? 'unknown'}
- Summary flags: ${JSON.stringify(ctx.functionSummary?.flags)}

## Available Endpoints on Target Service
${ctx.candidateEndpoints?.map(ep =>
  `- ${ep.method} ${ep.path}`
).join('\n') ?? 'unknown'}

## Task
Infer the HTTP method. Consider:
1. Function name semantics: get/fetch→GET, create/post→POST, update/put→PUT, delete/remove→DELETE
2. HTTP client method: httpClient.get() / .post() / .put() / .delete()
3. Request body presence: body parameter → POST/PUT/PATCH
4. Return type: list/collection → likely GET
5. Available endpoints: which methods are actually exposed at the target path?`;
}
```

#### DB_TABLE_UNRESOLVED / DB_SCHEMA_AMBIGUOUS

```typescript
function buildDbTableResolutionPrompt(ctx: FrontierResolutionContext): string {
  return `You are resolving a database table reference from application code.

## Source Context
- Service: ${ctx.intent.sourceService}
- Resource hint: ${ctx.proofState.currentSlots['resourceHint']}
- Action: ${ctx.proofState.currentSlots['actionHint'] ?? 'unknown'}

## Code Snippet
\`\`\`
${ctx.codeSnippet ?? 'not available'}
\`\`\`

## Available Tables in Workspace
${ctx.availableTables?.map(t =>
  `- ${t.schema}.${t.name} (database: ${t.database})`
).join('\n')}

## Task
Determine which database table this code accesses. Consider:
1. ORM entity mapping: @Entity("users") / @Table(name="orders")
2. Repository naming: UserRepository → "users" table
3. SQL string literals: "SELECT * FROM orders WHERE..."
4. Service domain: order-service likely accesses "orders" table
5. If schema ambiguous (same table name in multiple schemas), determine correct schema`;
}
```

### 7.4 LLM 호출 → Patch 변환

```typescript
// packages/inference/src/agent/smartFrontierResolver.ts

async function resolveHostAliasByLlm(
  db: DbClient,
  generateFn: GenerateSmartResolutionFn,
  ctx: FrontierResolutionContext,
  config: SmartProofConfig,
): Promise<SmartFrontierResolution> {
  const prompt = buildHostAliasResolutionPrompt(ctx);
  const result = await generateFn(prompt, HostAliasResolutionSchema);

  if (!result.resolved || !result.selectedServiceId) {
    return { resolved: false, patch: null, confidence: result.confidence, ... };
  }

  if (result.confidence < config.thresholds.skipConfidence) {
    return { resolved: false, patch: null, confidence: result.confidence, ... };
  }

  // LLM 결과를 기존 proof patch 형식으로 변환
  const patch = {
    patchType: 'alias_binding' as const,
    payload: {
      ownerServiceId: ctx.intent.sourceServiceId,
      bindingKind: result.aliasBinding?.bindingKind ?? 'property_alias',
      aliasKey: result.aliasBinding?.aliasKey ?? ctx.intent.configKeys[0],
      aliasValue: result.aliasBinding?.aliasValue ?? ctx.intent.hostHint,
      resolvedServiceId: result.selectedServiceId,
      confidence: result.confidence,
      evidenceIds: [`smart-agent:${ctx.proofState.frontierReason}`],
    },
    sourceKind: 'smart_agent' as const,
  };

  return {
    resolved: true,
    patch,
    confidence: result.confidence,
    reasoning: result.reasoning,
    ...
  };
}
```

---

## 8. Category A: Pre-Resolution Enhancement

### 8.1 Function Summary LLM 보강

결정론적 파이프라인 실행 **전에** summary 품질을 올린다.

```typescript
// packages/inference/src/agent/smartSummaryEnhancer.ts

interface SummaryEnhancementInput {
  workspaceId: string;
  functionId: string;
  existingSummary: FunctionSummary;
  codeSnippet: string;           // 소스 코드 (최대 120줄)
  serviceContext: {
    serviceName: string;
    knownEndpoints: string[];    // 같은 서비스의 알려진 엔드포인트
    knownDependencies: string[]; // 이미 해소된 의존성
  };
}

// 대상: dynamicPath=true, dynamicHost=true, truncated=true인 summary만
async function enhanceFunctionSummary(
  generateFn: GenerateSmartResolutionFn,
  input: SummaryEnhancementInput,
): Promise<EnhancedSummary | null> {
  // LLM이 코드를 분석하여 누락된 정보 추론
  // - dynamicPath → 실제 path template 추론
  // - dynamicHost → 실제 target service 추론
  // - truncated → 전체 컨텍스트에서 핵심 정보 추출
}
```

**프롬프트:**
```
You are analyzing a function's outbound HTTP/DB/Message calls.
The static analyzer flagged this function as having dynamic paths that couldn't be resolved.

## Source Code
```{code}```

## Current Deterministic Summary
{existingSummary}

## Task
Extract the actual outbound call details:
1. HTTP method (GET/POST/PUT/DELETE)
2. URL path template (e.g., /api/users/{id})
3. Target service/host
4. Any config keys used for base URL

Focus on what the code ACTUALLY does, not what it might do.
```

### 8.2 적용 조건

```typescript
// smart mode에서만, 다음 조건의 summary만 보강:
const needsEnhancement = (summary: FunctionSummary) =>
  summary.extractionStrategy === 'legacy_edges_fallback'
  && (
    summary.flags?.dynamicPath === true
    || summary.flags?.dynamicHost === true
    || summary.flags?.truncated === true
  )
  && summary.summaryCompleteness < 0.6;
```

주의: AST/HYBRID primary signal 품질이 기준선에 도달하기 전에는 기본 활성화하지 않는다.

---

## 9. Category D: Cross-Proof Correlation

### 9.1 배치 패턴 인식

같은 서비스에서 반복되는 패턴을 한 번에 해소한다.

```typescript
// 예: order-service의 5개 함수가 모두 HOST_ALIAS_UNRESOLVED
// → "이 서비스는 payment-service를 호출하는 패턴"
// → 5개 frontier를 한 번의 LLM 호출로 해소

interface CrossProofCorrelationInput {
  workspaceId: string;
  relatedFrontiers: Array<{
    proofStateId: string;
    frontierReason: string;
    sourceService: string;
    hostHint: string | null;
    configKeys: string[];
  }>;
  resolvedProofsInWorkspace: Array<{
    sourceService: string;
    targetService: string;
    method: string;
    path: string;
  }>;
}
```

**프롬프트:**
```
Multiple functions in the same service have unresolved host aliases.
This suggests a common dependency pattern.

## Unresolved Calls (all from {sourceService})
1. {function1}: hostHint="PAYMENT_API", configKey="payment.base-url"
2. {function2}: hostHint="PAYMENT_API", configKey="payment.base-url"
3. {function3}: hostHint="PAYMENT_SVC", configKey="payment.service.url"

## Already Resolved Calls from Same Service
- getUserOrders() → order-db (db_access, CLOSED_ATOMIC)
- notifyPayment() → payment-service (http_call, CLOSED_ATOMIC)

## Available Services
- payment-service, payment-api, payment-gateway

## Task
Are these unresolved calls all targeting the same service?
If so, which one? This would resolve all 3 frontiers at once.
```

조건:

- 개별 frontier보다 강한 공통 패턴 증거가 있어야 한다
- batch 결과도 proof별 patch로 환원 가능해야 한다

---

## 10. Category E: Contradiction Detection

### 10.1 저신뢰도 proof 검증

```typescript
// CLOSED_ATOMIC이지만 confidence < 0.65인 proof를 LLM이 검증
interface ContradictionCheckInput {
  proof: {
    sourceService: string;
    targetEndpoint: string;
    relationType: string;
    confidence: number;
    confidenceBreakdown: ProofConfidenceBreakdown;
    steps: ProofStep[];
  };
  codeSnippet: string | null;
  targetEndpointDetail: {
    method: string;
    path: string;
    serviceName: string;
  };
}

// 출력
const ContradictionCheckSchema = z.object({
  verdict: z.enum(['CONFIRM', 'CHALLENGE']),
  confidence: z.number(),
  reasoning: z.string(),
  challengeReason: z.string().nullable(),
});
```

조건:

- proof를 직접 reject하지 않고 `CHALLENGE`를 제안한다
- challenge 이후 상태 전이는 deterministic 규칙에 따라 수행한다

---

## 11. 수락 흐름

Smart patch의 수락 흐름:

```
LLM 제안 (confidence X)
    ↓
[1] 구조 검증 (validateProofPatchPayload) — 필수 필드 확인
    ↓
[2] 결정론적 검증 (validatePatchDeterministically) — 객체 존재, 타입 일치
    ↓
[3] Confidence 게이팅
    X >= 0.80 → 자동 수락 (ACCEPTED, sourceKind='smart_agent')
    0.50 <= X < 0.80 → PENDING_REVIEW (사람 승인 대기)
    X < 0.50 → 건너뜀 (patch 저장하지만 SKIPPED 마킹)
    ↓
[4] 수락된 patch → proof 재실행 (resolveInteractionIntentProof)
    ↓
[5] 재실행 결과가 CLOSED_ATOMIC → 성공
    재실행 결과가 여전히 FRONTIER → patch가 불충분 (기록만)
```

중요 규칙:

- Smart patch acceptance는 relation acceptance가 아니다
- `PENDING_REVIEW` patch는 저장되더라도 proof 상태를 자동 확정하지 않는다
- validator 실패 patch는 audit만 남기고 proof를 오염시키지 않는다

---

## 12. 데이터 모델 변경

### 12.1 신규 테이블: `smart_proof_llm_calls`

```sql
-- migration: 0012_smart_proof_engine.sql

CREATE TABLE "smart_proof_llm_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "inference_runs"("id") ON DELETE SET NULL,
  "proof_state_id" uuid REFERENCES "proof_states"("id") ON DELETE SET NULL,
  "call_category" text NOT NULL,
  "frontier_reason" text,
  "model" text NOT NULL,
  "temperature" real NOT NULL DEFAULT 0.1,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "estimated_cost_usd" real,
  "prompt_hash" text NOT NULL,
  "response_hash" text NOT NULL,
  "prompt_snapshot" jsonb NOT NULL,
  "response_snapshot" jsonb NOT NULL,
  "confidence" real,
  "accepted" boolean,
  "patch_id" uuid REFERENCES "proof_patches"("id") ON DELETE SET NULL,
  "duration_ms" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "chk_smart_llm_call_category"
    CHECK ("call_category" IN (
      'pre_resolution_enhancement',
      'frontier_resolution',
      'ambiguity_resolution',
      'cross_proof_correlation',
      'contradiction_detection'
    ))
);

CREATE INDEX "idx_smart_llm_calls_ws_run"
  ON "smart_proof_llm_calls" ("workspace_id", "run_id");
CREATE INDEX "idx_smart_llm_calls_proof"
  ON "smart_proof_llm_calls" ("proof_state_id");
```

### 12.2 proof_patches 확장

```sql
-- source_kind CHECK 확장
ALTER TABLE "proof_patches"
  DROP CONSTRAINT IF EXISTS "chk_proof_patches_source_kind";
ALTER TABLE "proof_patches"
  ADD CONSTRAINT "chk_proof_patches_source_kind"
  CHECK ("source_kind" IN ('deterministic', 'agent', 'smart_agent', 'manual'));
```

### 12.3 inference profile 확장

```sql
ALTER TABLE "domain_inference_profiles"
  ADD COLUMN "smart_proof_config" jsonb DEFAULT '{
    "enabled": false,
    "categories": {
      "preResolutionEnhancement": true,
      "frontierResolution": true,
      "ambiguityResolution": true,
      "crossProofCorrelation": false,
      "contradictionDetection": false
    },
    "budget": {
      "maxLlmCallsPerRun": 100,
      "maxLlmCallsPerIntent": 5,
      "maxInputTokensPerCall": 4000,
      "maxTotalTokensPerRun": 500000
    },
    "thresholds": {
      "autoAcceptConfidence": 0.80,
      "reviewConfidence": 0.50,
      "skipConfidence": 0.30
    }
  }'::jsonb NOT NULL;
```

원칙:

- profile default는 `enabled=false`
- Smart 실행은 요청별 override를 허용한다

---

## 13. 요약 메트릭

### 13.1 ProofEngineSummary 확장

```typescript
interface ProofEngineSummary {
  // ... 기존 필드

  // Smart mode 추가 메트릭
  smartMode: {
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
  };
}
```

run summary는 최소한 아래 질문에 답할 수 있어야 한다:

1. Smart가 켜졌는가
2. 몇 번 호출했는가
3. 얼마나 비용을 썼는가
4. 어떤 frontier를 얼마나 줄였는가
5. 몇 개가 auto-accept / review / skip 되었는가

### 13.2 A/B 비교 프레임워크

```typescript
// Cutover report 확장: static vs smart 비교

interface SmartProofCutoverMetrics extends IntentProofCutoverMetrics {
  // 기존 precision/recall 필드 +
  staticFrontierRate: number;        // static mode frontier 비율
  smartFrontierRate: number;         // smart mode frontier 비율
  frontierReductionRate: number;     // (static - smart) / static
  llmCostPerResolvedFrontier: number;// 해소된 frontier 1건당 평균 비용
  llmFalsePositiveRate: number;      // LLM이 해소했지만 나중에 REJECTED된 비율
}
```

---

## 14. 오케스트레이션 통합

### 14.1 inferenceRuns.ts 변경

```typescript
// executeInferenceRun() 내부, 기존 결정론적 agent pass 이후:

if (smartProofConfig?.enabled) {
  // Category A: Summary Enhancement
  if (smartProofConfig.categories.preResolutionEnhancement) {
    const enhanceable = await findEnhanceableSummaries(db, workspaceId);
    for (const summary of enhanceable) {
      if (budgetExhausted(smartBudgetTracker)) break;
      await enhanceFunctionSummary(db, generateFn, summary, smartBudgetTracker);
    }
    // 보강된 summary가 있는 intent만 재실행
    await reResolveEnhancedIntents(db, workspaceId, enhancedIntentIds, resolverContext);
  }

  // Category B: Frontier Resolution
  if (smartProofConfig.categories.frontierResolution) {
    const frontiers = await listUnresolvedFrontiers(db, workspaceId);
    for (const frontier of frontiers) {
      if (budgetExhausted(smartBudgetTracker)) break;
      await resolveSmartFrontier(db, generateFn, frontier, smartProofConfig, smartBudgetTracker);
    }
  }

  // Category D: Cross-Proof Correlation
  if (smartProofConfig.categories.crossProofCorrelation) {
    const correlationGroups = await findCorrelationGroups(db, workspaceId);
    for (const group of correlationGroups) {
      if (budgetExhausted(smartBudgetTracker)) break;
      await resolveCorrelationGroup(db, generateFn, group, smartBudgetTracker);
    }
  }

  // Category E: Contradiction Detection
  if (smartProofConfig.categories.contradictionDetection) {
    const lowConfidenceProofs = await findLowConfidenceClosedProofs(db, workspaceId, 0.65);
    for (const proof of lowConfidenceProofs) {
      if (budgetExhausted(smartBudgetTracker)) break;
      await checkContradiction(db, generateFn, proof, smartBudgetTracker);
    }
  }
}
```

### 14.2 Budget Tracker

```typescript
interface SmartBudgetTracker {
  maxCalls: number;
  maxTokens: number;
  callsUsed: number;
  tokensUsed: number;
  estimatedCostUsd: number;

  recordCall(input: { inputTokens: number; outputTokens: number; model: string }): void;
  isExhausted(): boolean;
  canAfford(estimatedInputTokens: number): boolean;
}
```

---

## 15. 구현 단계

### Phase 1: 공통 인프라 (1주)

- `SmartProofConfig` 타입 정의
- `smart_agent` source kind 확장
- `smart_proof_llm_calls` 테이블
- `SmartBudgetTracker` 구현
- Smart summary 메트릭 스켈레톤
- run route / smart route 계약 정리

### Phase 2: Category B 1차 (2~3주) — ROI 최대

**대상**: HOST_ALIAS_UNRESOLVED, CONFIG_BINDING_MISSING, ENDPOINT_MATCH_AMBIGUOUS, METHOD_UNKNOWN
**예상 효과**: FRONTIER 비율 30% → 15% (50% 감소)
**구현 범위**:
- `smartFrontierResolver.ts` (4개 frontier reason resolver)
- 프롬프트 템플릿 + Zod 출력 스키마
- Patch adapter (LLM 결과 → ProofPatch 변환)
- confidence gating + proof re-run
- 벤치마크 시나리오 추가 (smart mode 전용)

### Phase 3: Category A (1~2주)

**대상**: dynamicPath/dynamicHost/truncated function summary
**예상 효과**: 보강된 summary로 결정론적 파이프라인 자체 성능 향상
**구현 범위**:
- `smartSummaryEnhancer.ts`
- Code snippet 로더 (source file → 관련 함수 추출)
- 보강 후 재실행 로직

### Phase 4: Category C / D (1~2주)

**대상**: 같은 서비스의 반복 패턴, Category C의 순위화
**예상 효과**: 배치 해소로 LLM 호출 효율 향상
**구현 범위**:
- `smartCorrelationResolver.ts`
- Frontier 그루핑 로직
- 배치 프롬프트 설계

### Phase 5: Category E (1주)

**대상**: 저신뢰도 CLOSED_ATOMIC proof
**예상 효과**: 오탐 5~10% 감소
**구현 범위**:
- `smartContradictionDetector.ts`
- proof 강등 로직
- UI 알림

---

## 16. 핵심 파일 목록

### 신규 생성
| 파일 | 용도 |
|---|---|
| `packages/inference/src/agent/smartFrontierResolver.ts` | Category B: LLM frontier 해소 |
| `packages/inference/src/agent/smartSummaryEnhancer.ts` | Category A: summary 보강 |
| `packages/inference/src/agent/smartCorrelationResolver.ts` | Category D: 교차 추론 |
| `packages/inference/src/agent/smartContradictionDetector.ts` | Category E: 오류 탐지 |
| `packages/inference/src/agent/smartProofTypes.ts` | 공통 타입 정의 |
| `packages/inference/src/agent/smartProofPrompts.ts` | 프롬프트 템플릿 |
| `packages/inference/src/agent/smartBudgetTracker.ts` | 비용 추적 |
| `packages/db/src/migrations/0012_smart_proof_engine.sql` | DB 스키마 |
| `packages/inference/src/__tests__/agent/smartFrontierResolver.test.ts` | 테스트 |

### 수정
| 파일 | 변경 내용 |
|---|---|
| `packages/inference/src/orchestration/inferenceRuns.ts` | smart mode 실행 흐름 |
| `packages/inference/src/orchestration/intentProofEngine.ts` | `ProofPatchSourceKind`에 `'smart_agent'` 추가 |
| `packages/inference/src/orchestration/proofEngineRun.ts` | `ProofEngineSummary`에 smart 메트릭 |
| `packages/inference/src/orchestration/index.ts` | smart agent 함수 re-export |
| `packages/db/src/schema/proof.ts` | 새 테이블 + constraint 확장 |
| `apps/web/src/app/api/inference/run/route.ts` | `smartProof` 파라미터 |
| `apps/web/src/app/api/inference/smart/route.ts` | smart mode 활성화 |

---

## 17. 검증 방법

### 17.1 벤치마크 확장

기존 10개 시나리오 (static mode) 그대로 유지하고, Smart mode 전용 시나리오 5개 추가:

1. `smart-host-alias-resolved`: 결정론적 agent가 포기한 alias를 LLM이 해소
2. `smart-endpoint-disambiguated`: ambiguous endpoint를 LLM이 선택
3. `smart-method-inferred`: unknown method를 LLM이 추론
4. `smart-summary-enhanced`: dynamic path를 LLM이 보강 → 결정론적 파이프라인 성공
5. `smart-contradiction-caught`: 오탐 proof를 LLM이 탐지

### 17.2 Cutover 비교

- 동일 workspace에 static run + smart run 실행
- precision/recall delta 측정
- frontier reduction rate 측정
- LLM 비용 대비 해소율(cost-per-resolution) 측정
