# Inference Engine Design-Aligned Recommendation

작성일: 2026-04-06
대상 워크스페이스: `/Users/spark/workspace`
작성 목적: 현재 `/Users/spark/workspace` 기준 추론 결과가 Kafka topic 위주로만 보이는 문제를, 현행 설계/스펙의 핵심 개념을 훼손하지 않는 범위에서 개선하기 위한 권고안을 정리한다.

---

## 1. 요약

현재 문제는 단순히 "정밀도가 낮다"는 수준이 아니라, 아래 두 층이 겹쳐 발생한다.

1. 현행 제품 기본 경로는 Intent-Centric Proof Engine 중심인데, deterministic 추출/부트스트랩 계층이 HTTP 계열의 실제 코드 패턴을 충분히 흡수하지 못한다.
2. 문서상 존재하는 표준 deterministic 후보 생성 계약과, 현재 실제 기본 run 경로의 구현 상태가 완전히 일치한다고 보기 어렵다.

결론적으로 권장 방향은 다음이다.

- 기본 제품 경로는 계속 `proof-engine-first`로 유지한다.
- `pair-first` 또는 `service -> service fallback` 중심 구조를 기본 동작으로 되돌리지 않는다.
- 대신 deterministic 입력 품질을 높이고, partial evidence를 frontier/intention 상태로 보존하는 쪽으로 개선한다.
- 필요 시 legacy deterministic 후보 생성기는 "호환 모드"로만 제한적으로 재연결한다.

---

## 2. 판단 기준 문서

이번 권고안은 아래 문서를 우선 기준으로 삼는다.

### 2.1 추론 엔진 기준 문서

- `docs/design/03-inference-engine.md`
  - 코드/설정/DB/OpenAPI에서 신호를 수집해 승인 가능한 후보를 만든다는 전체 목적을 정의한다.
  - 표준 추론, Smart 추론, 운영 레이어를 모두 포함하는 문서다.
  - 표준 추론의 핵심 설명은 `config/code/db 기반 deterministic 후보 생성`이다.

### 2.2 표준 deterministic run 계약

- `docs/spec/12-inference-run-orchestration-spec.md`
  - `modes=config|code|db`와 async run의 운영 계약을 정의한다.
- `docs/spec/13-code-based-relation-candidate-spec.md`
  - `mode=code`만 실행해도 `relation_candidates`가 생성되어야 한다는 계약을 정의한다.
- `docs/spec/14-compound-to-atomic-inference-spec.md`
  - `expose -> api_endpoint`, `call -> api_endpoint`, `produce/consume -> topic|queue`의 atomic-first deterministic 후보 생성 원칙을 정의한다.

### 2.3 현행 핵심 추론 철학

- `docs/design/09-intent-centric-proof-engine-overview.md`
  - 핵심 방향:
    - service pair를 먼저 만들고 endpoint를 나중에 찾는 구조를 버린다.
    - interaction intent를 seed로 삼는다.
    - atomic target까지 proof를 닫은 뒤에만 candidate를 만든다.
  - service-level candidate fallback을 금지한다.
  - route-family seed는 직접 candidate가 아니라 child proof의 상위 상태다.

### 2.4 Smart의 역할 제한

- `docs/spec/53-smart-proof-engine-escalation-spec.md`
  - Smart는 deterministic proof engine 뒤에 붙는 frontier-local escalation 계층이다.
  - Smart는 candidate를 직접 만들지 않는다.
  - pair-first Smart pipeline을 제품 기본 계약으로 되돌리면 안 된다.

### 2.5 스캔 bootstrap 관련 기준

- `docs/spec/40-inference-scan-smart-async-spec.md`
  - scan 직후 `extractCodeSignalsWithEngine`와 `inferRelationsFromCodeSignals`를 수행해 atomic bootstrap을 끝내는 흐름을 허용한다.

---

## 3. 현재 관찰된 문제

### 3.1 `/Users/spark/workspace`의 코드 패턴 특징

- Spring/Gradle 서비스가 다수 존재한다.
- 컨트롤러 매핑(`@RequestMapping`, `@GetMapping`, `@PostMapping`)은 매우 많다.
- Kafka topic 리터럴 사용도 존재한다.
- 반면 HTTP outbound 호출은 대다수가 아래처럼 동적 URI 패턴이다.
  - `.uri(uri)`
  - `UriComponentsBuilder...toUriString()`
  - `baseUrl + PATH`
  - 설정 바인딩된 URL 조합

즉, inbound endpoint 정의는 많지만, outbound HTTP dependency는 "문자열 리터럴"이 아니라 변수/조합 기반 표현이 많다.

### 3.2 왜 Kafka는 나오고 HTTP는 잘 안 나오는가

