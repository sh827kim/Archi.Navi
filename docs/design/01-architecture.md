# Archi.Navi — 시스템 아키텍처

작성일: 2026-02-22
문서 버전: v2.0

---

## 1. 아키텍처 개요

Archi.Navi는 **TypeScript 풀스택 모노레포** 구조로 설계한다.
Local-first를 기본 전제로, 개발자 로컬 환경에서 단일 프로세스로 실행 가능하며,
향후 Docker 기반 팀 배포까지 확장 가능한 구조를 갖는다.

### 시스템 레이어

```
┌─────────────────────────────────────────────────┐
│                Presentation Layer                │
│         Next.js 16 App Router + shadcn/ui        │
│   (Architecture View, Object Mapping, AI Chat)   │
├─────────────────────────────────────────────────┤
│                   API Layer                      │
│          Next.js 16 API Routes (REST)            │
│      (Graph API, Query API, Inference API)       │
├─────────────────────────────────────────────────┤
│               Core Engine Layer                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Query    │ │ Rollup   │ │ Inference        │ │
│  │ Engine   │ │ Engine   │ │ Engine           │ │
│  │(BFS/DFS) │ │(Materialize)│ │(Relation/Domain)│ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────┤
│               AI Reasoning Layer                 │
│   Query Router → Evidence Assembler → LLM        │
│          (Vercel AI SDK: 멀티 프로바이더)          │
├─────────────────────────────────────────────────┤
│                  Data Layer                      │
│        PostgreSQL / PGlite + Drizzle ORM         │
│     (Objects, Relations, Rollups, Evidence)       │
├─────────────────────────────────────────────────┤
│                  CLI Layer                        │
│            Commander.js + tsx                     │
│   (up, scan, infer, rebuild-rollup, export)      │
└─────────────────────────────────────────────────┘
```

---

## 2. 기술스택

### 2.1 핵심 기술

| 계층 | 기술 | 버전 | 근거 |
|------|------|------|------|
| **프론트엔드** | Next.js + React + TypeScript | 16.x + 19.x | 최신 App Router 기반, RSC 지원 |
| **UI 라이브러리** | TailwindCSS + shadcn/ui | 4.x | 유틸리티 기반 스타일링, 접근성 보장 컴포넌트 |
| **백엔드 API** | Next.js API Routes (App Router) | 16.x | 별도 서버 불필요, 단일 프로세스 배포 |
| **DB** | PostgreSQL + PGlite | 17.x + latest | Local-first 핵심. PGlite는 Node.js/WASM 네이티브 |
| **ORM** | Drizzle ORM | latest | TypeScript 네이티브, 경량, PGlite 호환, 타입 안전 |
| **그래프 알고리즘** | graphology | latest | BFS/DFS, 커뮤니티 탐지(Louvain/Leiden), 경로 탐색 |
| **그래프 시각화** | Cytoscape.js + 3d-force-graph | latest | 레이어드 뷰(Cytoscape) + 매핑 그래프(3D Force) |
| **AI/LLM** | Vercel AI SDK (`ai`) | latest | OpenAI, Claude, Gemini 멀티 프로바이더 지원, 스트리밍 |
| **상태관리** | Zustand | latest | 경량, TypeScript 친화, 보일러플레이트 최소 |
| **CLI** | Commander.js + tsx | latest | npm 배포 가능, TypeScript 직접 실행 |
| **모노레포** | Turborepo + pnpm | latest | 빌드 캐싱, 워크스페이스 관리 |
| **테스트** | Vitest + Playwright | latest | 단위 테스트 + E2E 테스트 |
| **린터/포맷터** | ESLint + Prettier | latest | 코드 품질 + 일관된 포맷팅 |

### 2.2 보조 라이브러리

| 용도 | 라이브러리 | 설명 |
|------|-----------|------|
| 유효성 검증 | zod | 런타임 스키마 검증, API 요청/응답 검증 |
| 날짜 처리 | date-fns | 경량 날짜 유틸리티 |
| UUID 생성 | uuid (v7) | 시간순 정렬 가능한 UUID |
| CSV Export | papaparse | Service List CSV 내보내기 |
| 코드 파싱(AST) | tree-sitter | Java/Kotlin/TS/JS/Python AST 추출 |

---

## 3. 모노레포 구조

