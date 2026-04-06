# 91. DB Scan Toggle SPEC

상태: Proposed
작성일: 2026-04-06

## 1. 목적

코드 스캔 시 DB 관련 code signal이 기본 활성화되어 모듈마다 `database` compound가 자동 생성되는 현상을 막기 위해,
DB 스캔을 명시적 옵션으로 전환한다.

## 2. 요구사항

### 2.1 사용자 설정
- 워크스페이스 온보딩 마법사의 코드 스캔 단계에서 `DB 스캔 활성화` 옵션을 제공해야 한다.
- 설정 화면의 코드 스캔 탭에서도 같은 옵션을 제공해야 한다.
- 옵션의 기본값은 `false`다.

### 2.2 저장/조회
- 워크스페이스 기본 추론 프로필은 스캔 설정을 저장해야 한다.
- 최소 계약:
  - `scanConfig.enableDbScan: boolean`
- `/api/inference/profiles/default` GET/PUT는 해당 필드를 직렬화/역직렬화해야 한다.

### 2.3 스캔 실행
- `/api/scan` 요청은 선택적으로 `enableDbScan?: boolean`를 받을 수 있어야 한다.
- 요청 본문에 값이 없으면 기본 프로필에 저장된 `scanConfig.enableDbScan`을 사용해야 한다.
- `enableDbScan=false`일 때 코드 스캔 bootstrap은 DB 관련 object를 생성하지 않아야 한다.
  - `database`
  - `db_table`
- `enableDbScan=true`일 때만 기존 DB bootstrap 경로를 허용한다.

## 3. 설계 제약
- 이번 변경은 “코드 스캔” 범위에 한정한다.
- 일반 inference run의 `modes: ['db']`나 도메인 추론용 `enabledLayers` 계약을 깨지 않는다.
- 추후 명시 compound 생성 기능과 충돌하지 않도록, 스캔 설정은 workspace-level default로 저장한다.

## 4. 수용 기준

| ID | 기준 |
|---|---|
| T1 | 마법사에서 DB 스캔 토글을 끄고 스캔 요청을 보내면 요청 본문에 `enableDbScan=false`가 포함된다 |
| T2 | 설정 화면에서 DB 스캔 토글 저장 후 재진입 시 같은 값이 복원된다 |
| T3 | `/api/scan`은 요청 본문에 값이 없을 때도 기본 프로필의 `scanConfig.enableDbScan`을 사용한다 |
| T4 | `enableDbScan=false`일 때 bootstrap 경로에서 `database`/`db_table` 생성 분기를 타지 않는다 |
| T5 | `enableDbScan=true`일 때 기존 DB bootstrap 경로가 유지된다 |

## 5. 테스트
- settings client: scanConfig 로드/저장
- onboarding wizard: 스캔 요청 본문 검증
- scan route: 기본 프로필 fallback + bootstrap 옵션 전달
- inference bootstrap/code-based: DB signal on/off 분기
