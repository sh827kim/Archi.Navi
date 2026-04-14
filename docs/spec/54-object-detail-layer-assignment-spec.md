# 54. Object Detail Layer Assignment SPEC

- 상태: Current
- 작성일: 2026-04-05

## 배경

아키텍처 뷰는 `object_layer_assignments`를 기준으로 COMPOUND Object를 레이어에 배치해 렌더링한다. 하지만 현재 `/services`의 Object 상세 패널에서는 레이어 assignment를 확인하거나 변경할 수 없어서, 탐지된 서비스의 레이어를 UI에서 보정하는 경로가 부족하다.

## 목표

- `/services` Object 상세 패널에서 COMPOUND Object의 현재 레이어를 확인할 수 있어야 한다.
- 사용자는 상세 패널에서 레이어를 선택해 배치하거나, 기존 배치를 해제할 수 있어야 한다.

## 요구사항

### 1. 표시 조건

- 대상은 `granularity === 'COMPOUND'` Object다.
- 상세 패널의 기본 정보 아래에 `아키텍처 레이어` 섹션을 노출한다.

### 2. 데이터 로드

- 상세 패널 open 시 아래 데이터를 조회한다.
  - `GET /api/layers?workspaceId={id}`
  - `GET /api/layers/assignments?workspaceId={id}`
- 현재 object의 assignment를 찾아 선택 상태를 초기화한다.

### 3. 편집 동작

- 사용자는 드롭다운에서 다음 중 하나를 선택할 수 있다.
  - `레이어 없음`
  - 현재 workspace의 enabled layer 목록
- 레이어 선택 시:
  - `POST /api/layers/assignments`
  - body: `{ workspaceId, objectId, layerId }`
- 레이어 없음 선택 시:
  - `DELETE /api/layers/assignments?workspaceId={id}&objectId={id}`

### 4. UI 동작

- 저장 중에는 드롭다운을 비활성화한다.
- 레이어가 하나도 없으면 드롭다운을 비활성화하고 안내 문구를 보여준다.
- 저장 성공 시 상세 패널 로컬 상태를 즉시 갱신한다.

## 비범위

- 아키텍처 뷰 페이지 내 직접 assignment 편집
- bulk assignment
- 레이어 생성/정렬 UI 개선

## 검증

- 상세 패널이 현재 레이어를 렌더링해야 한다.
- 레이어 변경 시 assignment POST가 호출돼야 한다.
- `레이어 없음` 선택 시 assignment DELETE가 호출돼야 한다.
