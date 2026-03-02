# Hub Node Management SPEC (Roadmap 3-2)

- 작성일: 2026-03-02
- 상태: Active
- 대상: `apps/web/src/components/mapping/rollup-graph.tsx`, `/api/rollups`
- 연계 문서: `../design/05-rollup-and-graph.md`

## 1. 목적
고차수(hub) 노드가 그래프 가독성을 저하시키는 문제를 해결하기 위해 hub 접기/펼치기 제어를 제공한다.

## 2. 범위
1. Hub 임계치 기반 노드 판별
2. UI 토글(`Hub 접기/펼치기`) 제공
3. Hub 노드 배지(in-degree) 시각화
4. 토글 상태에 따른 링크 필터링

## 3. 기능 요구사항
1. 판별 규칙
- 기준: `object_graph_stats.inDegree >= threshold`
- 기본 임계치: `50`
- 허용 범위: `5~500`

2. 데이터 계약
- `/api/rollups` 응답에 `graphStats[]` 포함
- 항목: `objectId`, `inDegree`, `outDegree`

3. UI 동작
- 토글 ON: hub 노드와 hub 관련 링크를 모두 숨긴다.
- 토글 OFF: 원본 그래프를 복원한다.
- 현재 hub 개수를 표시한다.

## 4. 비기능 요구사항
1. 토글 전환은 추가 API 호출 없이 클라이언트에서 즉시 반영한다.
2. 토글 동작은 view level 전환 시에도 일관된 상태를 유지한다.

## 5. 수용 기준
1. threshold 이상 노드가 hub로 판별되어 표시된다.
2. Hub 접기 ON 시 hub 노드/링크가 화면에서 제거된다.
3. Hub 접기 OFF 시 원복된다.
4. Domain/Service 레벨 전환 후에도 토글 상태가 유지된다.
