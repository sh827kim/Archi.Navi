# 43. Inference Run Ops UX SPEC

상태: Implemented
우선순위: S1
로드맵 범위: 추론 운영 UX

현행 메모:
- 현재 운영 화면의 Smart 요약은 pair-first `analysisMode` 통계가 아니라 proof-engine run summary와 smart/proof 관련 메타데이터를 기준으로 읽는다.
- 이 문서의 핵심 계약은 실행 상태 가시화, source 상태 정합성, polling 갱신 UX다.

## 1. 문제 정의

현재 `/inference-runs`는 목록, 상세, 취소/재시도 기본 동작은 있으나 운영 화면으로는 부족하다.

주요 문제:
1. Smart run 결과가 카드 요약에 거의 드러나지 않는다.
2. source 상태 표시가 실제 run/source 상태 enum과 어긋난다.
3. RUNNING/QUEUED 상태 추적, 실패 원인 파악, 결과 비교가 불편하다.

## 2. 목표

1. standard run과 smart run 모두 동일한 화면에서 이해 가능하게 보여준다.
2. run 결과 요약, source 상태, 이벤트 로그를 운영자 관점에서 빠르게 읽을 수 있게 한다.
3. 실행 중 상태는 사용자가 새로고침을 반복하지 않아도 추적 가능해야 한다.

## 3. 범위

### 3.1 포함
- `InferenceRunList` 카드 요약 개선
- smart summary 표시
- source status badge 정정
- RUNNING/QUEUED auto refresh
- 실패/경고/생성 후보 수 가독성 개선

### 3.2 제외
- 별도 비교 화면
- server-side pagination
- 실행 diff/history compare

## 4. 기능 요구사항

1. 카드 요약은 아래를 우선 표시한다.
   - 실행 상태
   - 모드
   - 생성 후보 수
   - Smart run일 경우 proof/smart 요약, 경고, 후보 생성 결과
2. 상세 패널은 아래를 포함한다.
   - source별 상태, resolved repo root, message
   - 이벤트 로그
   - warnings/errors 요약
3. source status badge는 실제 enum(`QUEUED/RUNNING/SUCCEEDED/FAILED/SKIPPED`) 기준으로 렌더링한다.
4. 목록에 RUNNING/QUEUED 항목이 있으면 주기적으로 자동 새로고침한다.

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | Smart run의 smartSummary가 카드 요약에 노출된다 |
| T2 | source status badge가 실제 상태 enum과 일치한다 |
| T3 | 실행 중 항목이 polling으로 갱신된다 |
| T4 | 상세 패널에서 resolved repo root/message를 볼 수 있다 |

## 6. 검증 계획

- `src/__tests__/inference-run-list.test.tsx`
- 필요 시 E2E `/inference-runs` 시나리오 보강