- Kafka는 `@KafkaListener(topics = "...")`, `kafkaTemplate.send("...")` 같은 리터럴 패턴이 많다.
- 현재 regex/AST 추출기에서 이 패턴은 비교적 직접적으로 잡힌다.
- 따라서 message intent 또는 topic candidate로 이어질 가능성이 높다.

반면 HTTP는:

- 컨트롤러 정의는 `expose`로 잡혀도 이것만으로 relation candidate가 되지 않는다.
- outbound HTTP는 dynamic URI가 많아 `call` 신호가 약하다.
- service host/path가 불완전하면 proof engine 쪽에서도 frontier 또는 no-result로 남기 쉽다.

### 3.3 구조적 불일치 가능성

문서상 표준 추론은 deterministic 후보 생성기를 포함하지만, 실제 현행 기본 run 경로는 proof-engine 중심으로 재편되어 있다.

여기서 중요한 점은:

- 이것이 단순 "누락"인지
- 아니면 "기본 경로 전환 후 문서 정리 미완"인지

를 먼저 분리해야 한다는 것이다.

이 구분 없이 코드만 고치면, 제품 철학을 되돌릴 위험이 있다.

---

## 4. 설계와 충돌하지 않는 개선 원칙

아래 원칙을 지키면 현재 설계의 핵심 개념을 훼손하지 않는다.

### 4.1 proof-engine-first 유지

기본 run의 의미는 계속 다음이어야 한다.

- interaction intent를 seed로 삼는다.
- closed proof만 candidate로 투영한다.
- service-level fallback candidate를 기본 결과로 만들지 않는다.

즉, recall 부족을 이유로 `pair-first` 경로를 기본값으로 복귀시키면 안 된다.

### 4.2 deterministic 입력 품질을 먼저 올린다

문제의 1차 원인은 "proof engine 철학" 자체보다도 입력 손실이다.

따라서 우선순위는:

1. 더 많은 HTTP/code/config evidence를 deterministic하게 추출
2. partial evidence를 skip 대신 structured state로 보존
3. proof pipeline이 그 상태를 닫을 수 있게 확장

순이어야 한다.

### 4.3 expose는 계속 index/anchor 용도로만 사용

`expose`를 직접 candidate로 만들지 않는 원칙은 유지해야 한다.

대신:

- endpoint bootstrap
- endpoint index
- route family narrowing
- provider endpoint resolution

에 적극적으로 활용해야 한다.

### 4.4 Smart는 frontier-local patcher로만 유지

Smart를 다음 용도로 확장하면 안 된다.

- pair truth 선언
- candidate 직접 생성
- proof validator 우회

Smart는 여전히 frontier를 닫기 위한 structured patch 제안 계층이어야 한다.

### 4.5 compat path는 "기본 경로"가 아니라 "호환 경로"로만 둔다

`inferRelationsFromConfig()` / `inferRelationsFromCodeSignals()` 자체는 문서상 유효한 deterministic 자산이다.
다만 이것을 현행 제품의 기본 truth path로 되돌리는 것은 위험하다.

가능한 해석은 다음 둘 중 하나다.

1. proof-engine cutover 전 legacy/compat 계층
2. bootstrap/diagnostic/ROI 개선용 보조 계층

이 중 2번으로 정리하는 것이 현재 설계와 더 잘 맞는다.

---

## 5. 권고안

## 5.1 권고안 A — 문서 계약을 먼저 재정렬

### 목적

"현재 제품 기본 경로"와 "호환 deterministic 경로"를 분리해 문서-코드 불일치를 줄인다.

### 제안

- `docs/design/03-inference-engine.md`에 아래를 명시한다.
  - 표준 추론의 문서적 범위와
  - 현재 제품 기본 커널이 proof-engine인지
  - legacy deterministic candidate generator가 기본 경로인지/호환 경로인지

- `docs/spec/12-inference-run-orchestration-spec.md`를 아래 중 하나로 정리한다.
  - A안: 기본 run은 proof-engine이며, deterministic candidate generator는 bootstrap/compat로 제한
  - B안: 기본 run은 deterministic candidate generator + proof-engine 후속 처리

현재 설계 철학상 A안이 더 적절하다.

### 기대 효과

- 이후 구현 변경이 "버그 수정"인지 "계약 변경"인지 명확해진다.
- 팀 내 해석 차이를 줄일 수 있다.

---

## 5.2 권고안 B — scan bootstrap과 run bootstrap 공통화

### 목적

현재 `scan`과 `run`이 다른 품질의 초기 상태를 만들 가능성을 줄인다.

### 제안