```
archi-navi/
├── apps/
│   └── web/                          # Next.js 16 앱 (프론트엔드 + API)
│       ├── app/                      # App Router
│       │   ├── (dashboard)/          # 메인 대시보드 레이아웃
│       │   │   ├── architecture/     # Architecture View (Roll-up)
│       │   │   ├── mapping/          # Object Mapping View
│       │   │   ├── services/         # Service List + Export
│       │   │   ├── approval/         # 추론 승인 관리
│       │   │   ├── chat/             # AI Chat
│       │   │   └── settings/         # 워크스페이스 설정
│       │   ├── api/                  # API Routes
│       │   │   ├── objects/          # Object CRUD
│       │   │   ├── relations/        # Relation CRUD + 승인
│       │   │   ├── rollups/          # Rollup 조회/재빌드
│       │   │   ├── query/            # Query Engine API
│       │   │   ├── inference/        # 추론 실행 API
│       │   │   ├── domains/          # Domain 관리 API
│       │   │   └── chat/             # AI Chat API (스트리밍)
│       │   ├── layout.tsx
│       │   └── page.tsx
│       ├── components/               # 앱 전용 컴포넌트
│       ├── hooks/                    # 커스텀 훅
│       ├── stores/                   # Zustand 스토어
│       └── lib/                      # 앱 전용 유틸리티
│
├── packages/
│   ├── core/                         # 핵심 엔진
│   │   ├── src/
│   │   │   ├── graph-store/          # DB 접근 (Rollup/Relation/Evidence)
│   │   │   ├── graph-index/          # Adjacency 캐시 빌더
│   │   │   ├── query-engine/         # BFS/DFS/경로/랭킹
│   │   │   ├── query-dsl/            # QueryRequest/Response 스키마
│   │   │   └── rollup/               # Rollup 계산/재빌드
│   │   └── package.json
│   │
│   ├── inference/                    # 추론 엔진
│   │   ├── src/
│   │   │   ├── relation/             # Relation 추론
│   │   │   ├── domain/               # Domain 추론 (Track A/B)
│   │   │   ├── code/                 # Code Signal 추출 (Regex/AST)
│   │   │   ├── db/                   # DB Signal 추출
│   │   │   └── llm/                  # 후보 LLM 필터링
│   │   └── package.json
│   │
│   ├── db/                           # DB 스키마 + 마이그레이션
│   │   ├── src/
│   │   │   ├── schema/               # Drizzle 스키마 정의
│   │   │   ├── migrations/           # 마이그레이션 파일
│   │   │   └── client.ts             # DB 클라이언트 (PGlite/PostgreSQL)
│   │   └── package.json
│   │
│   ├── cli/                          # CLI 도구
│   │   ├── src/
│   │   │   ├── commands/             # up, scan, infer, rebuild, export, snapshot
│   │   │   └── index.ts              # CLI 엔트리포인트
│   │   ├── bin/
│   │   │   └── anavi.ts              # npx 실행 엔트리
│   │   └── package.json
│   │
│   ├── shared/                       # 공유 타입/유틸리티
│   │   ├── src/
│   │   │   ├── types/                # 공용 TypeScript 타입
│   │   │   ├── constants/            # 상수 (Object Type, Relation Type 등)
│   │   │   └── utils/                # 공용 유틸리티
│   │   └── package.json
│   │
│   └── ui/                           # 공유 UI 컴포넌트
│       ├── src/
│       │   └── components/           # shadcn 기반 공유 컴포넌트
│       └── package.json
│
├── docs/                             # 설계 문서
├── turbo.json                        # Turborepo 설정
├── pnpm-workspace.yaml               # pnpm 워크스페이스
├── package.json                      # 루트 package.json
├── tsconfig.base.json                # 공유 TypeScript 설정
└── .env.example                      # 환경변수 예시
```

---

## 4. 패키지별 책임

### 4.1 `apps/web` — Next.js 앱

- **책임**: UI 렌더링, API 라우트, 사용자 인터랙션
- **기술**: Next.js 16 App Router, React 19, TailwindCSS, shadcn/ui, Zustand
- **주요 페이지**:
  - Architecture View: 레이어드 아키텍처 시각화 (Cytoscape)
  - Object Mapping View: 타입 필터 + drill-down/roll-down
  - Service List: 서비스 목록 + CSV Export
  - Approval: 추론 후보 승인/반려
  - AI Chat: 구조 질의 + Evidence 기반 응답
  - Settings: 워크스페이스 관리, 추론 프로필 설정

### 4.2 `packages/core` — 핵심 엔진

- **책임**: 그래프 연산, 쿼리 처리, Rollup 계산
- **모듈**:
  - `graph-store`: DB에서 Rollup/Relation/Evidence 조회
  - `graph-index`: Adjacency list 인메모리 캐시 빌더
  - `query-engine`: BFS/DFS 기반 경로 탐색, 영향도 분석, 랭킹
  - `query-dsl`: QueryRequest/QueryResponse 스키마 + zod 검증
  - `rollup`: Materialized Roll-up 계산, Generation 관리

### 4.3 `packages/inference` — 추론 엔진

- **책임**: Relation 추론, Domain 추론 (Track A/B)
- **모듈**:
  - `relation`: 설정 파일 기반 관계 후보 생성 + 후보 승인 시 확정 관계 승격
  - `domain`: Seed 기반 Affinity 계산 + Seed-less Discovery + 후보 승인 처리
  - `code`: 코드 신호 추출(Regex 기본, `code/ast`에 AST 파서 모듈)
  - `db`: DB 스키마 신호(FK/implicit) 추출 및 후보/근거 저장
  - `llm`: 후보 후처리(필터링/배치) 모듈
