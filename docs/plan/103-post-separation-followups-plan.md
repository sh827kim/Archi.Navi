# 도메인 분리 후속 PR 계획서 (PR 0 ~ PR 6)

## Context

`feature/domain-physical-logical-separation` 브랜치에서 Task 1~15 + Critical C1 (primary-only 계약 위반) 까지 19 커밋으로 완료. 62/62 단위 테스트 PASS, 전역 `tsc --noEmit` clean. PR-wide 리뷰에서 Critical 은 이미 C1 수정으로 해결됐고, 남은 I2/I3/M1/M2/M3/미분류% 이슈와 사용자 요청 "로컬 LLM 호출 지원" 을 후속 PR 7 개로 분리한다.

## 사용자 결정 (확정)

| # | 주제 | 결정 |
|---|------|------|
| Q1 | 로컬 LLM 어댑터 범위 | **OpenAI 호환만** 지원 (Ollama native API 어댑터 미포함) |
| Q2 | M3 DISCOVERY 필터 | **옵션 A (현행 유지)** + MANUAL 수동 지정 기능 필요성을 **문서화 필수** |
| Q3 | 브랜치 전략 | 현재 PR 머지 후 **main 기준 단독 브랜치**. stacked 아님. |
| Q4 | CHECK 제약 범위 | `relation_type`/`source` 2 컬럼 한정 아님 — **전체 enum 성격 컬럼 일괄 처리** |

## 공통 규칙

- 각 PR 은 현재 PR (`feature/domain-physical-logical-separation`) 이 main 에 머지된 이후 **main 에서 새 브랜치**로 시작.
- 한국어 주석/커밋, 백엔드 4-space, 프론트 2-space, `any` 금지.
- 모든 변경은 TDD. 기존 vitest mock 패턴 재사용.
- 각 PR 머지 시 `pnpm -r exec tsc --noEmit`, 관련 vitest 단위 테스트 전량 통과.

---

## PR 요약 표

| 순서 | 브랜치 | 제목 | 규모 | 주요 리스크 |
|------|--------|------|------|-------------|
| PR 0 | `feature/local-llm-openai-compat` | 로컬 LLM (OpenAI 호환) 지원 | 중 | 기존 LLM 호출 경로 전반 회귀 |
| PR 1 | `feature/approve-test-mock-refactor` | approve 테스트 mock 을 조건-매칭 방식으로 | 소 | 테스트만, 프로덕션 무변경 |
| PR 2 | `feature/approve-post-tx-race-fix` | approve post-tx race 제거 | 소~중 | 응답 형식 변경 없음, 내부 리팩터 |
| PR 3 | `feature/implementing-services-uncategorized-fix` | 미분류% 재정의 (coverage 기반) | 중 | discover/approve/GET 3 라우트 응답 shape 변경 |
| PR 4 | `feature/domains-list-envelope` | `GET /api/domains` envelope 통일 | 소 | 클라이언트 호환성 |
| PR 5 | `feature/implementing-services-manual-docs` | MANUAL 수동 지정 기능 문서화 | 소 | 코드 변경 없음 (문서만) |
| PR 6 | `feature/enum-check-constraints` | 전체 enum 컬럼 CHECK 제약 추가 | 중 | 마이그레이션 — pre-check 필수 |

---

## PR 0 — 로컬 LLM (OpenAI 호환) 지원

### 목적
Anthropic/OpenAI/Google 외에 Ollama / LM Studio / vLLM / LocalAI 등 **OpenAI 호환** 로컬 엔드포인트를 사용할 수 있게 한다. Q1 결정에 따라 Ollama native API 전용 어댑터는 추가하지 않는다 (Ollama 의 `/v1` 경로만 사용).

### 기술 접근
- Vercel AI SDK 의 `@ai-sdk/openai` 가 이미 `createOpenAI({ apiKey, baseURL })` 로 OpenAI 호환 임의 엔드포인트를 지원.
- 기존 `apps/web/src/lib/inference-llm.ts` 의 provider switch 에 `'local'` case 추가, `baseURL` 만 추가 주입.
- 로컬 모델은 대부분 tool-mode 를 지원하지 않으므로 모든 `generateObject` 호출에 `mode: 'json'` 추가 (OpenAI/Anthropic/Google 도 동일하게 동작).

