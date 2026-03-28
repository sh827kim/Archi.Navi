# 16. DB Table Code Signal 추출 및 Database 소속 보장 (SPEC)

상태: Implemented

## 목표
- `mode=code`만으로도 `db_table` Atomic object 및 `read/write` 관계 후보(`relation_candidates`)를 생성한다.
- 생성되는 모든 `db_table`은 반드시 `database` object에 소속되어야 한다(`parentId` 필수).

## 비목표
- SQL 파서(AST) 수준의 완전한 테이블/컬럼 해석
- 실제 DB 인스턴스(호스트/포트/스키마) 정확한 매칭(초기에는 보수적/결정론적 fallback 허용)

## 입력/출력
### 입력
- `workspaceId`
- `repoRoot`

### 출력
- 생성된 `database` object 수(필요 시)
- 생성된 `db_table` object 수
- 생성된 `read/write` 후보 수

## Signal 입력(근거)
Code Signal 추출 결과(`code_call_edges` + `evidences`)에서 아래 kind를 사용한다.
- `db_read`: SELECT 성격의 테이블 접근
- `db_write`: INSERT/UPDATE/DELETE 성격의 테이블 접근
- `db_mapping`: `@Table` 등 “테이블 존재/매핑” 신호

규칙:
- `db_mapping`은 **db_table upsert 근거**로는 사용하지만, 단독으로 `read/write` 후보를 만들지는 않는다.

## Object Upsert 규칙
### 1) database (부모) upsert
db_table 생성 시 항상 database parent를 결정해야 한다.

database parent 결정 우선순위:
1. (있으면) `service -> database` 관계가 이미 존재하는 database
   - MANUAL/APPROVED 관계 우선
   - 없으면 APPROVED/PENDING 후보 중 confidence가 가장 높은 database
2. (없으면) 서비스 단위 fallback database 생성(결정론적)
   - `objectType='database'`, `category='STORAGE'`, `granularity='COMPOUND'`
   - `urn = buildUrn(workspaceId, 'storage', 'database', '{serviceName}:default')`
   - `name/displayName = '{serviceName} DB'`
   - `metadata.inferredFrom='CODE'`, `metadata.repoRoot=repoRoot`, `metadata.databaseKey='{serviceName}:default'`

### 2) db_table (자식) upsert
- `objectType='db_table'`
- `category='STORAGE'`
- `granularity='ATOMIC'`
- `depth=1`
- `parentId = database.id` (필수)

테이블 식별자 정규화:
- 입력이 `schema.table` 형태면 표준 표기명은 `schema.table`로 유지한다.
- 따옴표/백틱 등 quoting은 제거하고 lower-case로 정규화한다.
- `metadata.schema`, `metadata.table`로 분리 저장할 수 있다(선택).

URN 규칙(중복 방지):
- `urn = buildUrn(workspaceId, 'storage', 'db_table', '{databaseUrn}:{normalizedTableName}')`
  - `databaseUrn`은 상위 database object의 urn
  - `normalizedTableName`은 위 정규화 규칙을 적용한 테이블 이름

## 후보 생성 규칙
### 주체(Subject)
- `code_call_edges.callerArtifactId -> code_artifacts.ownerObjectId`를 주체(service)로 사용한다.
- `ownerObjectId`가 없으면 후보 생성을 스킵한다.

### 대상(Target)
- `db_read/db_write` signal에서 추출된 테이블 이름으로 `db_table`을 upsert 한 뒤 대상 objectId로 사용한다.

### relationType
- `db_read` → `read`
- `db_write` → `write`

### confidence/metadata/evidence
- 후보 confidence는 evidence metadata의 `confidence`를 우선 사용한다(0~1 clamp).
- 없으면 기본값 `0.7`.
- 후보 metadata에는 최소 아래 필드를 포함한다:
  - `source: 'CODE'`
  - `kind: 'db_read'|'db_write'`
  - `repoRoot`
  - `table` (원본 또는 정규화 이름)
- `relation_candidate_evidences`로 evidenceId를 연결한다.

## 멱등성/중복 규칙
- object upsert는 URN 기반으로 멱등성을 보장한다.
- 후보 생성은 기본 규칙을 따른다:
  - 동일 `(workspaceId, relationType, subjectObjectId, objectId)` 조합에 대해
    - MANUAL 관계가 존재하면 후보 생성/업데이트를 하지 않는다.
    - APPROVED 후보가 존재하면 후보 생성/업데이트를 하지 않는다.
    - PENDING 후보가 존재하면 confidence가 더 높을 때만 업데이트하고, evidence 연결은 누적한다.

## 테스트(수용 기준)
- `db_read` signal로 `service -> db_table (read)` 후보가 생성된다.
- `db_write` signal로 `service -> db_table (write)` 후보가 생성된다.
- `db_table.parentId`가 항상 `database`를 가리킨다(어떤 경우에도 null이 아니다).
- config 기반 DB 정보가 없더라도 서비스 단위 fallback database가 생성되고, table이 그 아래에 붙는다.
- 동일 입력을 반복 실행해도 object/candidate가 중복 생성되지 않는다.
