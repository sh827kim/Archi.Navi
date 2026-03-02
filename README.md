# Archi.Navi

[한국어](README.ko.md)

> A Local-first Architecture Navigation Tool for Distributed Service Environments
> *Stop guessing your system. Start seeing it clearly.*

---

## The Problem

Operating microservices raises difficult questions — repeatedly:

- Which services are affected by this change?
- Why did a small fix trigger failures elsewhere?
- Is our architecture diagram still aligned with reality?
- Who owns this Kafka topic / DB table / API endpoint?

MSA systems evolve faster than static documents.

**Archi.Navi** addresses this gap by turning your repositories into an
**explorable architecture map** — with approval-based knowledge updates,
Evidence-backed AI Chat, and a graph that reflects reality.

---

## Core Concepts

| Term | Description |
|------|-------------|
| **Object** | The unified unit. Services, API endpoints, databases, tables, topics, queues — all represented as `Object` |
| **Relation** | A typed connection between objects (`call`, `read`, `write`, `produce`, `consume`, `expose`, `depend_on`) |
| **Roll-up View** | A summarized architecture perspective for fast impact analysis (service-to-service, domain-to-domain) |
| **Roll-down View** | Drill-down into a specific object to see atomic-level detail flows |
| **Approval Queue** | Inferred changes are queued first; applied only after approve/reject |
| **Evidence** | Source context (file path, line, excerpt) backing every inferred relation or AI answer |
| **Workspace** | Logical isolation boundary for multi-repo/multi-org expansion |

---

## Key Features

### 1. Service Overview

- Service list with search, tag, and visibility controls
- Alias / Type / Visibility management
- CSV export

### 2. Architecture View

- Layered architecture visualization (Roll-up perspective)
- Layer management with drag-and-drop
- PNG export

### 3. Object Mapping View

- Interactive dependency graph (Roll-up & Roll-down)
- Edge-type filtering (`call`, `read`, `write`, `produce`, `consume`)
- View-level switching: Domain → Service → Atomic

### 4. Approval Workflow

- All inferred relations go to a `PENDING` queue before being applied
- Bulk approve / reject with Evidence review
- Manual override always takes priority over inference

### 5. AI Chat (Evidence-first)

- Architecture Q&A grounded in your actual graph data
- Confidence + Evidence-driven responses
- Supports OpenAI, Anthropic, Google (via Vercel AI SDK)
- No definitive answers without Evidence

---

## Repository Structure

```
archi-navi/
├── apps/
│   └── web/                    # Next.js 16 App (UI + API Routes)
│       ├── (dashboard)/        # Architecture View, Services, Approval, Chat
│       └── api/                # REST API Routes
│
└── packages/
    ├── core/                   # Query Engine (BFS/DFS), Rollup, Graph Index
    ├── inference/              # Relation & Domain Inference Engine
    ├── db/                     # Drizzle ORM schema + migrations
    ├── cli/                    # CLI tool (scan, infer, rebuild-rollup, export, snapshot)
    ├── shared/                 # Shared types, constants, utilities
    └── ui/                     # Shared shadcn/ui components
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router) + React 19 + TypeScript |
| UI Library | TailwindCSS 4 + shadcn/ui |
| Graph Visualization | Cytoscape.js + React Flow |
| State Management | Zustand |
| Database | PGlite (local) / PostgreSQL 17 (team deploy) |
| ORM | Drizzle ORM |
| AI / LLM | Vercel AI SDK (OpenAI, Anthropic, Google) |
| Monorepo | Turborepo + pnpm |
| CLI | Commander.js + tsx |
| Testing | Vitest + Playwright |

---

## Getting Started

### Prerequisites

- Node.js 22.x LTS
- pnpm 10.x

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/archi-navi.git
cd archi-navi

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env.local
# Edit .env.local — set AI_API_KEY at minimum
```

### Environment Variables

