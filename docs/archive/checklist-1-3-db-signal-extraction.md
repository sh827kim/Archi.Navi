# 개발 체크리스트: 1-3 DB 시그널 추출

> 로드맵 참조: `docs/08-roadmap.md` §P1 1-3
> 설계 참조: `docs/03-inference-engine.md` §5 DB 스키마 신호 추출
> 브랜치: `feature/inference-engine`
> 작성일: 2026-02-22

---

## 목표

`objects` 테이블에 등록된 `db_table` 타입 객체의 메타데이터에서
FK 제약조건/컬럼 패턴을 분석하여 테이블 간 참조 관계를 `relation_candidates`에 저장하고,
서비스가 접근하는 테이블의 prefix를 분석하여 도메인 affinity의 `dbScore`를 계산한다.

**기대 효과:** dbScore를 domain affinity에 반영하여 추론 정확도 향상

---

## 구현 범위

### 추출 신호 및 Confidence (설계 §5)

| 신호 소스 | 추론 결과 | Confidence |
|----------|----------|------------|
| `metadata.fk_constraints` 직접 FK | `db_table → db_table` relation_candidate | 0.95 |
| 컬럼명 `*_id`, `*_no` 패턴 (implicit FK) | `db_table → db_table` relation_candidate | 0.5 |
| 테이블 prefix 매칭 (code_call_edges 기반) | domain affinity dbScore | 설계 §5.1 |

### 제외 패턴 (false positive 방지)

- `created_by`, `updated_by`, `deleted_by`
- `created_at`, `updated_at`, `deleted_at`
- `id` (자기 자신 참조 방지)

### 중복 방지

- `relation_candidates`에 같은 (subjectObjectId, objectId, relationType) 조합으로
  `PENDING` 상태가 이미 존재하면 새 후보를 생성하지 않음

### dbScore 계산 데이터 흐름

```
service.id
  → code_artifacts (ownerObjectId = service.id)
  → code_call_edges (callerArtifactId IN artifact_ids)
  → evidences (metadata.kind IN 'db_read' | 'db_write' | 'db_mapping')
  → calleeSymbol = 테이블명
  → prefix 추출 (order_items → order)
  → domain.name 과 prefix 매칭 → score 누적
```

---

## 구현 파일 목록

```
packages/inference/src/db/
  ├── index.ts                               [신규] public export
  └── dbSchemaSignal.ts                      [신규] FK/컬럼패턴 추출 + dbScore 헬퍼

packages/inference/src/__tests__/db/
  └── dbSchemaSignal.test.ts                 [신규] PGlite 통합 테스트 (20개)

packages/inference/src/domain/seedBased.ts  [수정] dbScore 실제 계산 연동
packages/inference/src/index.ts             [수정] db 모듈 export 추가

docs/checklist-1-3-db-signal-extraction.md  [이 파일]
```

---

## 체크리스트

### Phase 1: 의존성 확인

- [x] **기존 스키마 테이블 확인**
  - `objects` 테이블: `objectType='db_table'`, `metadata.fk_constraints`, `metadata.columns` 구조
  - `relation_candidates` 테이블: subjectObjectId, objectId, relationType, confidence, status
  - `code_artifacts`, `code_call_edges`, `evidences` 테이블: db 신호 조회 경로
- [x] **기존 유틸 활용 확인**
  - `generateId()` — UUID 생성
  - `@archi-navi/db`: `objects`, `relationCandidates`, `codeArtifacts`, `codeCallEdges`, `evidences` import 가능

### Phase 2: `dbSchemaSignal.ts` 구현

- [x] **공개 타입 정의**
  - `DbSchemaSignalOptions`: `{ workspaceId: string }`
  - `DbSchemaSignalResult`: `{ tableCount, fkCandidateCount, implicitFkCandidateCount }`

- [x] **내부 헬퍼 함수**
  - [x] `extractTablePrefix(tableName: string): string`
    - `order_items` → `order` (첫 번째 `_` 이전)
    - `users` → `users` (언더스코어 없으면 전체)
  - [x] `matchDomainByPrefix(prefix, domains): string | null`
    - 정확 매칭 (대소문자 무시) 우선
    - 부분 포함 매칭 (도메인명이 prefix에 포함되거나 역방향)
  - [x] `inferReferencedTables(columnName): string[]` (내부)
    - `order_id` → `['orders', 'order']` (복수형 우선)

