# DB Inference Expansion SPEC (Roadmap 3-6)

- 작성일: 2026-03-02
- 상태: Implemented
- 범위: `packages/inference/src/db/dbSchemaSignal.ts`

## 1. 목적
DB 스키마 추론에서 FK/컬럼 패턴만으로 놓치던 관계를 보완하기 위해, 인덱스/유니크 제약 메타데이터를 추가 신호로 사용한다.

## 2. 요구사항
1. 복합 인덱스에 포함된 FK 유사 컬럼(`*_id`, `*_no`)을 조인 힌트로 사용한다.
2. 유니크 제약(또는 unique index)의 FK 유사 컬럼을 식별 관계 힌트로 사용한다.
3. 기존 FK/컬럼 패턴 로직과 충돌 없이 중복 후보를 방지한다.
4. 기존 증분 추론 해시 전략을 유지한다.

## 3. 입력 메타데이터 계약 (db_table.metadata)
아래 필드를 지원한다. 실제 입력은 추가 필드가 있어도 무시한다.

```json
{
  "columns": [{ "name": "order_id", "type": "bigint" }],
  "fk_constraints": [
    { "column": "order_id", "references_table": "orders", "references_column": "id" }
  ],
  "indexes": [
    { "name": "idx_order_items_order_product", "columns": ["order_id", "product_id"], "unique": false },
    { "name": "uq_profile_user", "columns": ["user_id"], "unique": true }
  ],
  "unique_constraints": [
    { "name": "uq_order_items_order_line", "columns": ["order_id", "line_no"] }
  ]
}
```

## 4. 추론 규칙

### 4.1 우선순위
신뢰도 높은 신호를 먼저 생성하고, 동일 `(subject, object, relationType)`는 후순위 신호를 무시한다.

1. FK 제약 (`confidence=0.95`)
2. Unique 패턴 (`confidence=0.85`)
3. Index 패턴 (`confidence=0.7`)
4. 컬럼 패턴 (`confidence=0.5`)

### 4.2 Unique 패턴
- 대상: `unique_constraints[].columns`, `indexes[]` 중 `unique=true`
- 규칙:
  - 컬럼 집합에서 FK 유사 컬럼(`*_id|*_no`)만 후보로 본다.
  - 참조 테이블 추론에 성공하면 후보를 생성한다.
- 저장:
  - `relationType='fk_reference'`
  - evidence `metadata.kind='db_schema_unique_hint'`
  - candidate metadata에 `source='unique_pattern'`, `unique_name`, `unique_columns`, `cardinality_hint='one_to_one_or_identifying'`

### 4.3 Index 패턴
- 대상: `indexes[]` 중 `columns.length >= 2`
- 규칙:
  - 복합 인덱스 컬럼 중 FK 유사 컬럼을 후보로 본다.
  - 참조 테이블 추론 성공 시 후보 생성한다.
- 저장:
  - `relationType='fk_reference'`
  - evidence `metadata.kind='db_schema_index_hint'`
  - candidate metadata에 `source='index_pattern'`, `index_name`, `index_columns`

## 5. 중복/충돌 처리
- 동일 key: `(subjectObjectId, objectId, relationType='fk_reference')`
- 동일 key가 이미 생성된 경우 후속 신호는 insert하지 않는다.
- FK가 존재하면 unique/index/implicit는 같은 대상에 대해 생성되지 않는다.

## 6. 비기능 요구사항
- 기존 API 시그니처/반환 타입(`DbSchemaSignalResult`)은 변경하지 않는다.
- 증분 모드에서 해시 계산은 메타데이터 전체를 반영해야 한다.

## 7. 테스트 수용 기준
1. unique 제약으로 fk_reference 후보가 생성된다.
2. unique index(`unique=true`)도 동일하게 처리된다.
3. 복합 index로 fk_reference 후보가 생성된다.
4. FK 존재 시 unique/index 후보는 중복 생성되지 않는다.
5. 증분 모드와 기존 테스트가 회귀 없이 통과한다.
