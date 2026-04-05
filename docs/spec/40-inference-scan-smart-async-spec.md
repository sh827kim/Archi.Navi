# 40. Inference Scan Bootstrap + Smart Async SPEC

상태: Implemented (부분 Legacy 포함, 2026-04-05 기준)
우선순위: S1
로드맵 범위: 정적 추론 안정화 / 스캔 UX / Smart Pipeline 운영 UX

현행 메모:
- `/api/inference/smart`의 비동기 실행 경로는 유지되지만, 현재 Smart 실행 계약은 pair-first `analysisMode`가 아니라 proof-engine 기반 wrapper를 사용한다.
- 따라서 이 문서에서 유효한 범위는 `scan bootstrap`, `repoRoot 안정화`, `async run queueing`이며, 구식 Smart 분석 모드 계약은 더 이상 기준이 아니다.

## 1. 문제 정의

1. 사용자가 워크스페이스 폴더를 등록했더라도 정적 추론이 로컬 `repoRoot`를 찾지 못해 실패할 수 있다.
2. 코드 스캔 직후에는 서비스만 등록되고 atomic object는 비어 있어 첫 탐색 경험이 끊긴다.
3. Smart 추론은 브라우저 요청이 완료될 때까지 동기적으로 대기해야 한다.
4. 사용자 테스트 시나리오 문서가 공개 문서 영역에 있다.

## 2. 목표

1. 기본 정적 추론 허용 경로에 사용자 홈 디렉토리를 포함해 로컬 워크스페이스를 수용한다.
2. 코드 스캔 완료 시 1차 코드 분석을 수행해 atomic object bootstrap을 끝낸다.
3. Smart 실행을 비동기로 큐잉하고 완료/실패 알림을 제공한다.
4. 사용자 테스트 시나리오 문서를 `local-only-docs`로 이동한다.

## 3. 범위

### 3.1 정적 추론 repoRoot 안정화
- `/api/inference/run`
- `packages/inference/src/orchestration/inferenceRuns.ts`
- fallback allowed roots에 `homedir()`를 포함한다.

### 3.2 코드 스캔 후 1차 분석
- `/api/scan`
- dry-run이 아닐 때, 등록된 로컬 프로젝트 경로에 대해:
  - `extractCodeSignalsWithEngine`
  - `inferRelationsFromCodeSignals`
- atomic bootstrap 결과 요약을 scan 응답에 포함할 수 있다.
- 일부 프로젝트 분석 실패가 전체 스캔 실패로 번지지 않도록 warning으로 축약한다.

### 3.3 Smart 비동기 실행
- `/api/inference/smart`
- `async` 요청 모드를 추가한다.
- async 실행 시 `inference_runs`/`inference_run_sources`/`inference_run_events`를 사용해 상태를 저장한다.
- Approval UI는 Smart run queueing 후 상태 polling으로 완료 알림을 표시한다.

### 3.4 문서 위치 조정
- `docs/06-s1-phase2-user-test-guide.md`를 `local-only-docs`로 이동한다.
- 공개 문서 인덱스에서는 제거한다.

## 4. 비범위

- Smart 분산 워커/영속 큐
- 웹소켓/푸시 알림
- 운영체제 네이티브 알림 연동

## 5. 수용 기준

1. 홈 디렉토리 하위 워크스페이스 폴더를 스캔한 뒤 정적 추론이 `repoRoot 없음`으로 실패하지 않는다.
2. 코드 스캔 완료 후 atomic object가 바로 생성된다.
3. Smart 실행은 즉시 queue 응답을 반환하고, UI는 완료/실패 시 알림을 띄운다.
4. 사용자 테스트 시나리오 문서는 `local-only-docs`에만 존재한다.

## 6. 검증

- `pnpm --filter @archi-navi/web exec vitest run src/__tests__/scan.route.test.ts src/__tests__/smart.route.test.ts src/__tests__/approval-list.test.tsx src/__tests__/inference-run.route.test.ts`
- 결과: `4 files, 47 tests passed`
