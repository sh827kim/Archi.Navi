# Archi.Navi — 시스템 아키텍처

작성일: 2026-02-22
최종 갱신: 2026-03-31
문서 버전: v3.0

---

## 1. 제품 정의

Archi.Navi는 단순한 그래프 뷰어가 아니라, 워크스페이스 단위로 코드/설정/스키마를 수집하고
추론 결과를 승인 가능한 후보로 관리하며, rollup과 query/chat을 통해 구조를 탐색하는
**local-first 아키텍처 지식 운영 시스템**이다.

핵심 원칙은 아래 4가지다.

| 원칙 | 설명 |
|------|------|
| **Workspace 중심** | 모든 데이터는 `workspace_id` 기준으로 격리된다. |
| **승인 게이트** | 자동 추론 결과는 후보로만 저장하고, 승인 후에만 확정 관계/도메인에 반영한다. |
| **결정론 우선** | 그래프 계산과 query 결과는 deterministic engine이 담당하고, LLM은 보조 레이어로 사용한다. |
| **운영 가시성 포함** | inference run 상태, source 해석, 이벤트 로그, rollup 갱신을 제품의 1급 기능으로 다룬다. |

---

## 2. 런타임 레이어

```text
┌──────────────────────────────────────────────────────────────┐
│ Presentation                                                 │
│ Next.js App Router pages                                     │
│ - Dashboard / Approval / Architecture / Mapping / Query      │
│ - Chat / Settings / Inference Runs / Workspaces              │
├──────────────────────────────────────────────────────────────┤
│ Application Adapters                                         │
│ Next.js Route Handlers + Server Actions                      │
│ - scan / objects / relations / rollups / query / chat        │
│ - inference(run, runs, smart, candidates, domain-run)        │
├──────────────────────────────────────────────────────────────┤
│ Domain Engines                                               │
│ packages/core       : query-engine, rollup, graph-index      │
│ packages/inference  : relation/domain inference, orchestration│
│ packages/db         : schema, client, migrations             │
├──────────────────────────────────────────────────────────────┤
│ Persistence / Integration                                    │
│ Embedded PostgreSQL or PostgreSQL + Drizzle ORM              │
│ Local FS / optional GitHub source resolution / SSE           │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 계층별 책임

| 계층 | 책임 | 구현 포인트 |
|------|------|------------------|
| UI | 운영/탐색 화면 제공 | `apps/web/src/app/(dashboard)/*`, `components/*` |
| Application Adapter | HTTP 계약, 입력 검증, thin orchestration 연결 | `apps/web/src/app/api/**` |
| Core Engine | rollup, graph cache, query, evidence composition | `packages/core/src/*` |
| Inference Engine | code/config/db/openapi 신호 수집, 후보 생성, smart pipeline, run orchestration | `packages/inference/src/*` |
| Data Layer | 스키마, DB 클라이언트, migration | `packages/db/src/*` |
| Shared/CLI | 공통 타입/상수/ID 생성, CLI 진입점 | `packages/shared`, `packages/cli` |

---

## 3. 주요 런타임 플로우

## 3.1 스캔 및 워크스페이스 등록

```text
사용자
  → Workspaces / Settings
  → /api/workspaces, /api/scan, /api/scan/paths, /api/fs/browse
  → service/object 등록 + scan path 저장
```

- 로컬 경로 선택과 워크스페이스 생성은 UI에서 처리한다.
- 스캔 결과는 `objects`와 관련 metadata에 반영된다.
- 이후 inference는 직접 전달된 source 또는 service metadata path를 재사용할 수 있다.

## 3.2 표준 추론 실행

```text
Approval / API / CLI
  → quick run: /api/inference/run
  → async run: /api/inference/runs
  → code/config/db inference
  → relation/domain candidates 저장
  → run stats / warnings / events 기록
```

- quick run은 즉시성 있는 실행 경로다.
- async run은 운영 기록, source 상태, event log를 포함한 실행 경로다.
- remote source는 `githubRepo` / `githubOrg` 타입으로 해석 후 local clone 경로로 변환된다.

## 3.3 Smart 추론 실행

```text
Approval UI
  → /api/inference/smart
  → OpenAPI import
  → code expose bootstrap
  → config 기반 service pair 탐지
  → pair-scoped atomic inference
  → fallback/deep inspection trace 저장
```

- Smart는 제품에서 별도 inference 모드로 취급한다.
- 출력은 단순 후보 목록이 아니라 `servicePairCount`, `atomicCandidateCount`,
  `serviceFallbackCount`, `agentRecoveredAtomicCount` 등 운영 통계를 포함한다.

## 3.4 승인과 rollup 반영

```text
Approval / manual relation mutation
  → candidate approve / reject
  → object_relations, object_domain_affinities 반영
  → delta rollup 적용
  → SSE notification
  → Architecture / Mapping / Layered View refetch
```

- 후보 승인 후 즉시 전체 rebuild를 강제하지 않는다.
- 기본 경로는 `applyRollupChanges` 기반의 증분 반영과 SSE 알림이다.

## 3.5 Query 와 Chat

```text
Query Page
  → /api/query
  → deterministic engine

Chat Page
  → /api/chat
  → intent routing
  → deterministic query 또는 object retrieval
  → evidence assembly + LLM formatting
```

- query page는 엔진 계약을 직접 드러내는 운영 UI다.
- chat은 자연어 진입점이지만, 계산 자체는 가능한 한 deterministic 결과를 재사용한다.

---

## 4. 실제 모노레포 구조와 책임

## 4.1 앱 레이어

| 경로 | 책임 |
|------|------|
| `apps/web/src/app/(dashboard)` | 대시보드, 승인, 아키텍처, 매핑, 쿼리, 채팅, 설정, 추론 이력 |
| `apps/web/src/app/api` | route handlers 전반 |
| `apps/web/src/components` | 승인/그래프/채팅/설정/워크스페이스 UI |
| `apps/web/src/lib` | rollup SSE, smart run helper, query/chat 보조 로직 |

### 주요 페이지

- `/home`: 운영 요약과 빠른 액션
- `/approval`: 표준 추론, Smart 추론, 후보 승인/반려, fallback 힌트
- `/architecture`: 레이어드 구조 시각화
- `/mapping-graph`: 3D rollup 그래프, contributor 패널, hub 제어
- `/query`: deterministic query 실행 UI
- `/chat`: AI architecture assistant
- `/settings`: 워크스페이스/스캔/기본 설정
- `/inference-runs`: 비동기 추론 실행 운영 화면
- `/workspaces`, `/workspaces/new`: 워크스페이스 온보딩

## 4.2 패키지 레이어

| 패키지 | 책임 | 핵심 모듈 |
|--------|------|-----------|
| `packages/core` | 그래프 조회와 계산 | `query-engine`, `rollup`, `graph-index`, `graph-store`, `ai` |
| `packages/inference` | 추론과 실행 orchestration | `relation`, `domain`, `code`, `db`, `openapi`, `llm`, `orchestration` |
| `packages/db` | 스키마와 클라이언트 | `schema/core`, `schema/rollup`, `schema/domain`, `schema/code`, `schema/audit`, `schema/layers` |
| `packages/shared` | 타입/상수/유틸리티 | query/request 타입, enum, `generateId`, path/URN 유틸 |
| `packages/ui` | 공유 UI primitive | button, badge, input, select, spinner 등 |
| `packages/cli` | CLI 진입점 | `scan`, `infer`, `rebuild-rollup`, `snapshot`, `up`, `export` |

---

## 5. API 표면

App Router 기준 주요 API 그룹은 아래와 같다.

| 그룹 | 주요 라우트 |
|------|-------------|
| Workspace/Scan | `/api/workspaces`, `/api/scan`, `/api/scan/paths`, `/api/fs/browse` |
| Object/Relation | `/api/objects`, `/api/relations`, `/api/tags`, `/api/object-tags` |
| Inference | `/api/inference/run`, `/api/inference/runs`, `/api/inference/smart`, `/api/inference/candidates`, `/api/inference/domain-run` |
| Rollup/Mapping | `/api/rollups`, `/api/rollup-events`, `/api/mapping/contributors` |
| Query/Chat | `/api/query`, `/api/chat` |
| Dashboard/Architecture | `/api/dashboard/summary`, `/api/layers`, `/api/domain-affinities`, `/api/domains` |

설계 원칙은 동일하다.

- route는 얇게 유지한다.
- 비즈니스 로직은 `packages/core`, `packages/inference`, `packages/db`로 내린다.
- UI는 API 계약이나 server action을 통해 상태를 읽고, 운영 화면은 run/event 단위로 추적 가능해야 한다.

---

## 6. 설계 방향

## 6.1 유지하는 방향

- **결정론 엔진 + AI 보조**: LLM이 시스템의 기준 진실을 대체하지 않는다.
- **비동기 운영 모델 강화**: inference는 실행 기록과 source 상태를 포함한 운영 기능으로 다룬다.
- **원자 관계 우선 저장**: 상위 관계는 rollup으로 파생하고, 증거 추적 체인을 유지한다.
- **실시간 반영은 refetch 기반**: edge delta를 직접 푸시하기보다 SSE notification + refetch로 정합성을 유지한다.
- **UI는 progressive disclosure**: 대규모 그래프는 hub collapse, domain-first, contributor drill-down으로 점진 노출한다.

## 6.2 의도적으로 하지 않는 것

- 별도 장기 실행 백엔드 서버 분리
- WebSocket 기반 복잡한 collaborative graph editing
- LLM이 후보를 자동 승인하는 무감독 운영
- query/chat을 완전 agent형 planner로 재구성

---

## 7. 실행 환경과 배포

## 7.1 기본 개발 환경

```bash
pnpm install
pnpm dev
```

- 기본 개발 경로는 Next.js 앱 단일 실행이다.
- 로컬 기본 DB는 `ARCHI_NAVI_DB_DATA_DIR` 기반 embedded postgres 저장소를 사용한다.
- migration 경로는 `packages/db/src/migrations`를 기준으로 한다.

## 7.2 확장 실행 환경

- PostgreSQL 연결 시 `DATABASE_URL` 기반 Drizzle 클라이언트를 사용한다.
- remote GitHub source inference는 `gh` CLI 인증 상태를 사용한다.
- rollup 실시간 반영은 SSE를 기본으로 하고, 브라우저/연결 상태에 따라 polling fallback을 사용한다.

---

## 8. 관련 문서

- [02-data-model.md](./02-data-model.md)
- [03-inference-engine.md](./03-inference-engine.md)
- [04-query-engine.md](./04-query-engine.md)
- [05-rollup-and-graph.md](./05-rollup-and-graph.md)
- [06-compound-view.md](./06-compound-view.md)
