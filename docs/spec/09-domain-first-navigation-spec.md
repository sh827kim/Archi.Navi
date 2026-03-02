# Domain-first Navigation SPEC (Roadmap 3-4)

- 작성일: 2026-03-02
- 상태: Active
- 대상: `apps/web/src/components/mapping/rollup-graph.tsx`
- 연계 문서: `../design/05-rollup-and-graph.md`, `../design/06-compound-view.md`

## 1. 목적
탐색 시작점을 Domain으로 고정해 대규모 시스템에서 상위 맥락을 먼저 파악하고, 단계적으로 세부(Service/Atomic)로 내려가는 탐색 흐름을 표준화한다.

## 2. 범위
1. 기본 진입 레벨을 `DOMAIN_TO_DOMAIN`으로 설정
2. 도메인 데이터 부재 시 `SERVICE_TO_SERVICE` fallback
3. 클릭 기반 drill-down
- Domain 클릭 → Service 레벨
- Service 클릭 → Atomic(Roll-down) 레벨
4. Breadcrumb + `상위로` 내비게이션

## 3. 기능 요구사항
1. 상태 모델
- `selectedDomain`
- `selectedService`
- `viewLevel`
- `expandedSet`

2. 전환 규칙
- Domain 미선택 상태: Domain 레벨만 직접 선택 가능
- Domain 선택 상태: Service 레벨 중심 탐색
- Service 선택 상태: Roll-down 확장/축소

3. 도메인 필터
- `object_domain_affinities` 기반 서비스 필터링
- affinity threshold는 설정값을 따른다.

## 4. 비기능 요구사항
1. 레벨 전환 시 불필요한 전체 재조회/재연산을 최소화한다.
2. breadcrumb 기반 복귀는 항상 결정론적이어야 한다.

## 5. 수용 기준
1. 도메인 데이터가 있으면 최초 레벨이 Domain으로 열린다.
2. 도메인 데이터가 없으면 Service 레벨로 자동 전환된다.
3. Domain/Service 클릭 drill-down과 `상위로` 복귀가 정상 동작한다.
4. 선택 도메인 외 서비스는 필터링된다.
