# 38. S1 Phase 2 UX 기반 구축 SPEC

상태: Implemented (2026-03-29)
우선순위: S1
로드맵 범위: `S1-7`, `S1-8`, `S1-9`

## 1. 문제 정의

현재 대시보드 UX는 워크스페이스 선택 직후 빈 그래프 화면으로 진입하고, 데이터가 없을 때 다음 행동이 분명하게 안내되지 않는다. 또한 사이드바가 고정폭이라 그래프 중심 화면의 가용 폭이 작다.

## 2. 목표

1. 워크스페이스 진입 후 현재 상태를 요약하는 홈 화면을 제공한다.
2. 주요 화면의 empty state에서 다음 행동을 즉시 실행할 수 있게 한다.
3. 사이드바를 축소/확장 가능하게 만들어 그래프 탐색 공간을 확보한다.

## 3. 범위

### 3.1 Dashboard Home
- URL: `/home`
- 홈은 선택된 워크스페이스의 운영 개요를 보여준다.
- 표시 항목:
  - 총 Object 수
  - 서비스 수
  - 도메인 수
  - 승인 대기 수: 관계 후보 + 도메인 후보
  - 최근 추론 실행 최대 5건 요약
  - 빠른 액션: 추론 실행, 코드 스캔, 승인 이동을 포함한 주요 이동 액션
- 워크스페이스 선택, 생성 완료, 온보딩 완료 시 기본 이동 경로를 `/home`으로 전환한다.

### 3.2 Empty State 가이드
- Architecture View:
  - 레이어/서비스 데이터가 없을 때 원인과 다음 행동을 안내한다.
  - 최소 2개 액션을 제공한다: `Object 목록`, `설정`
- Mapping Graph:
  - 현재 레벨에 데이터가 없을 때 `Object 목록`, `승인 대기` 등 실행 경로를 안내한다.
  - 기존 “샘플 넣기” 안내만 남겨두지 않고 제품 내부 흐름 기준 액션을 우선 노출한다.
- Approval:
  - 관계 후보/도메인 후보가 없을 때 현재 empty state를 유지하되, 관련 화면으로 이동하는 링크를 추가한다.

### 3.3 Sidebar Collapse
- 사이드바에 collapse/expand 토글을 제공한다.
- collapse 시 아이콘 중심 내비게이션으로 동작하고 active 상태를 유지한다.
- collapse 상태는 클라이언트 저장소에 유지한다.
- `홈` 항목을 사이드바와 커맨드 팔레트에 추가한다.

## 4. 비범위
- AI 고도화 항목(`S1-10` 이후)
- 채팅 기록 영속화
- 대형 그래프 컴포넌트 구조 분해

## 5. 수용 기준

1. 유효한 워크스페이스를 선택하면 사용자는 `/home`으로 진입할 수 있다.
2. `/home`은 현재 워크스페이스 기준 운영 요약과 빠른 액션을 제공한다.
3. Architecture/Mapping/Approval empty state에서 다음 행동이 명시되고 페이지 이동이 가능하다.
4. 사이드바 collapse/expand가 동작하며 새로고침 후에도 상태가 유지된다.
5. 관련 단위 테스트가 추가되고 통과한다.

## 6. 검증

- `apps/web/src/__tests__/dashboard-home.test.tsx`
- `apps/web/src/__tests__/dashboard-summary.route.test.ts`
- `apps/web/src/__tests__/sidebar.test.tsx`
- `apps/web/src/__tests__/approval-list.test.tsx`
- 필요 시 `apps/web/src/__tests__/layered-architecture-view.test.tsx`
- 필요 시 `apps/web/src/__tests__/rollup-graph.test.tsx`

검증 결과:
- `pnpm --filter @archi-navi/web exec vitest run src/__tests__/dashboard-home.test.tsx src/__tests__/dashboard-summary.route.test.ts src/__tests__/sidebar.test.tsx src/__tests__/approval-list.test.tsx src/__tests__/layered-architecture-view.test.tsx src/__tests__/rollup-graph.test.tsx`
  - `6 files, 35 tests passed`
- `pnpm --filter @archi-navi/web lint`
  - 통과