### 파일 변경
- **수정** `apps/web/src/lib/inference-llm.ts`
  - `InferenceProvider` 유니온에 `'local'` 추가
  - `resolveProviderApiKey` 에 `local` case (기본 `'not-required'`)
  - `createModelForProvider` 에 `local` case: `createOpenAI({ apiKey, baseURL: resolvedBaseUrl })(modelName)`
  - `getInferenceModel(req)`: 헤더 `x-ai-base-url` 우선 → 없으면 `process.env.LOCAL_LLM_BASE_URL` → 없으면 `http://localhost:11434/v1`
  - 모델명: 헤더 `x-ai-model` → `process.env.LOCAL_LLM_MODEL` → 기본 `'llama3.1:8b-instruct-q4_K_M'`
  - 전역 `generateObject` 호출부 7 개 전부 `mode: 'json'` 추가 (assessment / explanation / boost / patches / semantic / domainReview / contradiction)
- **수정** `apps/web/.env.example` — `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY` 주석 추가
- **수정** 설정 UI (`apps/web/src/components/settings/inference-provider-form.tsx` 또는 유사) — provider 드롭다운에 "로컬 (OpenAI 호환)" 옵션, `baseURL` 입력 필드 추가 (로컬 선택 시에만 노출)
- **신규** `docs/ops/local-llm-setup.md`
  - Ollama: `ollama serve` → `ollama pull llama3.1:8b-instruct-q4_K_M` → baseURL `http://localhost:11434/v1`
  - LM Studio: GUI 에서 모델 로드 → Server 탭 → baseURL `http://localhost:1234/v1`
  - 권장 모델: `llama3.1:8b-instruct-q4_K_M`, `qwen2.5-coder:14b`
  - 주의: tool-mode 미지원 모델은 `mode: 'json'` 에서도 JSON 응답 품질이 낮을 수 있음
- **신규 테스트** `apps/web/src/__tests__/inference-llm.test.ts`
  - `getInferenceModel` 이 `'local'` provider 요청 시 baseURL 주입 확인
  - 헤더 > 환경변수 > 기본값 우선순위 확인

### 수용 기준
- provider 3 종 (openai/anthropic/google) 동작 회귀 없음 (기존 라우트 테스트 통과).
- 로컬 설정 예시(`http://localhost:11434/v1`, `llama3.1:8b-instruct-q4_K_M`)로 `/api/inference/preview` 류가 성공 응답을 반환 (수동 검증).
- `generateObject({mode:'json'})` 가 모든 호출부에 적용됨.

### 예상 커밋 수
3~4 (어댑터 / UI / 문서 / 테스트).

---

## PR 1 — approve 테스트 mock 조건-매칭 리팩터

### 목적
I3: `apps/web/src/__tests__/domains-approve.route.test.ts` 의 mock 이 호출 순서/고정 큐(`dbSelectQueue`)에 의존 → 라우트 내 `db.select` 순서가 바뀌면 테스트가 깨진다. where 절의 컬럼 매칭으로 응답을 선택하도록 바꿔 라우트 구현 변경에 강하게 만든다.

### 기술 접근
- `buildDbMock` 내부에 `findEq(where, col)` 재귀 헬퍼를 추가해 drizzle 의 `and`/`eq` 트리에서 특정 컬럼 바인딩 값을 추출.
- 각 `db.select().from(T)` 호출에서 `T` 기준으로 응답을 결정. where 의 특정 id 값으로 sub-선택.
- 기존 `sortedServiceIds` / `task8ChildrenQueue` 카운터 제거.

### 파일 변경
- **수정** `apps/web/src/__tests__/domains-approve.route.test.ts`
- (프로덕션 코드 무변경)

### 수용 기준
- 19/19 PASS 유지.
- 라우트에서 `db.select` 호출 순서를 임의로 바꿔도 테스트 통과.

### 예상 커밋 수
1~2.

