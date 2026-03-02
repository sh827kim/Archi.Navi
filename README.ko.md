# Archi.Navi

[English](README.md)

> 분산 서비스 환경을 위한 Local-first 아키텍처 내비게이션 도구
> *추측하지 말고, 구조를 직접 확인하세요.*

---

## 이런 고민, 해보신 적 있으신가요?

마이크로서비스를 운영하다 보면 다음과 같은 상황을 자주 겪게 됩니다.

- 이 변경이 어떤 서비스에 영향을 줄까?
- 작은 수정이 왜 예상치 못한 다른 장애로 이어졌을까?
- 아키텍처 다이어그램이 실제와 여전히 일치할까?
- 이 Kafka 토픽 / DB 테이블 / API 엔드포인트는 누가 관리하고 있을까?

MSA는 정적 문서보다 빠르게 변화합니다.

**Archi.Navi**는 이 간극을 해소합니다. 소스코드와 설정을 분석해 **탐색 가능한 아키텍처 지도**를 만들고,
승인 기반 워크플로우와 Evidence 중심 AI Chat을 통해 현실을 반영한 구조를 유지합니다.

---

## 핵심 개념

| 용어 | 설명 |
|------|------|
| **Object** | 통합 모델 단위. 서비스, API 엔드포인트, DB, 테이블, 토픽, 큐 — 모두 `Object`로 표현 |
| **Relation** | 오브젝트 간 타입 있는 연결 (`call`, `read`, `write`, `produce`, `consume`, `expose`, `depend_on`) |
| **Roll-up View** | 빠른 영향도 분석을 위한 요약 구조 관점 (서비스 간, 도메인 간) |
| **Roll-down View** | 특정 오브젝트를 기준으로 원자 단위까지 상세 흐름을 파고드는 관점 |
| **승인 큐** | 자동 추론 결과를 즉시 반영하지 않고, 승인/반려를 거쳐 적용 |
| **Evidence** | 추론된 관계 또는 AI 응답을 뒷받침하는 근거 (파일 경로, 라인, 발췌문) |
| **Workspace** | 멀티 레포/멀티 조직 확장을 위한 논리적 격리 단위 |

---

## 주요 기능

### 1. 서비스 목록 (Service Overview)

- 서비스 목록 조회, 검색, 태그, 가시성 관리
- Alias / Type / Visibility 편집
- CSV Export

### 2. 아키텍처 뷰 (Architecture View)

- 레이어드 아키텍처 시각화 (Roll-up 관점)
- 드래그 앤 드롭 레이어 관리
- PNG Export

### 3. Object Mapping View

- 인터랙티브 의존성 그래프 (Roll-up & Roll-down)
- 엣지 타입 필터링 (`call`, `read`, `write`, `produce`, `consume`)
- 뷰 레벨 전환: Domain → Service → Atomic

### 4. 승인 워크플로우 (Approval Workflow)

- 자동 추론 관계는 모두 `PENDING` 큐에 적재 후 검토
- Evidence 확인 후 일괄 승인/반려
- 수동 오버라이드는 항상 자동 추론보다 우선

### 5. AI Chat (Evidence 중심)

- 실제 그래프 데이터 기반 아키텍처 질의 응답
- Confidence + Evidence 기반 응답
- OpenAI, Anthropic, Google 멀티 프로바이더 지원 (Vercel AI SDK)
- Evidence 없는 확정형 답변 금지

---

## 레포 구조

```
archi-navi/
├── apps/
│   └── web/                    # Next.js 16 앱 (UI + API Routes)
│       ├── (dashboard)/        # Architecture View, Services, Approval, Chat
│       └── api/                # REST API 라우트
│
└── packages/
    ├── core/                   # 쿼리 엔진 (BFS/DFS), Rollup, 그래프 인덱스
    ├── inference/              # Relation & Domain 추론 엔진
    ├── db/                     # Drizzle ORM 스키마 + 마이그레이션
    ├── cli/                    # CLI (scan, infer, rebuild-rollup, export, snapshot)
    ├── shared/                 # 공유 타입, 상수, 유틸리티
    └── ui/                     # 공유 shadcn/ui 컴포넌트
```

---

## 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | Next.js 16 (App Router) + React 19 + TypeScript |
| UI 라이브러리 | TailwindCSS 4 + shadcn/ui |
| 그래프 시각화 | Cytoscape.js + D3 Force |
| 상태 관리 | Zustand |
| 데이터베이스 | PGlite (로컬) / PostgreSQL 17 (팀 배포) |
| ORM | Drizzle ORM |
| AI / LLM | Vercel AI SDK (OpenAI, Anthropic, Google) |
| 모노레포 | Turborepo + pnpm |
| CLI | Commander.js + tsx |
| 테스트 | Vitest + Playwright |

---

## 시작하기

### 사전 요구사항

- Node.js 22.x LTS
- pnpm 10.x

### 설치

```bash
# 저장소 클론
git clone https://github.com/your-org/archi-navi.git
cd archi-navi

# 의존성 설치
pnpm install

# 환경변수 설정
cp .env.example .env.local
# .env.local 편집 — 최소한 AI_API_KEY 설정 필요
```

