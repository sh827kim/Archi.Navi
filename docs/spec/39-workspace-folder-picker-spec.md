# 39. Workspace Folder Picker SPEC

상태: Implemented (2026-03-29)
우선순위: S1
로드맵 범위: 온보딩 / 스캔 설정 사용성 개선

## 1. 문제 정의

워크스페이스 생성과 코드 스캔 설정에서 로컬 경로를 직접 입력해야 한다. 사용자는 절대 경로를 기억하거나 복사해야 하며, 오타가 나기 쉽고 온보딩 진입 장벽이 높다.

## 2. 목표

1. 로컬 경로 기반 스캔 모드에서 폴더 탐색 후 선택할 수 있는 UI를 제공한다.
2. 동일한 탐색 경험을 온보딩과 설정 화면 양쪽에 재사용한다.
3. 기존 수기 입력과 자동완성은 유지한다.

## 3. 범위

### 3.1 Path Picker Dialog
- 대상: `local`, `workspace-dir` 스캔 모드
- 기능:
  - 현재 경로 표시
  - 상위 폴더 이동
  - 하위 디렉토리 목록 조회 및 선택
  - 선택한 경로를 입력 필드에 반영
  - 수동 입력값을 초기 탐색 위치로 사용

### 3.2 Workspace Onboarding
- 코드 스캔 단계의 입력 필드 옆에 `폴더 선택` 버튼을 추가한다.
- `GitHub 레포`, `GitHub Org` 모드에서는 버튼을 노출하지 않는다.

### 3.3 Settings Scan
- 설정의 코드 스캔 입력 필드 옆에 `폴더 선택` 버튼을 추가한다.
- 기존 최근 경로 / 자동완성 드롭다운은 유지한다.

## 4. 비범위

- 운영체제 네이티브 파일 선택기 연동
- 파일 단위 선택
- 즐겨찾기/핀 고정

## 5. 수용 기준

1. 사용자는 온보딩에서 폴더 탐색 후 스캔 경로를 선택할 수 있다.
2. 사용자는 설정 화면에서도 동일한 방식으로 경로를 선택할 수 있다.
3. 로컬 경로 모드가 아닐 때는 폴더 선택 UI가 노출되지 않는다.
4. 기존 수기 입력 기반 흐름은 그대로 동작한다.
5. 관련 단위 테스트가 추가되고 통과한다.

## 6. 검증

- `apps/web/src/__tests__/path-picker-dialog.test.tsx`
- `apps/web/src/__tests__/workspace-onboarding-wizard.test.tsx`
- `apps/web/src/__tests__/settings-client.test.tsx`

검증 결과:
- `pnpm --filter @archi-navi/web exec vitest run src/__tests__/fs-browse.route.test.ts src/__tests__/path-picker-dialog.test.tsx src/__tests__/workspace-onboarding-wizard.test.tsx src/__tests__/settings-client.test.tsx`
  - `4 files, 8 tests passed`