- 공통 bootstrap 단계를 별도 모듈로 추출한다.
- 공통 bootstrap의 책임:
  - `expose -> api_endpoint` bootstrap
  - `produce/consume -> topic|queue` atomic bootstrap
  - 필요 시 DB object bootstrap
  - 함수/alias/route transform 등 proof 입력 상태 준비

- `/api/scan`은 여전히 "첫 경험 개선용 bootstrap"에 집중한다.
- `/api/inference/run`도 같은 bootstrap을 반드시 거치게 한다.

### 설계 정합성

이 방향은 `scan 직후 atomic bootstrap`을 허용하는 `docs/spec/40-inference-scan-smart-async-spec.md`와 맞고,
proof-engine-first 철학과도 충돌하지 않는다.

### 기대 효과

- 스캔 직후와 추론 실행 직후의 데이터 형태 차이를 줄인다.
- endpoint index 부족으로 proof가 빈번히 실패하는 현상을 줄일 수 있다.

---

## 5.3 권고안 C — HTTP 신호 추출을 "동적 URI 친화적"으로 강화

### 목적

Kafka 대비 HTTP만 유독 약한 현재 상황을, 철학 변경 없이 deterministic 추출 강화로 보완한다.

### 제안 범위

#### Phase C1. 추출 대상 확대

- `RestClient.get().uri(uri)`
- `WebClient...uri(uri)`
- `UriComponentsBuilder.fromUriString(base).path(PATH)...`
- `baseUrl + CONST_PATH`
- 설정값 바인딩된 `apiProperties.getXxx()` + endpoint constant 조합

#### Phase C2. 결과 저장 형식

완전한 URL을 못 닫아도 아래 slot을 저장한다.

- `hostHint`
- `serviceNameHint`
- `baseUrlVar`
- `pathHint`
- `methodHint`
- `dynamicPath=true|false`
- `dynamicHost=true|false`

#### Phase C3. skip 대신 partial evidence 보존

기존에 바로 skip하던 케이스도 가능하면 intent/state로 남긴다.

예:

- path-only
- alias-only
- route-template-only
- wrapper method 내부 call

### 설계 정합성

이 방향은 다음과 합치한다.

- `partial evidence 손실을 줄여야 한다`는 intent-centric 문서
- AST/Hybrid 정밀도 향상 문서
- frontier-local 해소 전략

### 주의점

이 단계에서 service-level fallback candidate를 다시 많이 만드는 방향으로 가면 안 된다.
핵심은 "candidate 생성 확대"가 아니라 "proof 입력 품질 향상"이다.

---

## 5.4 권고안 D — proof engine에 frontier reason을 늘리고 route-family 해석을 보강

### 목적

HTTP 추론이 실패했을 때 단순 "0건"으로 끝나지 않고, 어떤 종류의 미해결인지 남기게 한다.

### 제안

- 아래 frontier reason을 1급 상태로 확장한다.
  - `HOST_ALIAS_UNRESOLVED`
  - `CONFIG_BINDING_MISSING`
  - `ENDPOINT_MATCH_AMBIGUOUS`
  - `METHOD_UNKNOWN`
  - `DYNAMIC_URI_UNRESOLVED`
  - `PATH_ONLY_TARGET_UNRESOLVED`

- route-family root proof에서 보존할 정보 확대:
  - config route seed
  - service alias binding
  - transformed path family
  - candidate endpoint family set

### 설계 정합성

이 방향은 `candidate보다 proof state를 먼저 다룬다`는 설계와 정합적이다.
또한 Smart가 frontier-local patcher라는 모델과도 매우 잘 맞는다.

### 기대 효과

- "왜 Kafka만 보이는가" 같은 질문에 run stats만으로 답할 수 있게 된다.
- Smart 적용 지점도 더 합리적으로 좁힐 수 있다.

---

## 5.5 권고안 E — legacy deterministic 후보 생성기는 compat mode로만 제공

### 목적

현장 검증과 ROI 회복은 하되, 제품 기본 철학을 되돌리지 않는다.

### 제안

- 명시적 플래그 또는 별도 run subtype으로만 활성화한다.
  - 예: `compatDeterministicCandidates: true`
  - 또는 내부 운영용 `triggerType`

- compat mode에서만:
  - `inferRelationsFromConfig()`
  - `inferRelationsFromCodeSignals()`
  - `bindConfigToCodeEndpoints()`

  를 다시 연결한다.

- 기본 run 응답과 stats에서는 proof-engine 결과와 compat 결과를 분리 집계한다.

예:

- `summary.proofCandidatesCreated`
- `summary.compatCandidatesCreated`
- `warnings: ['compat mode enabled']`

### 설계 정합성

이 방향은 proof-engine-first를 유지한 채 legacy deterministic 계약을 운영용으로 활용하는 절충안이다.

### 주의점

다음은 금지한다.