```env
# DB — PGlite is used by default (no separate install needed)
# Uncomment below to use PostgreSQL instead
# DATABASE_URL=postgresql://postgres:password@localhost:5432/archinavi

# PGlite data directory (default: .archi-navi/data)
PGLITE_DATA_DIR=.archi-navi/data

# AI provider: openai | anthropic | google
AI_PROVIDER=openai
AI_API_KEY=sk-your-api-key
AI_MODEL=gpt-4o

# App
NODE_ENV=development
PORT=3000
```

### Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Available Scripts

```bash
pnpm dev            # Start development server (Next.js + HMR)
pnpm build          # Production build
pnpm test           # Run all tests
pnpm lint           # ESLint
pnpm format         # Prettier formatting
pnpm db:generate    # Generate Drizzle migrations from schema
pnpm db:migrate     # Apply migrations
pnpm db:studio      # Open Drizzle Studio (DB browser)
```

---

## CLI Usage

The CLI is used to scan source code, run inference, and manage data.

For npm-only usage (without cloning the monorepo), install both packages:

```bash
npm install -g @archi-navi/cli @archi-navi/web
```

Run the web app from anywhere:

```bash
anavi up --port 3000
```

Runtime defaults in npm-installed mode:
- `PGLITE_DATA_DIR`: `~/.archi-navi/data`
- `MIGRATIONS_FOLDER`: auto-resolved from installed `@archi-navi/db`

Optional overrides:

```bash
PGLITE_DATA_DIR="$HOME/.archi-navi/data" \
MIGRATIONS_FOLDER="/custom/path/to/migrations" \
anavi up --port 3000
```

```bash
# Run web app (auto-detect monorepo or installed @archi-navi/web package)
anavi up --port 3000

# Scan source code and configuration files
anavi scan --path /path/to/project --mode code

# Run relation/domain inference
anavi infer --workspace <workspaceId>

# Rebuild rollup graph
anavi rebuild-rollup --workspace <workspaceId>

# Export data
anavi export --format json --output ./export.json

# Save a snapshot of the current state
anavi snapshot
```

Scan modes: `code` | `db` | `config` | `all`

### npm Publish (Maintainers)

```bash
# 1) Build+pack all publish targets
pnpm release:pack:npm

# 2) Dry-run publish sequence
pnpm release:publish:npm:dry-run

# 3) Real publish (public scope)
pnpm release:publish:npm
```

---

## Inference Engine

Archi.Navi automatically infers relations from your codebase:

| Signal Source | Inferred Relation | Example |
|---------------|------------------|---------|
| HTTP client call | `call` | `RestTemplate.getForObject(...)` |
| API controller | `expose` | `@GetMapping("/api/orders")` |
| Message producer | `produce` | `kafkaTemplate.send("order.created")` |
| Message consumer | `consume` | `@KafkaListener(topics="order.created")` |
| DB SELECT | `read` | JPA Repository, MyBatis XML |
| DB INSERT/UPDATE | `write` | JPA Repository, MyBatis XML |

Domain inference supports two tracks:
- **Track A**: Seed-based — user defines domain names, engine calculates affinity scores
- **Track B**: Seed-less Discovery — Louvain community detection on the relation graph

All inference results go through the **Approval Queue** before being applied.

---

## Data Model

All assets are unified under a single `Object` model:

| Category | Compound | Atomic |
|----------|----------|--------|
| COMPUTE | `service` | `api_endpoint`, `function` |
| STORAGE | `database`, `cache_instance` | `db_table`, `db_view`, `cache_key` |
| CHANNEL | `message_broker` | `topic`, `queue` |

Relations are stored at the atomic level; Roll-up views are derived via materialized computation.

---

## Implementation Status (v1)

