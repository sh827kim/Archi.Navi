# 44. Query Engine Humanized Results SPEC

상태: Implemented
우선순위: S1
로드맵 범위: Query UX

## 1. 문제 정의

현재 `/query` 결과는 노드/엣지/경로/요약 JSON을 거의 원형 그대로 보여준다.
이 구조는 엔진 디버깅에는 유용하지만, 사람이 빠르게 이해하는 UX는 아니다.

주요 문제:
1. 결과 요약이 “무슨 뜻인지” 설명하지 않는다.
2. `DOMAIN_SUMMARY`는 JSON raw dump에 가깝다.
3. `PATH_DISCOVERY`, `IMPACT_ANALYSIS`, `USAGE_DISCOVERY` 모두 결과 해석 맥락이 부족하다.

## 2. 목표

1. query type별로 사람이 이해하기 쉬운 요약 표현을 제공한다.
2. “무엇을 찾았는지”와 “왜 중요한지”를 결과 상단에서 먼저 보여준다.
3. raw 데이터는 보조 상세로 내리고, 핵심 해석은 카드/리스트 중심으로 올린다.

## 3. 범위

### 3.1 포함
- type별 summary card
- humanized path / impact / usage / domain rendering
- raw JSON 제거 또는 보조 영역 이동

### 3.2 제외
- 그래프 시각화 신설
- query 결과 export

## 4. 기능 요구사항

1. 결과 상단에 type별 summary headline을 표시한다.
2. `PATH_DISCOVERY`는 경로를 단계형(stepper/timeline)으로 보여준다.
3. `IMPACT_ANALYSIS`는 직접 영향/간접 영향/총 노드 수를 먼저 보여준다.
4. `USAGE_DISCOVERY`는 “누가 사용 중인지” 목록을 우선 표시한다.
5. `DOMAIN_SUMMARY`는 domain 멤버/외부 연결/핵심 통계를 카드형으로 변환한다.

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | query type별 상단 요약이 표시된다 |
| T2 | DOMAIN_SUMMARY가 raw JSON 대신 구조화된 카드로 표시된다 |
| T3 | PATH_DISCOVERY가 단계형으로 렌더링된다 |
| T4 | raw node/edge 표는 보조 상세로 남는다 |

## 6. 검증 계획

- `src/__tests__/query-client.test.tsx`
