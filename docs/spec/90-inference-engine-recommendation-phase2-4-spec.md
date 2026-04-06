# 90. Inference Engine Recommendation Phase 2~4 SPEC

상태: Proposed
작성일: 2026-04-06

## 1. 목적

`docs/spec/88-inference-engine-design-aligned-recommendation-2026-04-06.md`와
`docs/spec/89-inference-engine-recommendation-triage-2026-04-06.md`의 후속 구현으로,
proof-engine-first 철학을 유지한 채 HTTP partial evidence 보존, frontier reason 확장,
선택형 compat deterministic mode를 도입한다.

## 2. 요구사항

### 2.1 Phase 2. partial HTTP evidence 보존
- Java/Kotlin AST direct HTTP call 추출은 literal URL을 완전히 못 닫아도 아래 metadata를 남겨야 한다.
  - `method`
  - `pathHint`
  - `hostHint`
  - `serviceNameHint`
  - `baseUrlVar`
  - `dynamicPath`
  - `dynamicHost`
  - `configKeys`
- function summary와 interaction intent는 위 metadata를 읽어 partial HTTP state를 보존해야 한다.
- partial evidence는 service-level fallback candidate를 만들지 않는다.

### 2.2 Phase 3. frontier / observability 확장
- HTTP proof는 아래 상황을 구분해야 한다.
  - 동적 host/path 때문에 provider/endpoint closure가 불가능한 경우
  - path만 있고 provider endpoint를 좁힐 수 없는 경우
- 신규 frontier reason:
  - `DYNAMIC_URI_UNRESOLVED`
  - `PATH_ONLY_TARGET_UNRESOLVED`
- proof summary는 최소 아래 필드를 제공해야 한다.
  - `dynamicUriIntentCount`
  - `pathOnlyIntentCount`
  - `frontierReasonBreakdown`

### 2.3 Phase 4. compat deterministic mode
- `POST /api/inference/run` 요청은 `compatDeterministicCandidates?: boolean`를 지원해야 한다.
- 기본값은 `false`여야 한다.
- `true`일 때만 compat deterministic 경로를 실행한다.
  - config candidate generation
  - code candidate generation
  - config->code endpoint binding
- compat mode 결과는 proof summary와 분리 집계해야 한다.
  - `summary.proofCandidatesCreated`
  - `summary.compatCandidatesCreated`
  - `summary.compatModeEnabled`

## 3. 설계 제약
- 기본 truth path는 여전히 proof-engine-first다.
- compat mode 결과를 proof candidate와 합쳐 기본 truth처럼 취급하지 않는다.
- Smart는 partial evidence/compat mode를 근거로 validator를 우회하지 않는다.

## 4. 수용 기준

| ID | 기준 |
|---|---|
| T1 | dynamic/path-only HTTP call이 intent 또는 function summary에서 완전히 사라지지 않는다 |
| T2 | dynamic URI 케이스는 `DYNAMIC_URI_UNRESOLVED`로 generic frontier와 구분된다 |
| T3 | path-only unresolved 케이스는 `PATH_ONLY_TARGET_UNRESOLVED`로 집계된다 |
| T4 | proof summary에서 `dynamicUriIntentCount`, `pathOnlyIntentCount`, `frontierReasonBreakdown`를 확인할 수 있다 |
| T5 | compat mode가 꺼져 있으면 legacy deterministic candidate generator가 실행되지 않는다 |
| T6 | compat mode가 켜져 있으면 compat candidate 수가 별도 집계된다 |
| T7 | compat mode 기본값은 false이고 proof-engine-first 결과는 기존과 호환된다 |

## 5. 테스트
- extraction: dynamic metadata merge와 path-only intent 보존
- proof engine: 신규 frontier reason 판별
- inference run: compat mode off/on 분기와 stats 집계 분리
