# 29. Approval Mapping UI Consistency SPEC

## 배경
- Approval 화면의 COMPOUND→COMPOUND 후보는 세부 매핑 시트를 통해 endpoint 단위로 분해 승인한다.
- 이 흐름은 비동기 endpoint 조회와 부분 성공/0건 성공 응답을 모두 처리해야 한다.

## 요구사항
1. 사용자가 다른 후보로 빠르게 전환해도, 이전 후보의 늦은 endpoint 조회 응답이 현재 시트를 덮어쓰면 안 된다.
2. `map-endpoints` 응답의 `createdRelationCount`가 0이면 원본 후보는 여전히 `PENDING`으로 취급해야 한다.
3. 프론트는 0건 응답 시 후보를 목록에서 제거하지 않아야 하며, 사용자가 즉시 재시도할 수 있어야 한다.

## 구현 규칙
- 세부 매핑 endpoint fetch는 최신 요청만 반영한다.
- 시트를 닫거나 다른 후보를 열면 이전 요청은 무효화한다.
- 후보 제거와 시트 종료는 `createdRelationCount > 0`일 때만 수행한다.
- `createdRelationCount = 0`이면 경고 토스트를 보여주고 현재 매핑 컨텍스트를 유지한다.

## 검증 기준
- 후보 A의 endpoint 응답이 늦게 도착해도, 이미 열린 후보 B의 endpoint 목록은 바뀌지 않는다.
- 0건 매핑 응답 뒤에도 후보 수와 후보 카드가 그대로 유지된다.
- 위 두 동작은 `apps/web` 단위 테스트로 회귀 고정한다.