- [x] **`extractDbSchemaSignals(db, options)` 구현**
  - [x] `objectType='db_table'` objects 조회 (workspaceId 조건)
  - [x] `db_table` 없으면 즉시 `{ tableCount: 0, fkCandidateCount: 0, implicitFkCandidateCount: 0 }` 반환
  - [x] FK 제약조건 처리 (`metadata.fk_constraints` 배열)
    - [x] 각 FK의 `references_table`로 `db_table` object 조회 → objectId 확인
    - [x] 대상 테이블 object 없으면 스킵
    - [x] PENDING 중복 확인 후 없으면 `relation_candidates` insert (confidence 0.95, relationType='fk_reference')
  - [x] 컬럼명 패턴 처리 (`metadata.columns` 배열)
    - [x] `*_id`, `*_no` 접미사 컬럼 추출
    - [x] 제외 패턴 필터링 (`created_by`, `updated_by`, `deleted_by`, `created_at`, `updated_at`, `deleted_at`, `id`)
    - [x] 컬럼명에서 대상 테이블명 추정 (`order_id` → `orders`/`order`, `item_no` → `items`/`item`)
    - [x] 대상 테이블 object 조회 → 있으면 relation_candidate 생성 (confidence 0.5)
    - [x] FK 제약조건이 이미 처리한 관계는 스킵 (중복 방지)
  - [x] 결과 반환

- [x] **`computeDbScores(db, serviceId, domains, workspaceId)` 구현**
  - [x] 서비스의 `code_artifacts` 조회 (ownerObjectId = serviceId)
  - [x] artifact 없으면 빈 객체 `{}` 반환
  - [x] `code_call_edges` 조회 (callerArtifactId IN artifact ids)
  - [x] `evidences` 조회 (id IN evidence ids)
  - [x] `evidences.metadata.kind` in `['db_read', 'db_write', 'db_mapping']` 필터링
  - [x] 각 calleeSymbol에서 `extractTablePrefix` 적용
  - [x] `matchDomainByPrefix`로 도메인 매칭 → score 누적 (각 매칭마다 +1)
  - [x] 반환: `Record<domainId, score>`

### Phase 3: `seedBased.ts` 수정

- [x] **`computeDbScores` import 추가**
- [x] **서비스 루프 수정**
  - [x] `for (const service of services)` 루프에서 `computeDbScores` 호출
  - [x] `dbScore = 0` → `allDbScores[domain.id] ?? 0` 로 교체 (raw count를 0~1로 보정: `min(1.0, count/5)`)
  - [x] `signals` 저장에 `db: dbScoreMap` 포함

### Phase 4: 단위 테스트 (`dbSchemaSignal.test.ts`, 20개)

- [x] **`extractTablePrefix` 단위 테스트** (2개)
  - [x] 언더스코어 있으면 첫 번째 세그먼트 반환
  - [x] 언더스코어 없으면 전체 이름 반환

- [x] **`matchDomainByPrefix` 단위 테스트** (2개)
  - [x] 정확 매칭 (대소문자 무시) 반환
  - [x] 매칭 실패 시 null 반환

- [x] **`extractDbSchemaSignals` 통합 테스트** (8개)
  - [x] `db_table` 없으면 빈 결과 반환
  - [x] FK 제약조건 → `relation_candidate` 생성 (relationType='fk_reference', confidence≈0.95)
  - [x] 동일 FK 두 번 실행 → 중복 생성 없음 (PENDING 존재 시 스킵)
  - [x] 컬럼명 `order_id` → `orders` 테이블 implicit FK (confidence≈0.5)
  - [x] 컬럼명 `item_no` → `items` 테이블 implicit FK
  - [x] 제외 패턴 `created_by`, `updated_by`, `deleted_by`, `created_at`, `updated_at`, `deleted_at` → 생성 안함
  - [x] FK + 컬럼패턴 혼합 → FK는 0.95, FK 처리된 관계는 컬럼패턴에서 스킵
  - [x] 참조 대상 테이블 미존재 → relation_candidate 생성 안함