- **디렉토리 정합 메모(2026-03-01)**:
  - 실제 구현 파일은 `src/relation`, `src/domain`, `src/code`, `src/db`, `src/llm`에 위치
  - `src/signals`, `src/ast` 디렉토리는 현재 placeholder 상태(실행 모듈 없음)

### 4.4 `packages/db` — 데이터베이스

- **책임**: 스키마 정의, 마이그레이션, DB 클라이언트
- **특징**: PGlite(로컬)와 PostgreSQL(서버) 모두 지원하는 듀얼 클라이언트

### 4.5 `packages/cli` — CLI 도구

- **책임**: 터미널 기반 조작
- **명령어**:
  - `anavi up` — 웹 앱 실행 (모노레포 또는 설치된 web 패키지 자동 탐색)
  - `anavi scan` — 소스코드/설정 스캔
  - `anavi infer` — 도메인 추론 실행 (Track A/B)
  - `anavi rebuild-rollup` — Roll-up 전체 재빌드
  - `anavi export` — 데이터 내보내기 (JSON/DOT)
  - `anavi snapshot` — 현재 상태 스냅샷 저장

### 4.6 `packages/shared` — 공유 코드

- **책임**: 패키지 간 공유 타입, 상수, 유틸리티
- **내용**: Object Type Enum, Relation Type Enum, Query Type Enum, 공용 타입 정의

### 4.7 `packages/ui` — 공유 UI

- **책임**: shadcn/ui 기반 공유 컴포넌트
- **내용**: Button, Dialog, DataTable, Badge 등 재사용 컴포넌트

---

## 5. 배포 전략

### 5.1 Local-first (기본)

```bash
# 웹 앱 실행
pnpm install
pnpm dev

# 필요 시 CLI 실행
pnpm --filter @archi-navi/cli exec anavi --help
```

- PGlite를 내장 DB로 사용 (별도 DB 설치 불필요)
- 단일 프로세스로 Next.js 앱 + API 실행
- 데이터는 `PGLITE_DATA_DIR` 기준 경로에 저장 (기본: `.archi-navi/data`)

### 5.2 Docker (팀 배포)

```yaml
# docker-compose.yml
services:
  app:
    image: archi-navi:latest
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:password@db:5432/archinavi
    depends_on:
      - db

  db:
    image: postgres:17
    environment:
      - POSTGRES_DB=archinavi
      - POSTGRES_PASSWORD=password
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### 5.3 환경별 DB 전략

| 환경 | DB | 설명 |
|------|-----|------|
| **로컬 개발** | PGlite (내장) | 설치 불필요, `~/.archi-navi/data/` 저장 |
| **팀 배포** | PostgreSQL 17 | Docker Compose로 실행, 외부 접속 가능 |
| **향후 클라우드** | Managed PostgreSQL | Neon, Supabase 등 연동 가능 |

---

## 6. API 설계 원칙

### 6.1 RESTful API 구조

```
/api/workspaces                    # 워크스페이스 CRUD
/api/objects                       # Object CRUD + 검색
/api/objects/:id                   # Object 상세/수정/삭제
/api/objects/:id/tags              # Object 태그 연결
/api/relations                     # Relation CRUD
/api/inference/candidates          # 관계 후보 조회
/api/inference/candidates/:id      # 관계 후보 승인/거부
/api/rollups                       # Rollup 그래프 조회
/api/query                         # Deterministic Query Engine
/api/inference/run                 # 추론 실행
/api/inference/domain-candidates   # 도메인 후보 조회
/api/inference/domain-candidates/:id # 도메인 후보 승인/거부
/api/domains                       # Domain 조회
/api/chat                          # AI Chat (스트리밍)
/api/scan                          # 프로젝트 스캔 + 서비스 등록
```

### 6.2 공통 응답 형식

```typescript
interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    total?: number;
    page?: number;
    generationVersion?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}
```

---

## 7. 보안 및 설정

### 7.1 환경변수

```env
# DB
DATABASE_URL=postgresql://...       # PostgreSQL URL (팀 배포)
PGLITE_DATA_DIR=~/.archi-navi/data  # PGlite 데이터 디렉토리

# AI
AI_PROVIDER=openai                  # openai | anthropic | google
AI_API_KEY=sk-...                   # AI 프로바이더 API 키
AI_MODEL=gpt-4o                     # 사용할 모델

# App
NODE_ENV=development
PORT=3000
```

### 7.2 v1 보안 범위

- v1은 Local-first 단일 사용자 전제
- 인증/인가 시스템 미포함 (Out of Scope)
- API 키는 환경변수로 관리

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [00-overview.md](../00-overview.md) | 프로젝트 개요, 범위, 원칙 |
| [02-data-model.md](./02-data-model.md) | Object/Relation 모델, DB 스키마 |
| [01-development-guide.md](../01-development-guide.md) | 개발 환경 설정, 컨벤션 |
