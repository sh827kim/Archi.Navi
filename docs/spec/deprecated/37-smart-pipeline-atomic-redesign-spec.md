# [Deprecated] 37. Smart Pipeline Atomic 재설계 (SPEC)

> **상태: Deprecated (2026-04-05)**
> 이 문서는 pair-scoped Smart pipeline을 기준으로 작성된 레거시 제품 계약이다.
> 현재 Smart는 별도 pair-first 엔진이 아니라 proof engine 위의 escalation 레이어이며, 현행 계약은 [53-smart-proof-engine-escalation-spec.md](../53-smart-proof-engine-escalation-spec.md)와 [50-intent-centric-proof-engine-resolution-pipeline-spec.md](../50-intent-centric-proof-engine-resolution-pipeline-spec.md)를 따른다.

---

## 대체 사유

- 추론 seed가 `service pair`에서 `interaction intent`로 바뀌었다.
- fallback reason 중심 모델이 `proof/frontier` 상태 모델로 교체되었다.
- service-level fallback candidate를 허용하던 계약이 atomic closed proof projection으로 대체되었다.

---

## (아래는 원본 내용)

# 37. Smart Pipeline Atomic 재설계 (SPEC)

상태: Implemented (S1-1a 완료, 2026-03-29)
작성일: 2026-03-28

> 기존 Smart Pipeline(`POST /api/inference/smart`)을 “서비스 후보 요약” 중심 구조에서
> “pair-scoped atomic inference” 중심 구조로 재설계한다.

## 1. 목적

Smart 기능을 아래 요구사항에 맞게 다시 정의한다.

1. 프로젝트 config 파일을 먼저 LLM에게 전달해 의존 가능성이 높은 서비스 쌍을 식별한다.
2. 식별된 서비스 쌍에 대해서는 실제 소스코드를 충분히 읽을 수 있게 하여 atomic 관계를 추론한다.
3. OpenAPI가 없더라도 `api_endpoint`가 자동 생성되어 atomic 추론이 가능해야 한다.

## 2. 문제 정의

현재 구현은 Smart 3-Phase를 갖고 있지만, 아래 차이로 인해 사용자가 기대한 결과와 어긋난다.

- Phase 3 입력이 `HTTP client 키워드가 포함된 일부 파일`로만 제한된다.
- provider 측 엔드포인트는 OpenAPI import 결과에 강하게 의존한다.
- `api_endpoint`가 없거나 path/method 매칭이 실패하면 service-level 후보로 fallback 된다.
- LLM은 pair-scoped 코드 맥락을 읽지 못하고, consumer 일부 코드 + DB의 endpoint 목록만 본다.

이로 인해 Smart 실행 결과가 service-level 후보에 치우치고, atomic 매핑은 사후 수동 흐름에 의존한다.

## 3. 요구사항 재정의

### 3.1 포함
- config 기반 서비스 쌍 탐지
- 서비스 쌍 단위 source/context 수집
- provider endpoint bootstrap(OpenAPI + code expose)
- atomic relation candidate 생성
- fallback reason 기록
- low-confidence unresolved pair에 대한 optional deep inspection

### 3.2 제외
- 완전 자율 승인/거부
- 전체 repo를 무제한 탐색하는 에이전트 기본 모드
- 임베딩/벡터 검색 기반 전면 재설계

## 4. 고려한 방식

### 옵션 A. 현재 프롬프트 확장만 수행
- 방법: Phase 3의 파일 수/문자 수 제한만 완화
- 장점: 구현이 가장 빠름
- 한계: wrapper, constant, provider handler 등 pair 맥락 부족 문제를 근본 해결하지 못함

### 옵션 B. 정적분석 + pair-scoped evidence pack + LLM
- 방법: config로 서비스 쌍을 좁히고, 정적분석이 관련 파일/endpoint를 수집한 뒤 LLM이 atomic 관계를 판별
- 장점: 정확도, 비용, 재현성 균형이 가장 좋음
- 단점: evidence pack assembler 구현 필요
- **권장안**

### 옵션 C. Agent SDK / tool-calling 기반 deep inspection
- 방법: 모델에 `search_files`, `read_file`, `get_service_context`, `get_endpoints`, `upsert_api_endpoint` 같은 툴을 제공
- 장점: 애매한 케이스에서 유연함
- 단점: latency, cost, trace variability 증가
- 권장 사용처: unresolved 또는 low-confidence pair의 보조 경로

## 5. 권장 설계

### 5.1 Smart 파이프라인 개편

```text
Phase 1   OpenAPI import
Phase 1.5 Code expose 기반 endpoint bootstrap
Phase 2   Config -> LLM -> candidate service pairs
Phase 2.5 Pair-scoped evidence pack assembly
Phase 3   Pair -> LLM -> atomic relation inference
Phase 3.5 Optional deep inspection (tool-using agent)
```