- compat 결과를 기본 truth처럼 보여주기
- service-level fallback candidate를 메인 UI 기본값으로 보여주기
- Smart가 compat 결과를 바탕으로 truth를 확정하게 만들기

---

## 5.6 권고안 F — 운영 메트릭/진단 지표 확장

### 목적

"0건"의 원인을 계층별로 분해해 설명 가능하게 만든다.

### 추가 권장 지표

- `endpointBootstrapCount`
- `topicBootstrapCount`
- `queueBootstrapCount`
- `httpIntentCount`
- `gatewayRouteIntentCount`
- `messagePublishIntentCount`
- `messageConsumeIntentCount`
- `dynamicUriIntentCount`
- `pathOnlyIntentCount`
- `closedAtomicCount`
- `frontierCount`
- `frontierReasonBreakdown`
- `compatCandidatesCreated` (compat mode가 있을 때만)

### 기대 효과

- workspace별 약점 파악이 가능해진다.
- 추출 문제인지, resolution 문제인지, projection 문제인지 분리할 수 있다.

---

## 6. 추천 구현 순서

### Phase 0. 문서 정렬

가장 먼저 아래를 확정한다.

1. 기본 run은 proof-engine-only인가
2. legacy deterministic candidate generator는 기본 경로인가 compat 경로인가

이 합의 없이는 이후 변경이 설계 위반인지 단순 버그 수정인지 판단이 어렵다.

### Phase 1. 공통 bootstrap 정리

- `/api/scan`과 `/api/inference/run`이 동일한 endpoint/topic/queue bootstrap을 쓰게 만든다.
- endpoint 부족으로 인한 early no-result를 줄인다.

### Phase 2. 추출 계층 보강

- AST/hybrid에서 dynamic URI 패턴 지원
- config binding에서 host/path 힌트 강화
- partial evidence 구조화 저장

### Phase 3. proof frontier 확장

- unresolved를 단순 skip하지 말고 frontier reason으로 남긴다.
- route-family와 child proof 파이프라인을 보강한다.

### Phase 4. 운영용 compat mode 여부 결정

- 현장 ROI가 필요하면 compat mode를 추가한다.
- 기본 UX로 노출할지는 매우 보수적으로 결정한다.

---

## 7. 피해야 할 개선안

아래는 단기적으로 숫자를 늘려도 설계 핵심과 충돌할 가능성이 높다.

### 7.1 pair-first 복귀

- service pair를 먼저 만들고 endpoint를 나중에 찾는 구조를 기본 경로로 되돌리는 것

이건 intent-centric proof engine의 핵심 결정과 정면 충돌한다.

### 7.2 service-level fallback candidate 재도입

- path가 안 닫히면 일단 `service -> service` 후보라도 많이 만드는 방식

이건 precision 저하와 candidate fan-out를 다시 초래한다.

### 7.3 Smart의 역할 확대

- Smart가 candidate를 직접 생성
- Smart가 validator를 우회
- Smart가 pair truth를 선언

이건 현재 Smart 설계와 맞지 않는다.

### 7.4 partial evidence의 조기 skip 유지

- dynamic URI
- alias-only
- path-only
- route template

같은 케이스를 계속 skip하면 현재 workspace 유형에서 recall은 구조적으로 개선되지 않는다.

---

## 8. 최종 권고

가장 권장하는 방향은 아래 한 줄로 요약된다.

> 기본 제품 경로는 proof-engine-first로 유지하고, HTTP/route/config의 partial evidence를 더 풍부하게 추출·보존하여 atomic closure recall을 올린다.

실행 가능한 제품/구현 문장으로 바꾸면 다음과 같다.

1. 기본 run을 pair-first로 되돌리지 않는다.
2. scan bootstrap과 run bootstrap을 공통화한다.
3. AST/hybrid와 config extraction에서 dynamic URI/host alias/path hint를 강화한다.
4. unresolved는 frontier reason으로 남긴다.
5. legacy deterministic 후보 생성은 필요 시 compat mode로만 제공한다.
6. 운영 메트릭을 확장해 workspace별 실패 원인을 보이게 한다.

이 순서를 따르면:

- `/Users/spark/workspace` 같은 Spring/Gradle 다중 repo 구조에서 Kafka 편향 문제를 줄일 수 있고
- 현재 설계 문서의 핵심 철학도 유지할 수 있다.

---

## 9. 후속 작업 제안

이 문서 이후 바로 이어질 작업으로는 아래를 추천한다.

1. `proof-engine-first / compat mode` 문서 합의안 작성
2. 공통 bootstrap 함수 설계 문서 초안 작성
3. dynamic URI 추출 규칙 SPEC 초안 작성
4. frontier reason observability 확장 SPEC 초안 작성