---

## PR 2 — approve post-tx race 제거

### 목적
I2: `POST /api/domains/approve` 가 트랜잭션 내부에서 `objectRelations` INSERT 를 수행한 뒤, 트랜잭션 **밖**에서 다시 `objectRelations` SELECT → `objects` JOIN 으로 응답에 포함할 `implementingServices` 를 만든다. 극단적 경합 (동일 도메인에 대한 재승인 동시 호출) 에서 post-tx SELECT 가 다른 트랜잭션의 중간 상태를 볼 위험이 있다.

### 기술 접근
- Task 8 루프에서 INSERT 한 행의 키(`subjectObjectId, confidence`)를 트랜잭션 내부 배열 `insertedImplements[]` 에 누적 → 트랜잭션 반환값에 포함.
- post-tx 는 `insertedImplements` 의 `subjectObjectId` 로 objects 를 **단일 SELECT** 해서 name/displayName 만 매핑.

### 파일 변경
- **수정** `apps/web/src/app/api/domains/approve/route.ts`
- **수정** `apps/web/src/__tests__/domains-approve.route.test.ts` (PR 1 이 머지된 후의 조건-매칭 mock 기반)

### 수용 기준
- 19/19 PASS 유지.
- `db.select(objectRelations)` 호출이 post-tx 에서 사라짐 (grep 확인).

### 예상 커밋 수
2.

---

## PR 3 — 미분류% 재정의 (coverage 기반)

### 목적
I1/미분류%: 현재 UI 가 `1 - Σ confidence` 로 미분류 비율을 표기하지만, confidence 가 `childInDomain / childTotal` (service 별 커버리지) 이라 **여러 service 합이 1 을 초과** 할 수 있다 → 음수 표시 가능. 의미를 "도메인 멤버 중 어떤 service 에도 귀속되지 않은 비율" 로 재정의해 unit 을 멤버 개수로 통일.

### 기술 접근
- `computeImplementingServices` 반환값을 확장:
  ```ts
  interface ImplementingServicesResult {
    services: ImplementingServiceRow[];
    totalCodeMembers: number;      // memberIds ∩ {function, api_endpoint}
    coveredCodeMembers: number;    // 위 중 어떤 service 의 자식으로 매핑된 수
    unassignedCodeMembers: number; // total - covered
  }
  ```
- 호출부 3 곳 (discover/approve/GET `[id]/implementing-services`) 응답 shape 통일:
  ```json
  {
    "implementingServices": [ ... ],
    "coverage": { "total": N, "covered": M, "unassigned": N - M }
  }
  ```
- UI 는 `unassigned / total` 로 미분류 % 렌더링. confidence 합산 로직 제거.

### 파일 변경
- **수정** `packages/inference/src/domain/discovery/implementingServices.ts`
- **수정** `packages/inference/src/__tests__/domain/discovery/implementingServices.test.ts` (신규 필드 검증 추가)
- **수정** `apps/web/src/app/api/domains/discover/route.ts`
- **수정** `apps/web/src/app/api/domains/approve/route.ts`
- **수정** `apps/web/src/app/api/domains/[id]/implementing-services/route.ts`
- **수정** 3 라우트 관련 테스트
- **수정** `apps/web/src/components/domains/domain-discover-section.tsx`
- **수정** `apps/web/src/components/domains/domain-semantic-client.tsx`

### 수용 기준
- 미분류 % 가 항상 `[0, 100]` 범위.
- 기존 테스트 전량 + 신규 coverage 필드 단언 통과.

### 예상 커밋 수
3.

---

## PR 4 — `GET /api/domains` envelope 통일

### 목적
M2: 다른 라우트가 `{success, data:{...}}` / `{success:false, error:{code,message}}` envelope 를 쓰는데 `GET /api/domains` 만 평문 배열 + `{error: string}` → 클라이언트에서 `Array.isArray(data)` 분기로 임시 대응 중. 전면 통일.

### 기술 접근
- 라우트 응답:
  ```json
  { "success": true, "data": { "domains": [ ... ] } }
  { "success": false, "error": { "code": "BAD_REQUEST", "message": "..." } }
  ```
