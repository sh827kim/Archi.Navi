# 41. DB Recovery Migration SPEC

상태: Implemented (2026-03-29)
우선순위: S1
로드맵 범위: 개발 환경 안정화

## 1. 문제 정의

1. PGlite 데이터 디렉터리 복구 후 빈 DB가 생성되더라도 마이그레이션이 즉시 재적용되지 않을 수 있다.
2. 이 경우 `/api/workspaces` 같은 초기 API가 `relation "workspaces" does not exist`로 실패한다.

## 2. 목표

1. `getDb()`가 반환하는 DB는 항상 현재 스키마가 준비된 상태여야 한다.
2. dev instrumentation 실행 순서나 재시작 타이밍에 의존하지 않는다.

## 3. 범위

- `packages/db/src/client.ts`
- `packages/db/src/__tests__/client.test.ts`

## 4. 비범위

- 프로덕션 외부 PostgreSQL 마이그레이션 배포 전략
- 워커/멀티프로세스 분산 락

## 5. 수용 기준

1. PGlite 복구 또는 신규 초기화 후 `MIGRATIONS_FOLDER`가 설정되어 있으면 마이그레이션이 자동 적용된다.
2. 워크스페이스 생성/조회 API가 빈 데이터 디렉터리에서도 `workspaces` 테이블 부재로 실패하지 않는다.

## 6. 검증

- `pnpm --filter @archi-navi/db exec vitest run src/__tests__/client.test.ts`
- `pnpm --filter @archi-navi/db lint`