- [x] **`computeDbScores` 통합 테스트** (6개)
  - [x] 서비스 artifacts 없으면 빈 결과 `{}`
  - [x] `db_read` calleeSymbol `'order_items'` → prefix `'order'` → order 도메인 score
  - [x] `db_write` calleeSymbol `'payment_history'` → prefix `'payment'` → payment 도메인 score
  - [x] `db_mapping` calleeSymbol `'orders'` → order 도메인 score
  - [x] prefix 매칭 실패 → 해당 도메인 score 없음
  - [x] 여러 테이블 접근 → 도메인별 score 합산

- [x] **`seedBased.ts` 통합 테스트** (2개)
  - [x] db_table 없을 때 graceful 처리 (candidateCount 정상 반환)
  - [x] dbScore가 domain_candidates의 signals.db에 저장됨

### Phase 5: export 및 컴파일/테스트 실행

- [x] **`db/index.ts` 작성**
  - [x] `extractDbSchemaSignals`, `computeDbScores` export
  - [x] 타입 export (`DbSchemaSignalOptions`, `DbSchemaSignalResult`)

- [x] **`inference/src/index.ts` 수정**
  - [x] `export * from './db/index'` 추가

- [x] **TypeScript 컴파일 오류 없음**
  - [x] `pnpm --filter @archi-navi/inference lint` 성공 (출력 없음 = 오류 없음)

- [x] **단위 테스트 전체 통과**
  - [x] `pnpm --filter @archi-navi/inference test:unit` 전체 GREEN (98개 → 118개)
    - 기존: 98개 (1-1 Config 기반 추론 52개 + 1-2 Code Signal 46개)
    - 신규: 20개 (dbSchemaSignal 20)

---

## 설계 결정 사항

### `db_table` metadata 구조

```json
{
  "columns": [
    { "name": "id", "type": "bigint" },
    { "name": "order_id", "type": "bigint" },
    { "name": "customer_id", "type": "bigint" },
    { "name": "created_by", "type": "varchar" }
  ],
  "fk_constraints": [
    {
      "column": "order_id",
      "references_table": "orders",
      "references_column": "id"
    }
  ]
}
```

### `relation_candidates` 저장 형식 (FK 기반)

```typescript
{
  relationType: 'fk_reference',
  subjectObjectId: table.id,       // 참조하는 테이블
  objectId: referencedTable.id,    // 참조되는 테이블
  confidence: 0.95,
  metadata: { column, references_table, references_column, source: 'fk_constraint' },
  status: 'PENDING',
}
```

### `relation_candidates` 저장 형식 (implicit FK 기반)

```typescript
{
  relationType: 'fk_reference',
  subjectObjectId: table.id,
  objectId: referencedTable.id,
  confidence: 0.5,
  metadata: { column, inferred_table: 'orders', source: 'column_pattern' },
  status: 'PENDING',
}
```

### dbScore 정규화

code_call_edges에서 카운트된 raw score는 `min(1.0, count / 5)`로 보정:
- 테이블 5회 이상 접근 → dbScore 상한 1.0
- 이후 `weights.db * dbScore`로 totalScore에 반영

### Phase 1 한계 및 Phase 2 예정 사항

- 현재는 code_call_edges의 calleeSymbol로만 서비스↔테이블 연관 파악
- Phase 2에서 service → database object 간 relation을 통해 더 정확한 연결 가능
- FK 네이밍 패턴 기반 커뮤니티 추론 (§5.1 FK 커뮤니티 신호)은 Phase 2에서 구현 예정

---

## 관련 문서

- `docs/08-roadmap.md` — P1 1-3 DB 시그널 추출
- `docs/03-inference-engine.md` — §5 DB 스키마 신호 추출
- `packages/db/src/schema/core.ts` — `objects`, `relationCandidates`
- `packages/db/src/schema/code.ts` — `codeArtifacts`, `codeCallEdges`
- `packages/db/src/schema/evidence.ts` — `evidences`
