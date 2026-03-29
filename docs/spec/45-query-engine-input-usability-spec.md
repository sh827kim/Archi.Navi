# 45. Query Engine Input Usability SPEC

상태: Implemented
우선순위: S1
로드맵 범위: Query UX

## 1. 문제 정의

현재 `/query` 입력 UX는 사용자가 편하게 쓰기 어렵고, 실제 요청 계약도 일부 어긋나 있다.

주요 문제:
1. `IMPACT_ANALYSIS`, `USAGE_DISCOVERY` payload가 코어 계약과 불일치한다.
2. object picker가 한글 IME 입력 중 remount될 가능성이 높다.
3. 모든 picker가 검색 상태를 공유해 선택 흐름이 혼란스럽다.

## 2. 목표

1. UI payload와 query engine 계약을 일치시킨다.
2. 한글/IME 입력이 안정적으로 동작하게 한다.
3. object 선택 UX를 query type별 목적에 맞게 단순화한다.

## 3. 범위

### 3.1 포함
- query payload 계약 수정
- ObjectPicker 분리
- picker별 독립 검색 상태
- query type별 입력 문구/도움말 개선

### 3.2 제외
- 서버 검색형 combobox 전환
- 자연어 query builder

## 4. 기능 요구사항

1. `IMPACT_ANALYSIS`는 `targetObjectId`, `maxDepth`를 보낸다.
2. `USAGE_DISCOVERY`는 `objectId`를 보낸다.
3. ObjectPicker는 독립 컴포넌트로 분리한다.
4. picker마다 검색 상태가 독립적이어야 한다.
5. 입력 라벨은 사용자 목적 중심 문구를 사용한다.

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | IMPACT_ANALYSIS payload가 엔진 계약과 일치한다 |
| T2 | USAGE_DISCOVERY payload가 엔진 계약과 일치한다 |
| T3 | picker 입력 중 리렌더로 인한 값 끊김이 없다 |
| T4 | 기존 query-client 테스트가 계약 기준으로 갱신된다 |

## 6. 검증 계획

- `src/__tests__/query-client.test.tsx`
- 필요 시 IME 재현용 E2E 추가