| Area | Status |
|------|--------|
| Architecture View (layered, roll-up) | ✅ Complete |
| Object Mapping View (roll-up + roll-down) | ✅ Complete |
| Service List + CSV Export | ✅ Complete |
| Tag / Visibility management | ✅ Complete |
| Approval Workflow (bulk approve/reject) | ✅ Complete |
| Multi-workspace support | ✅ Complete |
| Rollup Engine (4 levels: S2S, S2DB, S2Broker, D2D) | ✅ Complete |
| Query Engine (BFS/DFS, path, impact, usage) | ✅ Complete |
| Domain Inference Track A (Seed-based) | ✅ Complete |
| Domain Inference Track B (Louvain Discovery) | ✅ Complete |
| AI Chat (streaming, multi-provider) | ✅ Complete |
| DB Signal extraction for inference | 🔜 v2 roadmap |
| AST Plugin (Tree-sitter) | 🔜 v2 roadmap |
| Evidence Assembler for AI Chat | 🔜 v2 roadmap |

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/README.md](./docs/README.md) | Documentation taxonomy (Design / SPEC / Guide) |
| [docs/design/README.md](./docs/design/README.md) | Design document index |
| [docs/spec/README.md](./docs/spec/README.md) | SPEC document index |
| [docs/00-overview.md](./docs/00-overview.md) | Product overview, principles, scope |
| [docs/design/01-architecture.md](./docs/design/01-architecture.md) | System architecture, tech stack |
| [docs/design/02-data-model.md](./docs/design/02-data-model.md) | Object/Relation model, DB schema |
| [docs/design/03-inference-engine.md](./docs/design/03-inference-engine.md) | Inference engine design |
| [docs/design/04-query-engine.md](./docs/design/04-query-engine.md) | Query engine (BFS/DFS, impact analysis) |
| [docs/design/05-rollup-and-graph.md](./docs/design/05-rollup-and-graph.md) | Rollup strategy and graph performance |
| [docs/design/06-compound-view.md](./docs/design/06-compound-view.md) | Compound dependency view design |
| [docs/01-development-guide.md](./docs/01-development-guide.md) | Development guide and conventions |
| [docs/02-implementation-status.md](./docs/02-implementation-status.md) | v1 implementation status |
| [docs/03-roadmap.md](./docs/03-roadmap.md) | v2+ roadmap |
| [docs/spec/01-db-inference-index-unique-spec.md](./docs/spec/01-db-inference-index-unique-spec.md) | DB inference expansion spec (index/unique patterns) |
| [docs/spec/02-object-mapping-3d-renderer-spec.md](./docs/spec/02-object-mapping-3d-renderer-spec.md) | Object Mapping 3D renderer transition spec |
| [docs/spec/03-compound-view-implementation-spec.md](./docs/spec/03-compound-view-implementation-spec.md) | Compound View implementation spec |
| [docs/spec/04-llm-inference-filtering-spec.md](./docs/spec/04-llm-inference-filtering-spec.md) | LLM inference filtering spec |
| [docs/spec/05-llm-inference-filtering-spec-checklist.md](./docs/spec/05-llm-inference-filtering-spec-checklist.md) | LLM inference filtering implementation checklist |
| [docs/spec/06-incremental-rollup-rebuild-spec.md](./docs/spec/06-incremental-rollup-rebuild-spec.md) | Incremental rollup rebuild spec |
| [docs/spec/07-hub-node-management-spec.md](./docs/spec/07-hub-node-management-spec.md) | Hub node management spec |
| [docs/spec/08-progressive-rendering-spec.md](./docs/spec/08-progressive-rendering-spec.md) | Progressive rendering spec |
| [docs/spec/09-domain-first-navigation-spec.md](./docs/spec/09-domain-first-navigation-spec.md) | Domain-first navigation spec |
| [docs/spec/10-incremental-inference-spec.md](./docs/spec/10-incremental-inference-spec.md) | Incremental inference spec |

---

> Archi.Navi is not static documentation.
> It is a **practical architecture navigation tool for operating microservice systems**.
