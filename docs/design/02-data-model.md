# Archi.Navi — 데이터 모델

작성일: 2026-02-22
문서 버전: v2.0

---

## 1. Object 모델

### 1.1 설계 원칙

모든 기술적 자산은 **Object**로 통합 관리한다.
Object는 독립적인 개체인 동시에 다른 객체를 포함하는 **집합체(Compound)**가 될 수 있다.

### 1.2 Object 계층 및 분류 (Taxonomy)

| 카테고리 | 집합체 (Compound) | 원자 단위 (Atomic) | 설명 |
|----------|-------------------|-------------------|------|
| **COMPUTE** | `service` | `api_endpoint`, `function` | 실행 유닛 및 API 접점 |
| **STORAGE** | `database`, `cache_instance` | `db_table`, `db_view`, `cache_key` | 데이터 저장소 및 세부 엔티티 |
| **CHANNEL** | `message_broker` | `topic`, `queue` | 비동기 메시지 통로 |

### 1.3 Canonical Object Type Enum

```typescript
const OBJECT_TYPES = [
  'service',
  'api_endpoint',
  'function',
  'database',
  'db_table',
  'db_view',
  'cache_instance',
  'cache_key',
  'message_broker',
  'topic',
  'queue',
  'domain',        // 도메인 (Named/Discovered)
] as const;
```

### 1.4 Object 핵심 속성

| 속성 | 설명 |
|------|------|
| **UUID** | 내부 고유 식별자 (v7, 시간순 정렬) |
| **URN** | 가독성/외부참조용 식별자: `urn:{workspace}:{category}:{type}:{normalized_path}` |
| **parent_id** | 상위 집합체 Object ID (무한 계층) |
| **path** | Materialized path (예: `/{db_id}/{table_id}`) — 조회 성능용 |
| **granularity** | `COMPOUND` (집합체) / `ATOMIC` (원자 단위) |
| **visibility** | `VISIBLE` / `HIDDEN` (뷰 노출 제어) |
| **metadata** | JSON 형태의 가변 속성 |
| **valid_from / valid_to** | Temporal Architecture — 시점 기반 구조 재현 |

### 1.5 URN 체계

```
urn:{workspace}:{category}:{type}:{normalized_path}

// 예시
urn:team-a:compute:service:order-service
urn:team-a:storage:table:customer-db.customer
urn:team-a:channel:topic:order.created
```

- rename 대응: URN 변경 이력 추적 가능
- federation 확장: workspace 기준 네임스페이스 분리

### 1.6 Tagging

- 태그는 `object_tags`(N:M)로 관리
- 모든 Object type에 태그 부여 가능
- 기존 서비스 태깅 UX는 Object 태깅으로 확장

### 1.7 Domain을 Object로 관리

Domain도 Object로 저장한다 (`object_type = 'domain'`).

| 도메인 종류 | metadata.kind | 설명 |
|------------|---------------|------|
| Named (Seed 기반) | `SEED` | 사용자가 정의한 도메인 |
| Discovered (자동 발견) | `DISCOVERED` | 그래프 커뮤니티 탐지로 생성 |

---

## 2. Relation 모델

### 2.1 Relation Type 표준

| 타입 | 분류 | interaction_kind | direction | 적용 대상 |
|------|------|-----------------|-----------|-----------|
| `call` | Control | CONTROL | OUT | `service` → `api_endpoint` |
| `expose` | Structure | CONTROL | IN | `service` → `api_endpoint` (인터페이스 노출) |
| `read` | Storage In | DATA | IN | `service` → `db_table` / `database` |
| `write` | Storage Out | DATA | OUT | `service` → `db_table` / `database` |
| `produce` | Channel Out | ASYNC | OUT | `service` → `topic` / `message_broker` |
| `consume` | Channel In | ASYNC | IN | `service` → `topic` / `message_broker` |
| `depend_on` | Static | STATIC | OUT | 추론 불가 또는 정적 의존성 (Fallback) |

### 2.2 Semantic Axis

Relation Type에 의미 축을 추가하여 확장성과 필터링을 강화한다.

