# Inference Engine Recommendation Triage (2026-04-06)

## 분류 기준
- **작업 필요**: 현행 설계(`proof-engine-first`, frontier-local Smart, atomic closure)와 정합하며 실행 시 품질/관측성 개선 효과가 큰 항목.
- **거부/비채택**: 설계 철학과 충돌하거나, 기본 경로로 채택 시 precision/해석 일관성을 훼손하는 항목.

## 작업 필요 항목

### 1) 문서 계약 재정렬 (권고안 A)
- `docs/design/03-inference-engine.md`와 `docs/spec/12-inference-run-orchestration-spec.md`에
  - 기본 run 경로(proof-engine-first)
  - compat deterministic 경로(보조/운영 모드)
  를 명시적으로 분리.
- 기대 효과: 설계 해석 충돌 최소화, 변경 시 버그/계약변경 구분 명확화.

### 2) scan/run bootstrap 공통화 (권고안 B)
- `/api/scan`과 `/api/inference/run`이 동일한 bootstrap 모듈을 사용하도록 정리.
- 최소 책임: endpoint/topic/queue bootstrap + proof 입력 상태 정규화.
- 기대 효과: 실행 진입점별 품질 편차 축소.

### 3) 동적 URI 친화적 HTTP 신호 추출 강화 (권고안 C)
- `RestClient/WebClient/UriComponentsBuilder/baseUrl+path/설정 바인딩 조합` 패턴 확장.
- 완전 매칭 불가 시에도 host/path/method/dynamic 플래그를 partial evidence로 저장.
- 기대 효과: Kafka 편향 완화, HTTP recall 개선.

### 4) frontier reason 확장 및 route-family 해석 강화 (권고안 D)
- frontier reason을 1급 상태로 확장(예: `DYNAMIC_URI_UNRESOLVED`, `METHOD_UNKNOWN` 등).
- route-family root에서 alias/path family/candidate endpoint family 보존.
- 기대 효과: no-result 원인 설명력/Smart 개입 지점 정밀도 개선.

### 5) compat mode의 선택적 제공 (권고안 E)
- legacy deterministic candidate generator는 **명시적 플래그/서브타입**으로만 활성화.
- 기본 결과 집계와 compat 결과 집계를 분리.
- 기대 효과: 운영 ROI 확보 + 기본 truth path 보호.

### 6) 운영 메트릭 확장 (권고안 F)
- bootstrap/intent/closure/frontier 계층별 지표 추가.
- `frontierReasonBreakdown`, `dynamicUriIntentCount` 등 원인 분해 지표 강화.
- 기대 효과: workspace별 병목 구간 진단 가능.

## 거부/비채택 항목

### 1) pair-first 기본 경로 복귀
- 사유: intent-centric proof engine 핵심 방향과 충돌.

### 2) service-level fallback candidate 재도입
- 사유: precision 저하 및 candidate fan-out 재발.

### 3) Smart 역할 확대(직접 candidate 생성/validator 우회/pair truth 선언)
- 사유: Smart의 frontier-local patcher 역할을 벗어남.

### 4) partial evidence 조기 skip 유지
- 사유: Spring/Gradle + dynamic URI 환경에서 recall 저하를 구조적으로 고착.

## 제안 우선순위
1. 문서 정렬(Phase 0)
2. 공통 bootstrap(Phase 1)
3. 추출 보강(Phase 2)
4. frontier 확장(Phase 3)
5. compat mode 운영 결정(Phase 4)


## 진행 현황 업데이트 (2026-04-06)

### Phase 0 수행 결과
- [x] `docs/design/03-inference-engine.md`에 기본 커널(`proof-engine-first`)과 compat 경로 분리를 명시.
- [x] `docs/spec/12-inference-run-orchestration-spec.md`에 기본/호환 실행 계약, 분리 집계 규칙을 반영.

### 다음 실행 예정
- [ ] Phase 1: scan/run 공통 bootstrap 모듈화 설계 및 인터페이스 확정
- [ ] Phase 2: 동적 URI 추출 규칙 확장 및 partial evidence 저장 포맷 구현
- [ ] Phase 3: frontier reason 확장 + route-family proof 상태 보강
- [ ] Phase 4: compat mode 운영 노출 범위/UX 정책 확정