### 환경변수

```env
# DB — 기본적으로 PGlite 사용 (별도 설치 불필요)
# PostgreSQL 사용 시 아래 주석 해제
# DATABASE_URL=postgresql://postgres:password@localhost:5432/archinavi

# PGlite 데이터 저장 경로 (기본: .archi-navi/data)
PGLITE_DATA_DIR=.archi-navi/data

# AI 프로바이더: openai | anthropic | google
AI_PROVIDER=openai
AI_API_KEY=sk-your-api-key
AI_MODEL=gpt-4.1

# 앱
NODE_ENV=development
PORT=3000
```

### 개발 서버 실행

```bash
pnpm dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)으로 접속합니다.

---

## 주요 스크립트

```bash
pnpm dev            # 개발 서버 실행 (Next.js + HMR)
pnpm build          # 프로덕션 빌드
pnpm test           # 전체 테스트 실행
pnpm lint           # ESLint 검사
pnpm format         # Prettier 포맷팅
pnpm db:generate    # 스키마에서 Drizzle 마이그레이션 생성
pnpm db:migrate     # 마이그레이션 적용
pnpm db:studio      # Drizzle Studio 열기 (DB 브라우저)
```

---

## CLI 사용법

CLI는 소스코드 스캔, 추론 실행, 데이터 관리에 사용합니다.

모노레포를 클론하지 않고 npm 패키지로만 사용할 때:

```bash
npm install -g @archi-navi/cli @archi-navi/web
```

어디서든 웹 앱 실행:

```bash
anavi up --port 3000
```

npm 설치 실행 시 기본 런타임 경로:
- `PGLITE_DATA_DIR`: `~/.archi-navi/data`
- `MIGRATIONS_FOLDER`: 설치된 `@archi-navi/db`에서 자동 탐색

필요 시 환경변수로 덮어쓰기:

```bash
PGLITE_DATA_DIR="$HOME/.archi-navi/data" \
MIGRATIONS_FOLDER="/custom/path/to/migrations" \
anavi up --port 3000
```

```bash
# 웹 앱 실행 (모노레포 또는 설치된 @archi-navi/web 자동 탐색)
anavi up --port 3000

# 소스코드/레포 스캔 (서비스 등록)
anavi scan --workspace <workspaceId> --path /path/to/project

# (옵션) 워크스페이스 폴더 일괄 스캔
anavi scan --workspace <workspaceId> --workspace-dir /path/to/workspace

# 도메인 추론 실행 (Track A/B)
anavi infer --workspace <workspaceId> --track all

# Rollup 그래프 재빌드
anavi rebuild-rollup --workspace <workspaceId>

# 데이터 내보내기
anavi export --workspace <workspaceId> --format json --output ./export.json

# 현재 상태 스냅샷 저장
anavi snapshot save --output ./anavi-snapshot.db
```

관계 추론(후보 생성)은 Web API로 실행:

```bash
curl -X POST http://localhost:3000/api/inference/run \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<workspaceId>","modes":["config","db"],"useServiceMetadataPaths":true}'
```

### npm 배포 (메인테이너)

```bash
# 1) 배포 대상 패키지 pack 검증
pnpm release:pack:npm

# 2) publish dry-run
pnpm release:publish:npm:dry-run