- **interaction_kind**: `CONTROL` | `DATA` | `ASYNC` | `STATIC`
- **direction**: `IN` | `OUT`

### 2.3 정규 저장 원칙

- `call`은 `service → api_endpoint`로 **원자 수준에서만** 저장한다.
- `service → service`는 직접 저장하지 않고 **Roll-up으로 파생 계산**한다.
- 저장소/채널 관계도 동일하게 원자 객체 기준으로 저장하고 상위 객체 관계는 파생 계산한다.

### 2.3.1 운영 규약 고정 (2026-03-01)

- 샘플 시드(`POST /api/dev/seed`)도 정규 저장 원칙을 따른다.
- 아키텍처 뷰의 서비스/DB/브로커 엣지는 `object_relations` 직접 조회가 아니라
  `object_rollups`(SERVICE_TO_SERVICE/SERVICE_TO_DATABASE/SERVICE_TO_BROKER)를 기본 소스로 사용한다.
- `depend_on`처럼 원자 관계로 환원하기 어려운 정적 의존만 COMPOUND 직접 관계로 예외 허용한다.

### 2.4 Relation Metadata

Relation에 부가 정보를 JSON으로 저장할 수 있다.

```json
{
  "protocol": "HTTP",
  "http_method": "POST",
  "status_code": 200,
  "join_type": "INNER"
}
```

### 2.5 파생 관계 관리

| 필드 | 설명 |
|------|------|
| `is_derived` | 파생 여부 (boolean) |
| `confidence` | 신뢰도 (0~1) |
| `source` | 생성 출처 (`MANUAL`, `INFERRED`, `ROLLUP`) |

---

## 3. View Projection 원칙

같은 Object/Relation 모델을 여러 View로 projection한다.

| 뷰 | 설명 |
|-----|------|
| **Architecture View** | Roll-up 중심 시각화 preset |
| **Service List View** | `object_type=service` 목록 projection + CSV Export |
| **Object Mapping View** | Object type 필터 기반 drill-down/roll-down |

---

## 4. 통합 DB 스키마

### 4.1 Core 테이블

#### workspaces

