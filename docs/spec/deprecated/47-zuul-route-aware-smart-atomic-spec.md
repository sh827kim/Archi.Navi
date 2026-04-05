# [Deprecated] 47. Zuul Route-Aware Smart Atomic SPEC

> **상태: Deprecated (2026-04-05)**
> 이 문서는 pair-first Smart pipeline 위에서 Zuul route를 atomic 복구 힌트로 다루던 계약이다.
> 현재 gateway route는 proof engine의 `HTTP_GATEWAY_ROUTE_INTENT`와 route transform 단계로 흡수되었고, Smart는 그 위의 escalation으로 동작한다.
> 현행 기준은 [50-intent-centric-proof-engine-resolution-pipeline-spec.md](../50-intent-centric-proof-engine-resolution-pipeline-spec.md)와 [53-smart-proof-engine-escalation-spec.md](../53-smart-proof-engine-escalation-spec.md)다.

---

## 대체 사유

- gateway route가 pair recovery 힌트가 아니라 1급 intent/proof seed로 승격되었다.
- direct match 실패 후 route-aware alias match를 시도하는 구조가 route transform + child proof derivation 단계로 재설계되었다.
- `service fallback` 허용 전제가 현행 proof engine과 충돌한다.

---

## (아래는 원본 내용)

# [Deprecated] 47. Zuul Route-Aware Smart Atomic SPEC

상태: Implemented
우선순위: S1
로드맵 범위: Smart Pipeline 정확도 개선

Deprecated 사유:
- route-aware Smart를 pair-scoped atomic inference로 다루는 구조는 현재 intent/proof 중심 모델에서 상위 seed + child proof 구조로 대체되었다.
- gateway route family 해석의 현행 기준은 proof engine route-family pipeline이다.
- 대체 기준: `docs/spec/48-intent-centric-proof-engine-spec.md`, `docs/spec/50-intent-centric-proof-engine-resolution-pipeline-spec.md`, `docs/spec/53-smart-proof-engine-escalation-spec.md`

## 1. 문제 정의

기존 Smart Pipeline은 service pair까지는 안정적으로 추론하지만, atomic 단계에서는 provider 내부 endpoint 경로와 consumer 외부 경로를 직접 비교했다.

이 구조에서는 다음 케이스가 깨진다.

1. `Zuul`/gateway route만 있고 명시적 HTTP client callsite가 없는 경우
2. consumer는 `/api/articles/**`를 노출하지만 provider endpoint는 `/{id}`, `/author/{authorId}`처럼 상대 경로만 가진 경우
3. pair-pack LLM이 외부 경로를 맞게 추출해도 provider 내부 endpoint와 직접 매칭되지 않아 `PATH_NOT_MATCHED`로 떨어지는 경우

## 2. 목표

1. 기존 direct callsite 기반 atomic 매칭은 그대로 유지한다.
2. direct match 실패 시에만 `Zuul route -> provider endpoint` 보조 해석을 수행한다.
3. config-only gateway pair도 deep inspection 대상으로 올려 atomic recovery 기회를 준다.
4. 기존 `RestTemplate`/`FeignClient`/`WebClient` 케이스는 회귀 없이 보존한다.

## 3. 구현 범위

### 3.1 Smart Pipeline
- consumer config에서 `zuul.prefix`, `zuul.routes.*.path`, `zuul.routes.*.serviceId`를 구조적으로 파싱한다.
- provider endpoint마다 external alias path를 계산한다.
- atomic 저장 시 우선순위는 아래와 같이 유지한다.
  1. direct exact/compatible callsite match
  2. route-aware alias match
  3. config snippet 기반 route recovery
  4. service fallback

### 3.2 Deep Inspection
- `PATH_NOT_MATCHED`, `NO_ENDPOINT_OBJECTS`, `INSUFFICIENT_CONTEXT`, low-confidence pair를 deep inspection 트리거에 포함한다.
- consumer에 gateway route만 있고 initial call이 비어도 deep inspection을 시도한다.
- tool surface에 `listGatewayRoutes`를 추가한다.

### 3.3 관측성
- deep inspection trace에 `pathNotMatched`, `noEndpointObjects` trigger를 추가한다.
- tool usage summary에 `gatewayRouteCalls`를 추가한다.
- atomic candidate metadata에 `inferenceKind: proxy_route`, `routeInterpretation`, `matchStrategy: route_mapping`을 기록한다.

## 4. 수용 기준

| ID | 기준 |
|----|------|
| T1 | direct callsite로 이미 매칭되는 기존 케이스는 이전과 동일하게 처리된다 |
| T2 | Zuul external path가 provider 상대 endpoint와 매칭되면 atomic candidate가 생성된다 |
| T3 | route-aware 해석으로도 복구 불가능하면 기존 `PATH_NOT_MATCHED` fallback을 유지한다 |
| T4 | gateway route만 있고 initial call이 비어도 deep inspection이 atomic recovery를 시도한다 |
| T5 | Approval/Smart summary에서 새로운 trigger/tool usage 값을 읽을 수 있다 |

## 5. 구현 결과

- `packages/inference/src/orchestration/smartPipeline.ts`
  - gateway route parser/alias matcher 추가
  - route-aware endpoint target 및 `proxy_route` metadata 저장
  - deep inspection trigger 확장, `listGatewayRoutes` tool 추가
- `apps/web/src/app/api/inference/smart/route.ts`
  - deep inspection trace/tool usage에 신규 필드 파싱 추가
- `apps/web/src/components/approval/approval-list.tsx`
  - trace viewer에 신규 trigger/tool usage 노출 추가

## 6. 검증

- inference unit test
  - Zuul external path -> provider endpoint 매칭
  - direct callsite 우선순위 보존
  - route miss fallback 유지
  - gateway-route-only deep inspection recovery
