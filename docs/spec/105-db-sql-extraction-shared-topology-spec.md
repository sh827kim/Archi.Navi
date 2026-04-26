# 105. DB SQL Extraction and Shared Topology SPEC

- 상태: Implemented
- 작성일: 2026-04-26
- 대상: `packages/inference/src/code/scanners/javaKotlin.ts`, `packages/inference/src/relation/codeBased.ts`
- 관련: `16-db-table-code-signal-spec.md`, `91-db-scan-toggle-spec.md`, `102-domain-physical-logical-separation-spec.md`

## 1. 목적

MyBatis SQL에서 alias를 테이블로 오인식하지 않고, SOA/shared DB 환경에서 여러 서비스가
같은 database/db_table object를 재사용할 수 있게 한다.

## 2. MyBatis SQL 추출

- MyBatis XML은 기존 계약대로 AST가 아닌 전용 SQL 추출기로 처리한다.
- XML 태그, CDATA wrapper, MyBatis placeholder, SQL 주석을 제거한 뒤 statement 토큰을 분석한다.
- `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM`의 테이블 식별자를 추출한다.
- `SELECT * FROM robot_instance a`는 `robot_instance`만 `db_read`로 emit하고,
  `a`는 `metadata.aliases = { a: "robot_instance" }`에만 저장한다.
- `schema.table`은 표준 테이블명으로 유지한다.
- CTE 이름은 base table로 emit하지 않는다.
- 파싱 실패 시 기존 regex fallback을 사용하되 confidence를 낮추고
  `metadata.parser = "fallback_regex"`를 기록한다.

## 3. Shared DB 토폴로지

database identity 우선순위:

1. 확정 `service -> database` object relation
2. 후보 `service -> database` relation candidate
3. evidence metadata의 `databaseKey`, `datasourceUrl`, `jdbcUrl`, `schema`, `catalog`
4. 기존 service 단위 fallback

같은 canonical DB key를 두 서비스 이상이 사용하면 하나의 database object를 공유하고
`metadata.sharingModel = "SHARED"`로 갱신한다. 같은 database 아래 동일 테이블도 하나의
`db_table` object를 공유한다.

config가 없고 같은 table이 여러 service fallback database에서 관측되면 자동 병합하지 않고,
각 table metadata에 `sharingModel = "SUSPECTED_SHARED"`를 기록한다.

## 4. Metadata 계약

`ExtractedSignal.metadata` DB SQL 필드:

- `statementType`
- `tables`
- `aliases`
- `schema`
- `parser`
- `parseWarnings`

`database`/`db_table` object metadata:

- `databaseKey`
- `sharingModel`
- `schema`
- `table`
- `observedByServiceIds`

relation candidate metadata:

- `dbAccessRole`
- `dbTopologyConfidence`
- `databaseKey`
- `sharingModel`

## 5. 수용 기준

- alias 단독 토큰은 `calleeSymbol`, `db_table.name`으로 저장되지 않는다.
- canonical DB key가 같은 두 서비스는 database/db_table을 공유한다.
- config 없는 동일 테이블 다중 서비스 접근은 자동 병합하지 않고 suspected shared로 표시한다.
- write 후보는 `dbAccessRole = "owner_candidate"`, read 후보는 `shared_user` 또는 `reader`로 기록한다.