# 3) 실제 npm publish
pnpm release:publish:npm
```

---

## 추론 엔진

Archi.Navi는 소스코드에서 관계를 자동으로 추론합니다.

| 신호 소스 | 추론 관계 | 예시 |
|-----------|----------|------|
| HTTP 클라이언트 호출 | `call` | `RestTemplate.getForObject(...)` |
| API 컨트롤러 선언 | `expose` | `@GetMapping("/api/orders")` |
| 메시지 프로듀서 | `produce` | `kafkaTemplate.send("order.created")` |
| 메시지 컨슈머 | `consume` | `@KafkaListener(topics="order.created")` |
| DB SELECT | `read` | JPA Repository, MyBatis XML |
| DB INSERT/UPDATE | `write` | JPA Repository, MyBatis XML |

도메인 추론은 두 가지 트랙을 지원합니다.
- **Track A (Seed 기반)**: 사용자가 도메인 이름을 정의하면, 엔진이 Affinity 점수를 계산
- **Track B (Seed-less Discovery)**: 관계 그래프에서 Louvain 커뮤니티 탐지로 도메인 자동 발견

모든 추론 결과는 **승인 큐**를 거친 후 적용됩니다.

---

## 데이터 모델

모든 자산은 단일 `Object` 모델로 통합 관리합니다.

| 카테고리 | 집합체 (Compound) | 원자 단위 (Atomic) |
|----------|-------------------|-------------------|
| COMPUTE | `service` | `api_endpoint`, `function` |
| STORAGE | `database`, `cache_instance` | `db_table`, `db_view`, `cache_key` |
| CHANNEL | `message_broker` | `topic`, `queue` |

관계는 원자 단위로 저장하고, Roll-up 뷰는 Materialized 계산으로 파생합니다.

---

## 구현 현황 (v1)

| 항목 | 상태 |
|------|------|
| Architecture View (레이어드, Roll-up) | ✅ 완료 |
| Object Mapping View (Roll-up + Roll-down) | ✅ 완료 |
| Service List + CSV Export | ✅ 완료 |
| Tag / Visibility 관리 | ✅ 완료 |
| 승인 워크플로우 (일괄 승인/반려) | ✅ 완료 |
| 멀티 워크스페이스 지원 | ✅ 완료 |
| Rollup 엔진 (4단계: S2S, S2DB, S2Broker, D2D) | ✅ 완료 |
| 쿼리 엔진 (BFS/DFS, 경로, 영향도, 사용 탐색) | ✅ 완료 |
| 도메인 추론 Track A (Seed 기반) | ✅ 완료 |
| 도메인 추론 Track B (Louvain Discovery) | ✅ 완료 |
| AI Chat (스트리밍, 멀티 프로바이더) | ✅ 완료 |
| DB 시그널 추출 (추론 정밀도 향상) | ✅ 완료 |
| AST 플러그인 (Tree-sitter/WASM) | ⚠️ 부분 구현 (기본 파이프라인은 Regex 중심) |
| Evidence Assembler (AI Chat 연동) | ✅ 완료 |

---

## 문서

| 문서 | 설명 |
|------|------|
| [docs/README.md](./docs/README.md) | 문서 체계 가이드 (Design / SPEC / Guide) |
| [docs/design/README.md](./docs/design/README.md) | 설계 문서 인덱스 |
| [docs/spec/README.md](./docs/spec/README.md) | SPEC 문서 인덱스 |
| [docs/00-overview.md](./docs/00-overview.md) | 제품 개요, 원칙, 범위 |
| [docs/design/01-architecture.md](./docs/design/01-architecture.md) | 시스템 아키텍처, 기술 스택 |
| [docs/design/02-data-model.md](./docs/design/02-data-model.md) | Object/Relation 모델, DB 스키마 |
| [docs/design/03-inference-engine.md](./docs/design/03-inference-engine.md) | 추론 엔진 설계 |
| [docs/design/04-query-engine.md](./docs/design/04-query-engine.md) | 쿼리 엔진 (BFS/DFS, 영향도 분석) |
| [docs/design/05-rollup-and-graph.md](./docs/design/05-rollup-and-graph.md) | Rollup 전략 및 그래프 성능 |
| [docs/design/06-compound-view.md](./docs/design/06-compound-view.md) | Compound Dependency View 설계 |
| [docs/01-development-guide.md](./docs/01-development-guide.md) | 개발 가이드 및 컨벤션 |
| [docs/02-implementation-status.md](./docs/02-implementation-status.md) | v1 구현 현황 |
| [docs/03-roadmap.md](./docs/03-roadmap.md) | v2+ 로드맵 |
| [docs/spec/01-db-inference-index-unique-spec.md](./docs/spec/01-db-inference-index-unique-spec.md) | DB 추론 확장 스펙 (인덱스/유니크 패턴) |
| [docs/spec/02-object-mapping-3d-renderer-spec.md](./docs/spec/02-object-mapping-3d-renderer-spec.md) | Object Mapping 3D 렌더러 전환 스펙 |
| [docs/spec/03-compound-view-implementation-spec.md](./docs/spec/03-compound-view-implementation-spec.md) | Compound View 구현 스펙 |
| [docs/spec/04-llm-inference-filtering-spec.md](./docs/spec/04-llm-inference-filtering-spec.md) | LLM 추론 후보 필터링 스펙 |
| [docs/spec/05-llm-inference-filtering-spec-checklist.md](./docs/spec/05-llm-inference-filtering-spec-checklist.md) | LLM 추론 후보 필터링 구현 체크리스트 |
| [docs/spec/06-incremental-rollup-rebuild-spec.md](./docs/spec/06-incremental-rollup-rebuild-spec.md) | 증분 Rollup 리빌드 스펙 |
| [docs/spec/07-hub-node-management-spec.md](./docs/spec/07-hub-node-management-spec.md) | Hub 노드 관리 스펙 |
| [docs/spec/08-progressive-rendering-spec.md](./docs/spec/08-progressive-rendering-spec.md) | 프로그레시브 렌더링 스펙 |
| [docs/spec/09-domain-first-navigation-spec.md](./docs/spec/09-domain-first-navigation-spec.md) | Domain-first 내비게이션 스펙 |
| [docs/spec/10-incremental-inference-spec.md](./docs/spec/10-incremental-inference-spec.md) | 증분 추론 스펙 |
| [docs/spec/11-ast-default-code-signal-spec.md](./docs/spec/11-ast-default-code-signal-spec.md) | AST 기본 코드 시그널 스펙 |
| [docs/spec/12-ast-regex-hybrid-code-signal-spec.md](./docs/spec/12-ast-regex-hybrid-code-signal-spec.md) | AST + Regex 하이브리드 코드 시그널 스펙 |

---

> Archi.Navi는 정적 문서가 아닙니다.
> **MSA 운영을 위한 실전 아키텍처 내비게이션 도구**입니다.
