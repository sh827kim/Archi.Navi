# Archi.Navi — 개발 가이드

작성일: 2026-02-22
문서 버전: v2.0

---

## 1. 개발 환경 설정

### 1.1 필수 도구

| 도구 | 버전 | 설명 |
|------|------|------|
| **Node.js** | 22.x LTS | 런타임 |
| **pnpm** | 10.x | 패키지 매니저 |
| **Git** | 2.x | 버전 관리 |

### 1.2 초기 설정

```bash
# 저장소 클론
git clone https://github.com/sh827kim/Archi.Navi.git
cd Archi.Navi

# 의존성 설치
pnpm install

# 환경변수 설정
# apps/web/.env.local 파일을 직접 생성
# AI_PROVIDER + OPENAI_API_KEY(또는 다른 provider key) 설정

# 개발 서버 실행
pnpm dev
```

### 1.3 주요 스크립트

```bash
pnpm dev          # 개발 서버 (Next.js + HMR)
pnpm build        # 프로덕션 빌드
pnpm test         # 전체 테스트
pnpm test:unit    # 단위 테스트 (Vitest)
pnpm test:e2e     # E2E 테스트 (Playwright)
pnpm lint         # ESLint 검사
pnpm format       # Prettier 포맷팅
pnpm db:migrate   # DB 마이그레이션 실행
pnpm db:generate  # Drizzle 스키마 → 마이그레이션 생성
pnpm db:studio    # Drizzle Studio (DB 브라우저)
```

---

## 2. 코딩 컨벤션

### 2.1 TypeScript

| 항목 | 규칙 |
|------|------|
| **들여쓰기** | 2칸 (스페이스) |
| **네이밍** | camelCase (변수/함수), PascalCase (타입/컴포넌트) |
| **세미콜론** | 사용 |
| **따옴표** | 작은따옴표 (`'`) |
| **any 타입** | **사용 금지** — unknown 또는 명시적 타입 사용 |
| **strict 모드** | `tsconfig.json`에서 `strict: true` 필수 |

### 2.2 React / Next.js

| 항목 | 규칙 |
|------|------|
| **라우팅** | App Router 기반 (page.tsx, layout.tsx) |
| **컴포넌트** | 함수 컴포넌트 + 화살표 함수 |
| **상태관리** | Zustand (글로벌), useState (로컬) |
| **데이터 페칭** | Server Components 우선, 필요 시 `fetch` 기반 클라이언트 요청 |
| **스타일링** | TailwindCSS 유틸리티 클래스 |
| **반응형** | 모바일 대응 필수 (Tailwind breakpoint) |
| **컴포넌트 분리** | 재사용 가능한 단위로 분리 |

### 2.3 주석

```typescript
// 초보자가 이해하기 쉽게 한국어로 작성
// 복잡한 로직에만 주석 추가 (자명한 코드에는 불필요)

// BFS로 최단 경로를 탐색한다.
// maxHops 제한을 초과하면 탐색을 중단한다.
function findShortestPath(graph: Graph, from: string, to: string, maxHops: number) {
  // ...
}
```

### 2.4 파일 구조

```typescript
// 컴포넌트 파일 구조
// components/
//   ServiceList/
//     ServiceList.tsx       // 메인 컴포넌트
//     ServiceListItem.tsx   // 하위 컴포넌트
//     useServiceList.ts     // 커스텀 훅
//     types.ts              // 타입 정의
//     index.ts              // barrel export
```

---

## 3. 패키지별 개발 가이드

### 3.1 `packages/db` — DB 스키마 작업

```bash
# 스키마 수정 후 마이그레이션 생성
cd packages/db
pnpm db:generate

# 마이그레이션 적용
pnpm db:migrate

# Drizzle Studio로 데이터 확인
pnpm db:studio
```

**Drizzle 스키마 예시:**

```typescript
// packages/db/src/schema/objects.ts
import { pgTable, uuid, text, integer, jsonb, timestamptz } from 'drizzle-orm/pg-core';

export const objects = pgTable('objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  objectType: text('object_type').notNull(),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references(() => objects.id),
  path: text('path').notNull(),
  depth: integer('depth').notNull().default(0),
  visibility: text('visibility').notNull().default('VISIBLE'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});
```

### 3.2 `packages/core` — 엔진 개발

```bash
# 엔진 테스트
cd packages/core
pnpm test:unit

# 특정 모듈 테스트
pnpm exec vitest run src/__tests__/query-engine
```

### 3.3 `packages/inference` — 추론 엔진 개발

```bash
# AST 플러그인 테스트 (Tree-sitter 필요)
cd packages/inference
pnpm test:unit
pnpm exec vitest run src/__tests__/code/ast/extractAstCodeSignals.test.ts
```

### 3.4 `packages/cli` — CLI 개발

```bash
# CLI 로컬 테스트
cd packages/cli
pnpm build
node dist/bin/anavi.js scan --workspace <workspaceId> --path /path/to/project

# 또는 tsx로 직접 실행
pnpm exec tsx src/index.ts scan --workspace <workspaceId> --path /path/to/project
```