### 5.2 Phase 1.5 — endpoint bootstrap

`api_endpoint`가 없거나 부족한 서비스에 대해 Smart 내부에서 code signal 경로를 재사용한다.

- 입력: `workspaceId`, `repoRoots`, 서비스 `scanPath`
- 데이터 소스:
  - OpenAPI import 결과
  - `extractCodeSignalsWithEngine`
  - `inferRelationsFromCodeSignals` 내부의 `expose -> api_endpoint upsert` 로직
- 규칙:
  - OpenAPI가 있으면 OpenAPI 결과를 우선 사용
  - OpenAPI가 없거나 endpoint count가 0이면 code expose bootstrap 수행
  - bootstrap으로 생성된 endpoint는 `metadata.source = "CODE"` 또는 `"SMART_BOOTSTRAP"`

### 5.3 Phase 2 — config 기반 서비스 쌍 탐지

기존 Smart와 동일한 방향을 유지하되, 산출물을 “consumer 서비스 목록”이 아니라 “우선순위가 부여된 pair 목록”으로 승격한다.

- 입력: 실제 config 파일 내용
- 출력:
  - `servicePairs[]`
  - `relationHints[]`
  - pair confidence / evidence
- 예시:
  - `gateway -> orders`
  - `orders -> payment`

### 5.4 Phase 2.5 — pair-scoped evidence pack

Phase 3에서 LLM이 충분한 맥락을 읽을 수 있도록 서비스 쌍 단위 evidence pack을 생성한다.

포함 대상:
- consumer 측 outbound call site 파일
- consumer 측 URL 상수 / wrapper / client interface / config binding 파일
- provider 측 controller/router/handler 파일
- provider 측 endpoint 목록 (`api_endpoint`)
- pair와 직접 연관된 config snippet

수집 방식:
- code signal engine이 찾은 `call`, `expose` evidence를 anchor로 사용
- anchor 파일의 import/참조 1-hop 범위 파일만 확장
- provider는 endpoint path/method 기준으로 handler 후보를 우선 수집
- 파일별 우선순위를 매겨 토큰 예산 내에서 pack 구성

### 5.5 Phase 3 — atomic relation inference

LLM 입력은 “consumer 일부 파일 모음”이 아니라 “A -> B 서비스 쌍 evidence pack”이어야 한다.

출력 예시:

```json
{
  "relations": [
    {
      "subjectService": "gateway",
      "targetService": "orders",
      "httpMethod": "GET",
      "path": "/api/orders/{id}",
      "targetEndpointRef": "GET /api/orders/{id}",
      "confidence": 0.89,
      "evidence": "..."
    }
  ]
}
```

저장 규칙:
- endpoint가 존재하면 `service -> api_endpoint` candidate 생성
- endpoint bootstrap 후에도 endpoint를 못 찾으면 service-level fallback 허용
- 단, fallback 시 아래 reason 필드를 반드시 남긴다.
  - `NO_ENDPOINT_OBJECTS`
  - `PATH_NOT_MATCHED`
  - `METHOD_NOT_MATCHED`
  - `INSUFFICIENT_CONTEXT`

### 5.6 Phase 3.5 — optional deep inspection

기본 경로로 atomic 판별이 어려운 pair에 대해서만 tool-using mode를 허용한다.

권장 툴:
- `search_files(serviceId, query)`
- `read_file(path, start?, end?)`
- `get_service_context(serviceId)`
- `list_service_endpoints(serviceId)`
- `upsert_api_endpoint(serviceId, method, path)`
- `save_atomic_candidate(...)`

실행 조건:
- pair confidence가 임계값 이하
- fallback reason이 `INSUFFICIENT_CONTEXT`
- 실행당 tool call / file read / token budget 상한 내

기본 구현 선택:
- 1차 구현은 Agent SDK 없이 deterministic function-tool abstraction으로 시작
- 2차에서 OpenAI Agents SDK 또는 Responses API tool-calling을 선택 가능하도록 adapter 계층 분리

## 6. API / 계약 변경

### 6.1 `POST /api/inference/smart`

응답에 다음 필드를 포함한다.

- `phase1.bootstrapEndpointCount`
- `phase2.servicePairCount`
- `phase3.atomicCandidateCount`
- `phase3.serviceFallbackCount`
- `phase3.deepInspectionCount`
- `phase3.deepInspectionTrace`

`phase3.deepInspectionCount`는 실제 optional deep inspection 실행 시도 수를 의미한다.
`phase3.deepInspectionTrace`는 실행 시도/실패 수와 trigger breakdown(`lowConfidence`, `insufficientContext`) 요약을 의미한다.

### 6.2 candidate metadata