```sql
create table workspaces (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

#### objects

```sql
create table objects (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  object_type text not null,        -- service, api_endpoint, domain, ...
  category text,                    -- COMPUTE, STORAGE, CHANNEL
  granularity text not null default 'ATOMIC', -- COMPOUND, ATOMIC

  urn text,                         -- urn:{workspace}:{category}:{type}:{path}
  name text not null,
  display_name text,
  description text,

  parent_id uuid references objects(id) on delete set null,
  path text not null,               -- materialized path
  depth int not null default 0,

  visibility text not null default 'VISIBLE', -- VISIBLE, HIDDEN
  metadata jsonb not null default '{}'::jsonb,

  valid_from timestamptz,           -- Temporal Architecture
  valid_to timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ux_objects_ws_urn
  on objects(workspace_id, urn) where urn is not null;
create index ix_objects_ws_type on objects(workspace_id, object_type);
create index ix_objects_ws_parent on objects(workspace_id, parent_id);
create index ix_objects_ws_path on objects(workspace_id, path);
```

#### object_tags

```sql
create table tags (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique(workspace_id, name)
);

create table object_tags (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  object_id uuid not null references objects(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  primary key (workspace_id, object_id, tag_id)
);
```

#### object_relations (확정 관계)

```sql
create table object_relations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  relation_type text not null,      -- call, expose, read, write, produce, consume, depend_on
  subject_object_id uuid not null references objects(id) on delete cascade,
  object_id uuid not null references objects(id) on delete cascade,

  interaction_kind text,            -- CONTROL, DATA, ASYNC, STATIC
  direction text,                   -- IN, OUT

  is_derived boolean not null default false,
  confidence real,                  -- 0~1

  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'MANUAL', -- MANUAL, INFERRED, ROLLUP

  valid_from timestamptz,
  valid_to timestamptz,

  created_at timestamptz not null default now(),

  unique(workspace_id, relation_type, subject_object_id, object_id, is_derived)
);

create index ix_rel_ws_subject on object_relations(workspace_id, subject_object_id);
create index ix_rel_ws_object on object_relations(workspace_id, object_id);
create index ix_rel_ws_type on object_relations(workspace_id, relation_type);
```

#### relation_candidates (승인 전 큐)

```sql
create table relation_candidates (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  relation_type text not null,
  subject_object_id uuid not null references objects(id),
  object_id uuid not null references objects(id),

  confidence real not null,         -- 0~1
  metadata jsonb not null default '{}'::jsonb,

  status text not null default 'PENDING', -- PENDING, APPROVED, REJECTED

  reviewed_at timestamptz,
  reviewed_by text,

  created_at timestamptz not null default now()
);

create index ix_relcand_ws_status on relation_candidates(workspace_id, status);
```

### 4.2 Evidence 테이블

#### evidences

```sql
create table evidences (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  evidence_type text not null,      -- FILE, CONFIG, API_SPEC, SCHEMA, MANUAL
  file_path text,
  line_start int,
  line_end int,
  excerpt text,                     -- 근거 발췌문
  uri text,                         -- 외부 참조 URI

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

#### relation_evidences

```sql
create table relation_evidences (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  relation_id uuid not null references object_relations(id) on delete cascade,
  evidence_id uuid not null references evidences(id) on delete cascade,
  primary key (workspace_id, relation_id, evidence_id)
);
```

#### relation_candidate_evidences

```sql
create table relation_candidate_evidences (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  candidate_id uuid not null references relation_candidates(id) on delete cascade,
  evidence_id uuid not null references evidences(id) on delete cascade,
  primary key (workspace_id, candidate_id, evidence_id)
);
```

### 4.3 Rollup 테이블

#### object_rollups (Materialized Roll-up)

```sql
create table object_rollups (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  rollup_level text not null,       -- SERVICE_TO_SERVICE, SERVICE_TO_DATABASE, SERVICE_TO_BROKER, DOMAIN_TO_DOMAIN
  relation_type text not null,

  subject_object_id uuid not null references objects(id),
  object_id uuid not null references objects(id),

  edge_weight int not null default 1,
  confidence real,
  generation_version bigint not null,

  created_at timestamptz not null default now()
);

create index ix_rollup_out
  on object_rollups(workspace_id, generation_version, rollup_level, subject_object_id);
create index ix_rollup_in
  on object_rollups(workspace_id, generation_version, rollup_level, object_id);
create index ix_rollup_type
  on object_rollups(workspace_id, generation_version, rollup_level, relation_type);
```

#### rollup_generations

```sql
create table rollup_generations (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  generation_version bigint not null,
  built_at timestamptz not null default now(),
  status text not null default 'ACTIVE', -- BUILDING, ACTIVE, ARCHIVED
  meta jsonb not null default '{}'::jsonb,
  primary key (workspace_id, generation_version)
);
```

#### object_graph_stats

```sql
create table object_graph_stats (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  generation_version bigint not null,
  rollup_level text not null,
  object_id uuid not null references objects(id),
  out_degree int not null,
  in_degree int not null,
  primary key (workspace_id, generation_version, rollup_level, object_id)
);
```

### 4.4 Domain 테이블

#### object_domain_affinities (확정 도메인 소속)

```sql
create table object_domain_affinities (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  object_id uuid not null references objects(id) on delete cascade,
  domain_id uuid not null references objects(id) on delete cascade, -- object_type='domain'

  affinity real not null,           -- 0~1 (정규화된 분포)
  confidence real,                  -- 0~1
  source text not null default 'APPROVED_INFERENCE', -- MANUAL, APPROVED_INFERENCE, DISCOVERY

  generation_version bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(workspace_id, object_id, domain_id)
);

create index ix_oda_ws_object on object_domain_affinities(workspace_id, object_id);
create index ix_oda_ws_domain on object_domain_affinities(workspace_id, domain_id);
```

#### domain_inference_profiles (추론 설정 프로필)

```sql
create table domain_inference_profiles (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null default 'NAMED', -- NAMED, DISCOVERY

  is_default boolean default false,

  -- Seed 기반 가중치
  w_code real default 0.5,
  w_db real default 0.3,
  w_msg real default 0.2,

  heuristic_domain_cap real default 0.3,
  secondary_threshold real default 0.25,

  -- Discovery 기반 엣지 가중치
  edge_w_call real default 1.0,
  edge_w_rw real default 0.8,
  edge_w_msg real default 0.6,
  edge_w_fk real default 0.4,
  edge_w_code real default 0.7,

  min_cluster_size int default 3,
  resolution real,

  enabled_layers jsonb default '["call","db","msg","code"]',

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique(workspace_id, name)
);
```

#### domain_candidates (Seed 기반 후보 큐)

```sql
create table domain_candidates (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  run_id uuid,
  object_id uuid not null references objects(id) on delete cascade,

  affinity_map jsonb not null,      -- {"<domainId>": 0.62, ...}
  purity real not null,
  primary_domain_id uuid references objects(id) on delete set null,
  secondary_domain_ids jsonb not null default '[]'::jsonb,

  signals jsonb not null default '{}'::jsonb,

  status text not null default 'PENDING', -- PENDING, APPROVED, REJECTED
  reviewed_at timestamptz,
  reviewed_by text,

  created_at timestamptz not null default now()
);

create index ix_domcand_ws_status on domain_candidates(workspace_id, status);
create index ix_domcand_ws_object on domain_candidates(workspace_id, object_id);
```

#### domain_candidate_evidences

```sql
create table domain_candidate_evidences (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  candidate_id uuid not null references domain_candidates(id) on delete cascade,
  evidence_id uuid not null references evidences(id) on delete cascade,
  primary key (workspace_id, candidate_id, evidence_id)
);
```

#### domain_discovery_runs (Seed-less 실행 스냅샷)

```sql
create table domain_discovery_runs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  profile_id uuid references domain_inference_profiles(id),
  algo text not null,               -- louvain, leiden
  algo_version text,
  input_layers jsonb not null,      -- ["call","db","msg","code"]
  parameters jsonb not null default '{}'::jsonb,

  graph_stats jsonb not null default '{}'::jsonb,
  status text not null default 'DONE', -- DONE, FAILED

  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index ix_ddr_ws_time on domain_discovery_runs(workspace_id, started_at desc);
```

#### domain_discovery_memberships (멤버십 스냅샷)

```sql
create table domain_discovery_memberships (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  run_id uuid not null references domain_discovery_runs(id) on delete cascade,

  object_id uuid not null references objects(id) on delete cascade,
  domain_id uuid not null references objects(id) on delete cascade,

  affinity real not null,           -- 0~1
  purity real,

  created_at timestamptz not null default now(),

  unique(workspace_id, run_id, object_id, domain_id)
);

create index ix_ddm_ws_run on domain_discovery_memberships(workspace_id, run_id);
create index ix_ddm_ws_object on domain_discovery_memberships(workspace_id, object_id);
create index ix_ddm_ws_domain on domain_discovery_memberships(workspace_id, domain_id);
```

#### domain_rollup_provenances

```sql
create table domain_rollup_provenances (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  generation_version bigint not null,
  domain_rollup_id uuid not null,
  source_service_rollup_id uuid not null,
  factor real not null,
  contributed_weight real not null,
  contributed_confidence real,
  created_at timestamptz default now()
);
```

### 4.5 Code 분석 테이블

#### code_artifacts (파일/모듈 메타)

```sql
create table code_artifacts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  language text not null,           -- java, kotlin, ts, js, python
  repo_root text,
  file_path text not null,
  package_name text,
  module_name text,

  owner_object_id uuid references objects(id) on delete set null,
  sha256 text,                      -- 파일 해시 (변경 감지)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(workspace_id, file_path)
);

create index ix_code_artifacts_ws_owner on code_artifacts(workspace_id, owner_object_id);
create index ix_code_artifacts_ws_lang on code_artifacts(workspace_id, language);
```

#### code_import_edges (Import 그래프)

```sql
create table code_import_edges (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  from_artifact_id uuid not null references code_artifacts(id) on delete cascade,
  to_module text,
  to_artifact_id uuid references code_artifacts(id) on delete set null,

  weight int not null default 1,
  evidence_id uuid references evidences(id) on delete set null,

  created_at timestamptz not null default now()
);

create index ix_import_edges_ws_from on code_import_edges(workspace_id, from_artifact_id);
create index ix_import_edges_ws_to on code_import_edges(workspace_id, to_artifact_id);
```

#### code_call_edges (Call 그래프)

```sql
create table code_call_edges (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  caller_artifact_id uuid not null references code_artifacts(id) on delete cascade,
  callee_symbol text not null,
  callee_owner_object_id uuid references objects(id) on delete set null,

  weight int not null default 1,
  evidence_id uuid references evidences(id) on delete set null,

  created_at timestamptz not null default now()
);

create index ix_call_edges_ws_caller on code_call_edges(workspace_id, caller_artifact_id);
create index ix_call_edges_ws_callee on code_call_edges(workspace_id, callee_owner_object_id);
```

### 4.6 변경 이력 테이블

#### change_logs (Append-only)

```sql
create table change_logs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,

  entity_type text not null,        -- OBJECT, RELATION, DOMAIN_AFFINITY
  entity_id uuid not null,
  action text not null,             -- CREATE, UPDATE, DELETE, APPROVE, REJECT

  before_snapshot jsonb,
  after_snapshot jsonb,
  changed_by text,

  created_at timestamptz not null default now()
);

create index ix_changelog_ws_entity on change_logs(workspace_id, entity_type, entity_id);
create index ix_changelog_ws_time on change_logs(workspace_id, created_at desc);
```

---

## 5. 스키마 요약 (테이블 목록)

| 그룹 | 테이블 | 설명 |
|------|--------|------|
| **Core** | `workspaces` | 워크스페이스 격리 |
| | `objects` | 통합 자산 저장 |
| | `tags` | 태그 정의 |
| | `object_tags` | Object-Tag N:M |
| | `object_relations` | 확정 관계 |
| | `relation_candidates` | 추론 후보 큐 |
| **Evidence** | `evidences` | 근거 원본 |
| | `relation_evidences` | 관계-근거 연결 |
| | `relation_candidate_evidences` | 후보-근거 연결 |
| **Rollup** | `object_rollups` | Materialized Roll-up |
| | `rollup_generations` | Generation 관리 |
| | `object_graph_stats` | 노드별 degree 통계 |
| **Domain** | `object_domain_affinities` | 도메인 소속 분포 |
| | `domain_inference_profiles` | 추론 설정 프로필 |
| | `domain_candidates` | 도메인 후보 큐 |
| | `domain_candidate_evidences` | 도메인 후보-근거 |
| | `domain_discovery_runs` | Discovery 실행 스냅샷 |
| | `domain_discovery_memberships` | Discovery 멤버십 |
| | `domain_rollup_provenances` | Domain Rollup 근거 |
| **Code** | `code_artifacts` | 코드 파일 메타 |
| | `code_import_edges` | Import 그래프 |
| | `code_call_edges` | Call 그래프 |
| **Audit** | `change_logs` | Append-only 변경 이력 |

**총 21개 테이블**

---

## 6. 운영 원칙 요약

1. 자동 추론 결과는 `relation_candidates` / `domain_candidates`에만 저장
2. 승인 후 `object_relations` / `object_domain_affinities`로 이동
3. Roll-up은 `object_rollups`에 Materialized 저장
4. UI는 항상 최신 `generation_version` (ACTIVE) 기준으로 조회
5. 수동 오버라이드 > 자동 추론 (우선순위)
6. 모든 변경은 `change_logs`에 append-only 기록

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [03-inference-engine.md](./03-inference-engine.md) | 추론 파이프라인 (후보 생성 과정) |
| [05-rollup-and-graph.md](./05-rollup-and-graph.md) | Rollup 계산 알고리즘 |
| [04-query-engine.md](./04-query-engine.md) | Query Engine (스키마 조회 방식) |