---

## 4. API 개발 패턴

### 4.1 API Route 구조 (Next.js App Router)

```typescript
// apps/web/app/api/objects/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// 요청 스키마 정의
const createObjectSchema = z.object({
  workspaceId: z.string().uuid(),
  objectType: z.string(),
  name: z.string().min(1),
  parentId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = createObjectSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
      { status: 400 }
    );
  }

  // 비즈니스 로직
  const result = await objectService.create(parsed.data);

  return NextResponse.json({ success: true, data: result });
}
```

### 4.2 공통 응답 형식

```typescript
// packages/shared/src/types/api.ts
export interface ApiResponse<T> {
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

## 5. 테스트 전략

### 5.1 단위 테스트 (Vitest)

```typescript
// packages/core/src/query-engine/__tests__/pathDiscovery.test.ts
import { describe, it, expect } from 'vitest';
import { findPaths } from '../pathDiscovery';

describe('PathDiscovery', () => {
  it('최단 경로를 찾아야 한다', () => {
    const graph = createTestGraph();
    const result = findPaths(graph, {
      fromObjectId: 'service-a',
      toObjectId: 'service-b',
      maxHops: 6,
      topK: 3,
    });

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].nodeIds).toEqual(['service-a', 'service-b']);
  });
});
```

### 5.2 E2E 테스트 (Playwright)

```typescript
// apps/web/tests/architecture-view.spec.ts
import { test, expect } from '@playwright/test';

test('Architecture View에서 서비스 노드를 클릭하면 상세 패널이 열린다', async ({ page }) => {
  await page.goto('/architecture');
  await page.click('[data-testid="node-order-service"]');
  await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();
});
```

### 5.3 테스트 범위

| 대상 | 도구 | 우선순위 |
|------|------|---------|
| Query Engine (BFS/DFS) | Vitest | 필수 |
| Rollup 계산 | Vitest | 필수 |
| Domain 추론 점수 계산 | Vitest | 필수 |
| API Route 검증 | Vitest + supertest | 중요 |
| UI 인터랙션 | Playwright | 중요 |
| CLI 명령어 | Vitest | 보통 |

---

## 6. Git 전략

### 6.1 브랜치 전략

```
main                 # 안정 릴리즈
├── develop          # 개발 통합
│   ├── feature/*    # 기능 개발
│   ├── fix/*        # 버그 수정
│   └── chore/*      # 기타 작업
```

### 6.2 커밋 컨벤션

**Conventional Commits** 형식을 따른다.

```
<type>(<scope>): <description>

feat(core): PATH_DISCOVERY BFS 알고리즘 구현
fix(web): Architecture View 노드 클릭 이벤트 수정
chore(db): 마이그레이션 파일 추가
docs: 추론 엔진 설계 문서 업데이트
refactor(inference): 도메인 점수 계산 로직 개선
test(core): Rollup 계산 단위 테스트 추가
```

**type 종류:**
- `feat`: 새 기능
- `fix`: 버그 수정
- `chore`: 빌드/설정 변경
- `docs`: 문서
- `refactor`: 리팩토링
- `test`: 테스트
- `style`: 코드 스타일 (기능 변경 없음)

---

## 7. 환경변수 관리

### 7.1 환경변수 예시

```env
# === DB ===
# Local embedded postgres - 기본값
# 외부 PostgreSQL 사용 시 아래 설정
# DATABASE_URL=postgresql://postgres:password@localhost:5432/archinavi

# embedded postgres 데이터 디렉토리 (기본: ~/.archi-navi/db)
# ARCHI_NAVI_DB_DATA_DIR=~/.archi-navi/db
# ARCHI_NAVI_DB_PORT=54329

# === AI ===
# 프로바이더: openai | anthropic | google
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-key
# ANTHROPIC_API_KEY=sk-ant-your-key
# GOOGLE_GENERATIVE_AI_API_KEY=your-google-key

# === App ===
NODE_ENV=development
PORT=3000
```

### 7.2 주의사항

- 모노레포 개발 시 앱 환경변수는 `apps/web/.env.local`에 두는 구성이 기준
- `.env.local`은 `.gitignore`에 포함
- API 키는 절대 커밋하지 않음
- CI/CD에서는 환경변수 또는 시크릿 매니저 사용
- 모델 선택은 Settings UI에서 저장되며 요청 헤더로 전달된다

---

## 8. Turborepo 설정

### 8.1 turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {},
    "format": {}
  }
}
```

### 8.2 패키지 의존성 그래프

```
apps/web
  ├── packages/core
  ├── packages/inference
  ├── packages/db
  ├── packages/shared
  └── packages/ui

packages/core
  ├── packages/db
  └── packages/shared

packages/inference
  ├── packages/db
  └── packages/shared

packages/cli
  ├── packages/core
  ├── packages/inference
  ├── packages/db
  └── packages/shared
```

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [01-architecture.md](./design/01-architecture.md) | 기술스택 및 모노레포 구조 상세 |
| [02-data-model.md](./design/02-data-model.md) | DB 스키마 (Drizzle 개발 시 참조) |