Smart 생성 후보는 아래 metadata를 공통으로 가진다.

- `source: "LLM_SMART"`
- `signalKind: "smart_pair_atomic"`
- `targetType: "api_endpoint" | "service"`
- `targetServiceId`
- `pairEvidenceSummary`
- `fallbackReason?`
- `fallbackContext?: { attemptedMethod, attemptedPath, evidenceSummary? }`
- `analysisMode: "prompt_only" | "pair_pack" | "deep_inspection"`

Approval UI용 후보 조회 API는 위 raw metadata를 그대로 노출하지 않고, Smart service fallback 후보에 한해
`fallbackContext`만 최소 계약으로 재구성해 내려준다.

## 7. 구현 순서

### Step 1. endpoint bootstrap 선행
- Smart 내부에서 code expose 기반 `api_endpoint` 생성 경로 연결
- OpenAPI-only 의존 제거

### Step 2. pair-scoped evidence pack assembler
- code signal / config evidence / endpoint metadata 조합
- token budget 정책 추가

### Step 3. Smart Phase 3 재작성
- pair 단위 atomic inference schema 정의
- fallback reason 저장

### Step 4. observability / run detail
- 실행 상세에서 pair 수, fallback 수, bootstrap 수 노출
- Approval UI에서 fallback reason 표시 가능하게 응답 계약 확장
- Smart service fallback 후보 카드에 `시도 호출 method/path`와 `근거 요약` 노출
- Smart 실행 완료 toast에 deep inspection trace summary 노출

### Step 5. optional deep inspection
- 현재 최소 구현은 `low-confidence` 또는 `INSUFFICIENT_CONTEXT` pair만 optional hook을 타도록 제한한다.
- deterministic tool-assisted deep inspection 1차는 `searchFiles`, `readFile`, `listServiceEndpoints`와 pair-local budget으로 동작한다.
- `runDeepInspection` custom hook이 있으면 deterministic adapter보다 우선한다.
- optional hook이 실패해도 기본 Smart 결과는 유지한다.
- richer adapter 2차로 복잡한 path template/경로 변형 매칭을 보강했다.
- trace/observability viewer를 추가해 `deepInspectionTrace.details` 기반 pair drill-down을 Approval UI에서 노출한다.
- `no_result` 상태는 route/viewer 경계에서 pass-through되며, UI는 이를 `결과 없음`으로 표시한다.
- 검증:
  - `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/orchestration/smartPipeline.test.ts` 기준 `1 file, 22 tests passed`
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/smart.route.test.ts src/__tests__/approval-list.test.tsx` 기준 `2 files, 25 tests passed`
- Agent SDK 도입은 이 단계에서만 검토

## 8. 수용 기준

| ID | 기준 |
|----|------|
| T1 | config 파일만으로 candidate service pair를 생성할 수 있다 |
| T2 | OpenAPI가 없어도 code expose만으로 `api_endpoint`가 생성된다 |
| T3 | pair-scoped evidence pack이 consumer/provider 양쪽 파일을 포함한다 |
| T4 | Smart가 endpoint 존재 시 `service -> api_endpoint` 후보를 생성한다 |
| T5 | endpoint 미존재/미매칭 시 fallback reason이 metadata에 저장된다 |
| T5a | Smart service fallback 후보 조회 응답은 `fallbackContext`를 최소 계약으로 노출한다 |
| T6 | 단순 키워드 누락 파일이라도 code signal anchor가 있으면 evidence pack에 포함된다 |
| T7 | Smart 응답 summary에 bootstrap/pair/atomic/fallback 통계가 포함된다 |
| T8 | low-confidence pair만 deep inspection을 탄다 |
| T9 | deep inspection 실패 시에도 기본 Smart 결과는 유지된다 |
| T10 | 기존 approval의 compound-to-atomic 수동 매핑 흐름과 충돌하지 않는다 |

## 9. 테스트 전략

- unit
  - endpoint bootstrap without OpenAPI
  - pair-scoped evidence pack selection
  - fallback reason persistence
  - atomic candidate positive case
  - deep inspection gating (`low-confidence` / `INSUFFICIENT_CONTEXT`)
  - deep inspection failure-safe 기본 결과 유지
- integration
  - `POST /api/inference/smart` end-to-end with config + source fixtures
  - Smart summary contract
  - deep inspection trace summary contract
  - fallback candidate API summary contract
- e2e
  - Smart 실행 후 Approval 목록에서 atomic 후보 확인
  - endpoint bootstrap 후 atomic candidate 생성 확인
  - Smart fallback 후보 카드에서 reason/context 표시 확인

## 10. 후속 범위

- vector/RAG를 이용한 대규모 모노레포 코드 검색 최적화
- pair별 incremental cache
- step-level tool event 로그 시각화 고도화
