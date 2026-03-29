# 42. Agent-Assisted Smart Atomic SPEC

상태: Implemented
우선순위: S1
로드맵 범위: Smart Pipeline 정확도 개선

## 1. 문제 정의

현재 Smart Pipeline은 service-to-service pair 추론과 atomic endpoint 판별을 모두 동일한 LLM/prompt 흐름에서 처리한다.

이 구조는 아래 상황에서 정확도가 급격히 떨어진다.

1. gateway/proxy route만 있고 명시적 HTTP client 코드가 없는 경우
2. wrapper/util/config를 여러 파일 따라가야 하는 경우
3. prefix strip, path rewrite, service discovery alias를 해석해야 하는 경우

결과적으로 pair는 맞지만 atomic에서는 `PATH_NOT_MATCHED`, `NO_ENDPOINT_OBJECTS`, `INSUFFICIENT_CONTEXT` fallback 비율이 높다.

## 2. 목표

1. service-to-service pair 추론은 현재 Smart 경로를 유지한다.
2. atomic 추론은 pair별 Agent escalation으로 분리한다.
3. Agent는 pair-local budget 안에서만 동작해 비용과 재현성을 통제한다.

## 3. 구현 범위

### 3.1 유지 범위
- Phase 1 OpenAPI import
- Phase 1.5 code expose endpoint bootstrap
- Phase 2 config -> LLM -> service pair 추론

### 3.2 변경 범위
- Phase 3 atomic inference를 `pair_pack` + `agent_assisted` + `full_agent` 모드로 분리
- unresolved/low-confidence pair에 대해 pair-local Agent step 실행
- Approval UI와 `/api/inference/smart` 요청/summary에 analysis mode 및 agent 통계를 노출

## 4. 권장 아키텍처

```text
Phase 1   OpenAPI import
Phase 1.5 Code expose bootstrap
Phase 2   Config -> LLM -> service pairs
Phase 3a  Fast path atomic inference (기존 pair evidence pack)
Phase 3b  Agent-assisted atomic deep inspection (선별 pair만)
```

### 4.1 Phase 3a Fast Path
- 기존 pair-scoped evidence pack을 사용한다.
- atomic 확정 시 즉시 저장한다.
- 실패 시 fallback reason을 기록하되, 일부 pair는 Agent path 대상으로 넘긴다.

### 4.2 Phase 3b Agent Path
- 실행 조건:
  - `PATH_NOT_MATCHED`
  - `NO_ENDPOINT_OBJECTS`
  - `INSUFFICIENT_CONTEXT`
  - pair confidence가 threshold 미만
- 입력:
  - consumer/provider 서비스명
  - 기존 evidence pack
  - provider endpoint 목록
  - config route snippet
- 출력:
  - recovered atomic call 후보
  - recovery rationale
  - tool usage trace

## 5. Agent Tool 설계

Agent는 아래 읽기 전용 툴만 사용한다.

1. `searchFiles(serviceId, query)`
2. `readFile(path, start?, end?)`
3. `listServiceEndpoints(serviceId)`
4. `getServiceConfigSnippets(serviceId)`
5. `listGatewayRoutes(serviceId)`
6. `explainRouteToEndpoint(route, endpoints)`

제약:
- pair당 search/read/tool-call budget 상한
- repo 전체 무제한 탐색 금지
- 저장 쓰기는 금지, 결과 제안만 반환

## 6. 저장 규칙

1. Agent가 recovered atomic candidate를 반환하면 기존 normalization 레이어가 검증 후 저장한다.
2. 검증 통과 시 `service -> api_endpoint` candidate 생성
3. 검증 실패 시 기존 service fallback 유지
4. metadata에 다음을 남긴다.
   - `analysisMode: "agent_deep_inspection"`
   - `agentRecovery: true`
   - `routeInterpretation?`
   - `toolUsage`

## 7. 관측 지표

응답/실행 상세에 아래를 추가한다.

1. `agentEscalatedPairCount`
2. `agentRecoveredAtomicCount`
3. `agentFailedPairCount`
4. `agentToolUsageSummary`

## 8. 수용 기준

| ID | 기준 |
|----|------|
| T1 | service pair 추론은 기존 경로를 유지한다 |
| T2 | atomic 판별 실패 pair만 Agent path를 탄다 |
| T3 | Agent는 pair-local budget 안에서만 동작한다 |
| T4 | gateway/proxy route만 있는 경우에도 provider endpoint recovery를 시도할 수 있다 |
| T5 | Agent 실패 시 기존 service fallback 결과는 유지된다 |
| T6 | 실행 상세에서 Agent escalation/recovery 통계를 확인할 수 있다 |

## 9. 구현 결과

- `packages/inference/src/orchestration/smartPipeline.ts`
  - `SmartAtomicAnalysisMode` 추가
  - `agent_assisted`: pair fallback/low-confidence 케이스만 Agent escalation
  - `full_agent`: Phase 2 이후 atomic 판별 전부 Agent가 수행
- `apps/web/src/app/api/inference/smart/route.ts`
  - `analysisMode` 입력 지원
  - summary에 `analysisMode`, `agentEscalatedPairCount`, `agentRecoveredAtomicCount`, `agentFailedPairCount`, `agentToolUsageSummary` 추가
- `apps/web/src/components/approval/approval-list.tsx`
  - `Smart Pair-pack`, `Smart Agent-assisted`, `Smart Full-agent` 실행 모드 추가
  - trace viewer와 success toast에 agent 메트릭 표시

## 10. 검증

- Smart pipeline unit test에 `service pair 유지 + atomic only escalation` 케이스 추가
- gateway route 기반 recovery fixture 추가
- Approval UI summary/trace 노출 회귀 테스트 추가
