# 91. Workspace Inference Relation Recovery Plan (2026-04-13)

상태: Proposed  
작성일: 2026-04-13

## 1. 배경 / 문제 정의

`/Users/spark/workspace`를 절대경로로 입력해도 프로젝트 스캔 자체는 정상 동작하지만,
`정적 분석`과 `Smart Proof Engine` 모두 관계(candidate)를 거의 만들지 못하는 문제가 확인되었다.

핵심 원인은 다음 두 축으로 정리된다.

1. **동적 HTTP URI/Host 패턴 비중이 매우 높음**
   - `.uri(variable)`, `baseUrl + PATH`, `UriComponentsBuilder...toUriString()` 패턴이 다수.
   - literal URL/경로 중심 추출만으로 provider/path closure가 자주 실패.
2. **config alias -> service 해석이 빈약함**
   - `${API_MISSION_MGT}` 같은 env placeholder 또는 getter 기반 baseUrl 패턴을
     실제 서비스로 연결하지 못해 `CONFIG_BINDING_MISSING`, `HOST_ALIAS_UNRESOLVED` frontier 누적.

또한 현재 제품 흐름에서 `정적 분석`도 proof 엔진 기반 실행 계약에 의존하므로,
proof closure 실패 시 두 모드 모두 결과가 0건에 수렴한다.

## 2. 목표

1. Proof-engine-first 원칙을 유지하면서도 dynamic/config-heavy workspace에서
   관계 복원율을 실질적으로 개선한다.
2. frontier가 발생하더라도 원인 분해와 후속 개선 포인트를 정량적으로 관측 가능하게 만든다.
3. 기본 truth path(닫힌 proof 후보)와 보조 경로(compat deterministic)를 명확히 분리한다.

## 3. 범위

### 포함
- Java/Kotlin HTTP signal 추출 보강 (dynamic/path/config metadata 보존 강화)
- alias binding 강화 (config key/getter -> service resolution)
- proof frontier closure 규칙 확장 (config/getter/path fragment 활용)
- 실행 레이어 관측치 확장 및 운영 가이드 업데이트

### 제외
- Smart validator 자체의 정책 변경 (risk가 큰 모델/정책 변경)
- 완전 자동 endpoint semantic matching (대규모 연구 과제)

## 4. 변경 계획 (Phase)

## Phase A. Config/Getter 기반 alias 해석 강화 (우선순위 P0)

### A-1. config key suffix -> service token 매핑 도입
- `makers.api.rbMissionMgt`, `subscriptionManager`, `apiSpaceMgt` 등
  서비스 의미가 있는 key suffix를 추출해 service token 후보군으로 정규화한다.
- 기존 host alias 매칭 실패 시 fallback으로 suffix 매칭을 수행한다.

### A-2. Java/Kotlin getter call에서 serviceNameHint 승격
- `apiConfig.getRbMissionMgt()`, `apiProperties.getSubscriptionManager()` 패턴을
  `serviceNameHint`/`configKeys`로 보존한다.
- 단순 `service` 키워드 포함 여부가 아니라 getter 명명 규칙(`getXxx`, `xxxManager`) 기반으로 확장.

### A-3. acceptance
- `CONFIG_BINDING_MISSING`, `HOST_ALIAS_UNRESOLVED` 비율이 baseline 대비 감소.
- 동일 workspace 재실행 시 closed atomic candidate 수 증가.

## Phase B. Dynamic URI partial evidence 보존 및 closure 보강 (우선순위 P1)

### B-1. baseUrl + path 조합 분해 보존
- `String uri = baseUrl + PATH`에서 host fragment/base var/path hint를 분리 저장.
- `UriComponentsBuilder` 체인에서 path segment 힌트를 loss 없이 저장.

### B-2. proof engine의 unresolved frontier 축소 규칙 추가
- `PATH_ONLY_TARGET_UNRESOLVED`에서
  - source service owner scope
  - alias 후보
  - provider endpoint inventory path fragment
  를 결합해 제한적 closure 시도.
- confidence gate를 둬 과도한 오탐을 방지.

### B-3. acceptance
- `DYNAMIC_URI_UNRESOLVED`, `PATH_ONLY_TARGET_UNRESOLVED`의 절대 건수는 유지될 수 있으나,
  closed 전환율(closed/total)이 baseline 대비 개선.

## Phase C. 운영 안전장치 및 관측 (우선순위 P1)

### C-1. run summary 지표 표준화
- 아래 지표를 run summary에 기본 노출:
  - `frontierReasonBreakdown`
  - `dynamicUriIntentCount`
  - `pathOnlyIntentCount`
  - `configBoundIntentCount`
  - `closedAtomicCount`

### C-2. compat deterministic mode 운영 가이드
- 기본값은 `false` 유지.
- 아래 조건에서만 옵트인 권장:
  - proof-only 결과가 연속 N회 0건
  - frontier breakdown 상 unresolved 비율이 임계치 초과

### C-3. acceptance
- 운영자가 단일 run에서 “왜 0건인지”를 reason breakdown으로 즉시 설명 가능.

## 5. 구현 순서 / 작업 항목

1. **P0 (1주)**: alias binding + getter hint 보강
   - extraction/alias unit test 추가
   - 대표 workspace fixture로 회귀 테스트 구성
2. **P1 (1주)**: dynamic/path partial evidence + proof closure rule 확장
   - proof engine regression test 추가
3. **P1 (0.5주)**: observability 및 운영 토글 가이드 정리
   - API 응답 스키마/문서 반영

## 6. 검증 계획

### 정량 KPI
- `closedAtomicCount` 증가율
- unresolved frontier reason 비율 변화
- smart run에서 `NO_FRONTIERS` 발생률 감소

### 회귀 검증
- 기존 proof-first workspace에서 precision 저하가 없는지 비교
- compat mode off 상태에서 기존 결과 호환성 유지

## 7. 리스크 및 대응

1. **오탐 증가 리스크**
   - 대응: closure 규칙에 confidence threshold와 owner scope 제한 적용
2. **성능 저하 리스크**
   - 대응: 새 매칭은 unresolved frontier에만 지연 적용(lazy fallback)
3. **운영 복잡도 증가**
   - 대응: run summary reason taxonomy를 고정해 해석 비용 최소화

## 8. 완료 정의 (DoD)

- 대표 문제 workspace에서 proof/smart 모두 관계 0건 상태가 유의미하게 완화된다.
- run summary만으로 unresolved 원인을 상위 3개 reason으로 설명할 수 있다.
- 문서/테스트/옵션 가이드가 함께 반영되어 재현 및 운영이 가능하다.
