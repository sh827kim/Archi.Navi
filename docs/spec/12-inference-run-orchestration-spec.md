# 12. 추론 실행 오케스트레이션 (SPEC) (Roadmap 2-6)

상태: Implemented (Phase 1) + Contract Alignment (Phase 0)
작성일: 2026-03-02
최종 갱신: 2026-04-06

## 1. 목적
`/api/inference/run`의 단발성 동기 실행을 보완하기 위해, 실행 이력/상태 추적이 가능한 비동기 오케스트레이션 경로를 제공한다.

또한 제품 기본 경로를 `proof-engine-first`로 명시하고, deterministic 후보 생성기는 bootstrap/compat 경로로 분리해 운영 계약의 해석 불일치를 줄인다.

## 2. 범위
- 신규 API:
  - `POST /api/inference/runs` (비동기 실행 생성)
  - `GET /api/inference/runs` (실행 목록 조회)
  - `GET /api/inference/runs/:id` (실행 상세 조회)
- 신규 데이터 모델:
  - `inference_runs`
  - `inference_run_sources`
  - `inference_run_events`
- 기존 `POST /api/inference/run`은 quick run 용도로 유지한다.

## 3. 실행 계약

### 3.1 요청 모델 (`POST /api/inference/runs`)
- `workspaceId: string` (필수)
- `modes?: string[]` (`config|code|db`, 기본 `['config','db']`)
- `codeEngine?: string` (`ast|regex|hybrid|auto`)
- `incremental?: boolean` (기본 `true`)
- `sources?: [{ type, ref, metadata? }]`
  - `type`: `local|githubRepo|githubOrg`
  - `ref`: 경로/식별자
- `repoRoots?: string[]` (`local` source 축약 입력)
- `useServiceMetadataPaths?: boolean` (기본 `true`)
- `idempotencyKey?: string` (중복 실행 완화)

### 3.2 커널/호환 경로 계약 (Phase 0 정렬)
- 기본 실행 커널은 `proof-engine-first`다.
- deterministic 후보 생성기(`inferRelationsFromConfig`, `inferRelationsFromCodeSignals`, `bindConfigToCodeEndpoints`)는 기본 truth path가 아니다.
- deterministic 후보 생성기 재연결은 compat 모드에서만 허용한다.
  - 예시 플래그: `compatDeterministicCandidates: true`
- compat 모드 활성화 시 결과와 통계는 proof/compat를 분리해 노출해야 한다.
  - 예시: `summary.proofCandidatesCreated`, `summary.compatCandidatesCreated`
  - 예시 warning: `compat mode enabled`

### 3.3 상태 모델
- `QUEUED`
- `RUNNING`
- `SUCCEEDED`
- `FAILED`
- `CANCELED` (향후)

### 3.4 소스 상태 모델
- `QUEUED`
- `RUNNING`
- `SUCCEEDED`
- `FAILED`
- `SKIPPED`

## 4. 처리 규칙 (Phase 1 + Phase 0 Alignment)
1. `POST /api/inference/runs`는 실행 레코드를 만들고 `202`를 반환한다.
2. 생성 직후 백그라운드 실행을 시작한다.
3. `config/code` 모드에는 최소 1개의 `local` source가 필요하다.
4. `githubRepo/githubOrg`는 `gh` CLI를 통해 임시 디렉토리로 clone 후 local source로 실행한다.
5. `db` 모드는 source 없이도 실행 가능하다.
6. 실행 중 경고/오류는 run row와 event log에 모두 저장한다.
7. run 시작 시 공통 bootstrap(endpoint/topic/queue + proof 입력 정규화)을 먼저 수행한다.
8. 기본 candidate 생성은 proof closure 결과만 사용한다.
9. compat 모드가 활성화된 경우에만 deterministic 후보 생성기를 추가 실행하고, 결과를 별도 집계한다.

## 5. 응답 계약

### 5.1 `POST /api/inference/runs`
- `202 Accepted`
- `{ ok, runId, status, requestedModes, sourceSummary }`

### 5.2 `GET /api/inference/runs`
- query: `workspaceId`(필수), `status?`, `limit?`
- `{ ok, items: InferenceRun[] }`

### 5.3 `GET /api/inference/runs/:id`
- query: `workspaceId`(필수)
- `{ ok, run, sources, events }`

## 6. 데이터 모델

### 6.1 `inference_runs`
- 요청 파라미터 스냅샷, 상태, 시도 횟수, 집계 stats, warnings/errors, 시작/종료 시각 저장
- compat 모드 사용 여부와 분리 집계 가능한 summary 필드를 지원한다.

### 6.2 `inference_run_sources`
- 실행에 사용된 소스 목록/상태/해석된 경로/메시지 저장

### 6.3 `inference_run_events`
- 상태 전이/경고/오류 이벤트를 append-only 로그로 저장

## 7. 수용 기준
1. 실행 생성 후 목록/상세에서 상태 전이(`QUEUED→RUNNING→(SUCCEEDED|FAILED)`)를 조회할 수 있다.
2. local source + config 모드 실행이 성공하면 relation 후보가 생성되고 run status가 `SUCCEEDED`가 된다.
3. 미지원 source만 있는 config/code 실행은 source `SKIPPED`, run `FAILED`로 기록된다.
4. 경고/오류가 `inference_runs.warnings/errors`와 `inference_run_events`에 함께 남는다.
5. 기본 run에서 candidate summary는 proof 기반 집계를 기준으로 계산된다.
6. compat 모드 실행 시 proof/compat 집계가 분리되어 조회된다.

## 8. 후속 범위 (Phase 1 이후)
- GitHub API 기반 레포 선택/필터 고도화(현재는 `gh repo list` + clone)
- 재시도(backoff)와 취소 API
- 실행 큐/워커 분리
- 운영 UI 상태 카드/지표 대시보드