- `DomainListClient` 의 `Array.isArray` 분기 제거.
- 신규 테스트 `apps/web/src/__tests__/domains-list.route.test.ts` (mock db + 2 케이스: workspaceId 누락, 정상 조회).

### 파일 변경
- **수정** `apps/web/src/app/api/domains/route.ts`
- **수정** `apps/web/src/components/domains/domain-list-client.tsx`
- **수정** `apps/web/src/app/(dashboard)/domains/page.tsx` (fetch 응답 파싱)
- **신규** `apps/web/src/__tests__/domains-list.route.test.ts`

### 수용 기준
- 신규 테스트 통과.
- `/domains` 페이지 정상 렌더 (preview 수동 검증).

### 예상 커밋 수
1~2.

---

## PR 5 — MANUAL 수동 지정 기능 문서화

### 목적
Q2 결정: DISCOVERY 필터를 유지하되, MANUAL 소스로 service-domain 매핑을 지정할 수 있는 기능이 **필요함**을 명시적으로 문서화. 현재는 구현자 판단으로만 이 결정이 남아있어 후속 세션에서 흔적이 사라질 리스크.

### 기술 접근
- **신규 spec** `docs/superpowers/specs/2026-04-20-manual-implementing-service-mapping.md`:
  - 동기 (왜 DISCOVERY 로만은 부족한가 — 자동 추론 누락 사례, 혼합 책임 서비스 등)
  - API 스케치 (`POST /api/domains/[id]/implementing-services` body `{serviceObjectId, note?}`, 응답 envelope, `source='MANUAL'` objectRelations 행 생성)
  - UI 스케치 (도메인 상세 페이지 하단 "수동 추가" 섹션)
  - conflict 정책 (MANUAL 이 DISCOVERY 를 오버라이드? 혹은 공존?)
  - `GET /api/domains/[id]/implementing-services` 필터 정책 변경안 (`?includeManual=true`)
- **수정** `apps/web/src/app/api/domains/[id]/implementing-services/route.ts` 상단 JSDoc — "현재 DISCOVERY 만. MANUAL 은 spec 문서 참고, 미구현" 명시.
- **수정** `apps/web/src/app/api/domains/approve/route.ts` Task 8 주석 — 동일 참조 링크 추가.

### 수용 기준
- spec 문서가 커밋에 포함됨.
- 두 라우트 파일 상단 JSDoc 에 spec 링크 존재.

### 예상 커밋 수
1.

---

## PR 6 — 전체 enum 컬럼 CHECK 제약 추가

### 목적
M1: `object_type`, `relation_type`, `source`, `status`, `category`, `granularity`, `visibility`, `interaction_kind`, `direction` 등 **전체 enum 성격 컬럼**에 DB 레벨 CHECK 제약이 없어 오타 / 잘못된 enum 값이 들어갈 수 있다. Q4 결정에 따라 단일 마이그레이션으로 일괄 처리.

### 기술 접근

대상 컬럼 (정확한 허용값은 구현 시 `packages/shared/src/types` 및 라우트에서 사용되는 값 전수조사로 확정):

| 테이블 | 컬럼 | 허용값 (초안) |
|--------|------|---------------|
| `objects` | `object_type` | `service`, `function`, `api_endpoint`, `topic`, `queue`, `database`, `db_table`, `domain` |
| `objects` | `category` | `COMPUTE`, `STORAGE`, `CHANNEL` (nullable) |
| `objects` | `granularity` | `COMPOUND`, `ATOMIC` |
| `objects` | `visibility` | `VISIBLE`, `HIDDEN` |
| `object_relations` | `relation_type` | `call`, `expose`, `read`, `write`, `produce`, `consume`, `depend_on`, `fk_reference`, `implements` |
| `object_relations` | `interaction_kind` | `CONTROL`, `DATA`, `ASYNC`, `STATIC` (nullable) |
| `object_relations` | `direction` | `IN`, `OUT` (nullable) |
| `object_relations` | `status` | `APPROVED`, `REJECTED` |
| `object_relations` | `source` | `MANUAL`, `INFERRED`, `ROLLUP`, `DISCOVERY` |
| `relation_candidates` | `status` | `PENDING`, `APPROVED`, `REJECTED` |
| `interaction_intents` | `status` | `NEW`, `RESOLVING`, `FRONTIER`, `CLOSED_ATOMIC`, `REJECTED` |

