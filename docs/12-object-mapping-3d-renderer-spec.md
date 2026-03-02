# 12. Object Mapping 3D Renderer SPEC (Roadmap 3-7)

- 작성일: 2026-03-02
- 상태: Draft (구현 기준)
- 대상: `apps/web/src/components/mapping/rollup-graph.tsx`

## 1. 목적
Object Mapping 화면의 렌더러를 3D(`3d-force-graph`)로 단일화해 대규모 그래프 탐색성(회전/줌/깊이 분리)을 개선한다.

## 2. 요구사항
1. Object Mapping 렌더러는 3D만 제공한다(2D 토글 제거).
2. 기존 핵심 기능(레벨 전환/Domain-first/Roll-down/Hub 토글)은 유지한다.
3. 3D 모드는 `3d-force-graph` 기반으로 구현한다.
4. WebGL 미지원 환경에서는 안내 메시지를 노출한다.

## 3. 핵심 기능 동등성 범위
- 뷰 레벨 전환
- Domain-first drill-down 흐름
- Hub 접기/펼치기
- Roll-down 패널 데이터 표시
- 상위로/모두 접기 동작

## 4. 설계

### 4.1 데이터 흐름
- 기존 fetch/filter(rollup + relation + hub filtering + expanded set)는 공통으로 유지
- 3D 렌더러는 준비된 `nodes/links`를 소비한다.

### 4.2 3D 렌더러 컴포넌트
- 파일: `rollup-graph-3d.tsx`
- 입력:
  - `nodes[]` (`id`, `label`, `color`, `radius`, `isHub`, `objectType`)
  - `links[]` (`source`, `target`, `relationType`, `color`, `isContains`)
- 동작:
  - 노드 클릭 콜백 전달
  - 더블클릭 시 카메라 포커스
  - 배경 클릭 콜백 지원

## 5. 수용 기준
1. `/mapping-graph` 진입 시 3D 렌더러가 기본으로 표시된다.
2. `2D(D3)` 선택 UI가 노출되지 않는다.
3. 노드 클릭 기반 drill-down/roll-down이 3D에서도 동작한다.
4. WebGL 미지원 환경에서 fallback 메시지가 노출된다.
5. 기존 e2e(허브/프로그레시브/domain-first)가 회귀 없이 통과한다.
