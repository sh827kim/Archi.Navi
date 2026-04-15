# 52. Embedded Postgres Runtime Migration SPEC

상태: Implemented (2026-04-05)
우선순위: S1
로드맵 범위: 개발 환경 안정화 / DB 런타임 전환

> Note (2026-04-05): 현재 구현 기준 런타임은 `embedded-postgres` 기본 + `DATABASE_URL` 외부 PostgreSQL override다.
> 구현 기준 파일은 `packages/db/src/runtime-config.ts`, `packages/db/src/embedded-postgres-runtime.ts`, `packages/db/src/client.ts`다.

## 1. 문제 정의

1. Archi.Navi의 로컬 DB 런타임은 `PGlite` 기반이며, dev 부팅 시 `stale postmaster.pid`, `RuntimeError: Aborted()` 같은 장애가 반복된다.
2. 현재 구조는 로컬 개발/테스트/CLI가 모두 PGlite 계약에 묶여 있어 런타임 안정성 개선 여지가 제한적이다.
3. 장기적으로는 로컬 기본 DB와 외부 PostgreSQL 서버를 모두 지원해야 한다.

## 2. 목표

1. 로컬 기본 DB 런타임을 `embedded-postgres`로 전환한다.
2. `DATABASE_URL`이 주어지면 외부 PostgreSQL 서버 모드로 동작한다.
3. `PGlite` 런타임과 관련 의존성을 제거한다.
4. `getDb()`가 반환하는 DB는 항상 schema가 준비된 상태여야 한다.

## 3. 범위

- `packages/db`
- `apps/web`
- `packages/cli`
- DB 런타임에 직접 의존하는 테스트 helper 및 주요 테스트
- 개발/배포 문서

## 4. 비범위

- 운영 PostgreSQL HA/replication 설계
- 분산 migration lock
- 원격 DB 백업/복구 자동화

## 5. 요구사항

### 5.1 DB 모드

지원 모드:

- `postgres`
- `embedded-postgres`

결정 규칙:

1. `DATABASE_URL`이 있으면 `postgres`
2. 아니면 `ARCHI_NAVI_DB_MODE=postgres`면 명시 오류 없이 `DATABASE_URL` 필수
3. 그 외 기본값은 `embedded-postgres`

### 5.2 환경변수

- `DATABASE_URL`
- `ARCHI_NAVI_DB_MODE`
- `ARCHI_NAVI_DB_DATA_DIR`
- `ARCHI_NAVI_DB_PORT`
- `ARCHI_NAVI_DB_USER`
- `ARCHI_NAVI_DB_PASSWORD`
- `ARCHI_NAVI_DB_NAME`
- `ARCHI_NAVI_TEST_DATABASE_URL`
- `ARCHI_NAVI_TEST_DB_DATA_DIR`
- `ARCHI_NAVI_TEST_DB_PORT`
- `ARCHI_NAVI_TEST_DB_USER`
- `ARCHI_NAVI_TEST_DB_PASSWORD`
- `ARCHI_NAVI_TEST_DB_NAME`
- `MIGRATIONS_FOLDER`

기존 `PGLITE_DATA_DIR`는 제거한다.

### 5.3 로컬 embedded postgres

1. 기본 포트는 `54329`
2. 기본 user/password/dbName은 각각 `archi_navi` / `archi_navi` / `archi_navi`
3. 포트가 사용 중이면 인접 포트 탐색 또는 기존 인스턴스 adopt를 수행한다.
4. data dir에 `postmaster.pid`가 있어도 실제 프로세스/포트/데이터 디렉터리를 확인해 재사용 또는 정리한다.
5. 새 클러스터가 필요하면 자동 initialize 후 start 한다.

### 5.4 migration

1. `getDb()`는 연결 직후 migration 상태를 점검한다.
2. 빈 DB는 자동 bootstrap migration을 수행한다.
3. migration journal이 꼬인 경우 inspect/reconcile 가능한 구조를 제공한다.
4. schema가 준비되지 않은 DB 핸들을 상위 레이어로 노출하지 않는다.

### 5.5 테스트

1. `createPgliteClient()` 기반 테스트 helper는 제거한다.
2. 테스트는 temp embedded postgres DB helper를 사용한다.
3. `ARCHI_NAVI_TEST_DATABASE_URL`이 주어지면 helper는 외부 PostgreSQL 서버 위에 temp database를 만들어 사용한다.
4. helper는 `connectionString`, `db`, `cleanup()`을 제공해야 한다.

### 5.6 앱/CLI 연동

1. `apps/web dev`는 기본적으로 embedded postgres를 사용한다.
2. `packages/cli up`도 동일한 DB 모드 계약을 따른다.
3. 설정 문서와 런타임 로그는 PGlite가 아닌 embedded postgres/postgres 기준으로 정리한다.

## 6. 수용 기준

1. 소스 코드에서 `@electric-sql/pglite`, `drizzle-orm/pglite`, `drizzle-orm/pglite/migrator` 의존이 제거된다.
2. `apps/web dev`가 기본 설정에서 embedded postgres로 정상 기동한다.
3. `DATABASE_URL`을 주면 외부 PostgreSQL 서버로 정상 기동한다.
4. 주요 inference/web 테스트가 새 DB 런타임 helper에서 통과한다.
5. 개발 가이드와 배포 문서에 새 DB 모드가 반영된다.

## 7. 검증

- `pnpm --filter @archi-navi/db exec vitest run src/__tests__/client.test.ts`
- `pnpm --filter @archi-navi/db exec tsc --noEmit`
- `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/orchestration/intentProofEngine.test.ts src/__tests__/orchestration/inferenceRuns.test.ts`
- `pnpm --filter @archi-navi/web exec vitest run src/__tests__/smart.route.test.ts src/__tests__/inference-candidates.route.test.ts src/__tests__/approval-list.test.tsx src/__tests__/inference-run-list.test.tsx`
- `pnpm --filter @archi-navi/web run dev`