### 작업 순서

1. **Pre-check SQL** — 마이그레이션 파일 상단에 각 컬럼별 `SELECT count(*) FROM T WHERE col NOT IN (...)` 쿼리를 주석 블록으로 포함, 사용자가 staging/prod 에서 선제 실행해 위반 데이터 0 건 확인.
2. **Drizzle schema** — 각 `pgTable` 정의에 `check(name, sql)` 제약 추가:
   ```ts
   check('ck_objects_object_type', sql`object_type IN ('service', 'function', ...)`)
   ```
3. **Migration 생성** — `pnpm --filter @archi-navi/db db:generate` 로 드리즐 마이그레이션 생성, 필요 시 수동 정리 (drizzle 의 check 지원 한계 대응).
4. **코드 전수조사 테스트** — `packages/inference/src/__tests__/enum-values.test.ts` 신규: 위 표의 허용값 집합이 실제 타입 유니온/상수와 일치함을 타입 레벨 + 런타임 단언.

### 파일 변경
- **수정** `packages/db/src/schema/core.ts`
- **수정** `packages/db/src/schema/` 하위 기타 테이블 파일 (`interactionIntents` 등 enum 사용처 전부)
- **신규** `packages/db/drizzle/NNNN_enum_check_constraints.sql`
- **신규** `packages/inference/src/__tests__/enum-values.test.ts`
- **수정** `docs/` — 마이그레이션 롤아웃 절차 (`docs/ops/enum-check-constraints-rollout.md`)

### 수용 기준
- `pnpm --filter @archi-navi/db migrate` 가 깨끗한 DB 에서 성공.
- 허용값 외 INSERT 시 DB 레벨에서 거절 (단위 테스트로 검증).
- 기존 `pnpm -r vitest` 전량 통과.
- 롤아웃 문서 존재.

### 리스크 및 완화
- **기존 프로덕션 데이터에 enum 위반이 있으면 마이그레이션이 깨진다.** → Pre-check SQL 을 사용자에게 먼저 실행하게 하고, 결과 0 건 확인 후 PR 병합.
- **drizzle 의 check 제약 지원**: drizzle-orm 0.45.1 의 `pgTable` check 지원 확인 필요. 미지원 시 raw SQL 마이그레이션으로 대체.

### 예상 커밋 수
3 (스키마 / 마이그레이션 / 테스트+문서).

---

## 실행 순서 및 브랜치 흐름

```
main
 ├─ feature/local-llm-openai-compat          (PR 0)  ── merge ──┐
 ├─ feature/approve-test-mock-refactor        (PR 1)  ── merge ──┤
 ├─ feature/approve-post-tx-race-fix          (PR 2)  ── merge ──┤
 ├─ feature/implementing-services-uncategorized-fix (PR 3) ─ merge ┤
 ├─ feature/domains-list-envelope             (PR 4)  ── merge ──┤
 ├─ feature/implementing-services-manual-docs (PR 5)  ── merge ──┤
 └─ feature/enum-check-constraints            (PR 6)  ── merge ──┘
```

각 PR 은 바로 앞 PR 이 머지된 직후 **main 에서** 새로 분기. Q3 결정에 따라 stacked 아님.

---

## 다음 단계

1. 사용자가 현재 PR (`feature/domain-physical-logical-separation`) 을 머지.
2. PR 0 브레인스토밍 세션 — 로컬 LLM 세부 UX (설정 UI 의 baseURL 입력 필드 위치, provider 드롭다운 라벨 문구, 로컬 연결 테스트 버튼 여부 등) 을 확정.
3. PR 0 구현 — `superpowers:subagent-driven-development` 스킬로 Task 분할.
4. PR 1 → PR 2 → ... 순차 진행.
