# Archi.Navi — 구현 현황 (v2)

> 최종 점검일: 2026-03-28
> 기준: `apps/web`, `packages/core`, `packages/inference`, `packages/cli` 실코드

---

## 전체 요약

| 영역 | 상태 | 비고 |
|------|------|------|
| Architecture / Mapping UI | ✅ | 레이어드 아키텍처(Cytoscape), 매핑 뷰(3D Force 단일 렌더러), rollup 기반 상위 엣지 반영 |
| Query Engine | ✅ | PATH/IMPACT/USAGE/DOMAIN_SUMMARY 구현, `generationVersion` 미지정 시 ACTIVE 자동 적용 |
| Rollup Engine | ✅ | 4단계 rollup + generation 관리 + seed 후 재빌드 |
| Relation 추론 파이프라인 | ✅ | config/code/db 실행, AST/hybrid 엔진, code 기반 Atomic 후보(endpoint/topic/queue/db_table), 비동기 run 오케스트레이션까지 구현 완료 |
| Domain 추론 파이프라인 | ⚠️ | Track A/B 구현 및 승인 API 존재, 실행/운영 UX 고도화 여지 |
| AI Reasoning | ✅ | Evidence Assembler/Answer Composer 연동 + rollup provenance(`baseRelationIds`) 반영 |
| 추론 엔진 고도화 (P4) | ✅ | 4-1~4-6 구현 완료 |
| **안정화 (S1)** | **🔧** | **Dead Feature 활성화, UX 기반 구축, AI 고도화 필요** |
| 생산성 기능 (P5) | 📋 | Change Impact, Drift Detection, Health Score, Journal, API Diff 설계 완료 |

---

## 1) 완료된 핵심 항목

### 1.1 UI / API

- ✅ `Settings > 개발자 도구`
  - `POST /api/dev/seed`: 샘플 주입 + rollup 재빌드
  - `POST /api/dev/reset`: 워크스페이스 데이터 초기화(rollup 포함)
- ✅ Rollup 재빌드 API
  - `POST /api/rollups`: 승인 관계 반영 후 generation 재생성
- ✅ Rollup 변경 알림 API
  - `GET /api/rollup-events`: `connected` / `rollup-change` SSE notification 스트림 제공
  - ⚠️ **UI 미연결**: 프론트엔드에서 EventSource 소비자 미구현 → S1-3에서 해결
- ✅ `Approval > 관계 후보`
  - `POST /api/inference/run` 호출 버튼 제공
  - 실행 후 PENDING 후보 즉시 재조회
  - cross-validation 배지/경고 표시, 필터/정렬, endpoint 세부 매핑 제공
- ✅ `Approval > 도메인 후보`
  - `GET/PATCH /api/inference/domain-candidates*`로 승인/거부 처리
- ✅ Inference Run 운영 UI/API
  - `GET/POST /api/inference/runs`, `GET /api/inference/runs/:id`
  - quick run과 queued run 모두 binding/cross-validation 최종화 반영
  - ⚠️ **상세 조회 UI 미연결**: 개별 실행(`runs/:id`) 상세 페이지 없음 → S1-5에서 해결
- ✅ `Object Mapping` 3D 렌더러 전환
  - `3D(Force)` 단일 렌더러 제공(2D 선택 UI 제거)
  - WebGL 미지원 환경 fallback 메시지 제공

### 1.2 Query / Rollup

- ✅ Query 타입 구현
  - `PATH_DISCOVERY`
  - `IMPACT_ANALYSIS`
  - `USAGE_DISCOVERY`
  - `DOMAIN_SUMMARY`
- ✅ ACTIVE generation 기본 적용
  - `executeQuery`에서 `generationVersion` 생략 시 ACTIVE 조회 후 사용
- ✅ Rollup
  - `SERVICE_TO_SERVICE`, `SERVICE_TO_DATABASE`, `SERVICE_TO_BROKER`, `DOMAIN_TO_DOMAIN`
  - `BUILDING → ACTIVE → ARCHIVED` generation 전환
  - 관계 승인/추가/삭제 및 `map-endpoints` 다중 승인에 대해 delta rebuild + rollup-change notification 발행
- ⚠️ **Query UI 미연결**: `POST /api/query`를 직접 실행하는 UI 없음, Chat에서만 간접 사용 → S1-4에서 해결

### 1.3 Inference

- ✅ Relation 추론(구현 존재)
  - Config 기반: `inferRelationsFromConfig`
  - Code Signal(AST/Regex): `extractCodeSignalsWithEngine` (`hybrid` 기본, `ast`는 AST 실패 시 Regex fallback)
  - Code Signal 기반 후보 생성: `mode=code`로 `relation_candidates` 생성
  - DB Signal: `extractDbSchemaSignals` (FK/implicit 후보 + schema evidence 연결)
  - Cross-Signal Validation: `crossValidatePendingRelationCandidates`
  - Config↔Code endpoint binding: `bindConfigToCodeEndpoints`
  - 비동기 실행 오케스트레이션: `createInferenceRun` / `executeInferenceRun` / `listInferenceRuns` / `getInferenceRunDetail`
- ✅ Domain 추론
  - Track A(Seed-based): `runSeedBasedInference`
  - Track B(Discovery): `runDiscovery`
  - 도메인 후보 승인: `approveDomainCandidate`

### 1.4 AI

- ✅ Chat 스트리밍 API (`/api/chat`)
- ✅ Evidence Assembler / Answer Composer 연동
- ✅ LLM 후보 필터 API (`/api/inference/llm-filter`)
- ✅ LLM Boost API (`/api/inference/run` + `llmBoost` 옵션)
- ✅ Smart Pipeline API (`/api/inference/smart`)

### 1.5 E2E 시나리오 테스트

- ✅ Playwright 시나리오 추가
  - 파일: `apps/web/tests/e2e/inference-approval-rollup-query-chat.spec.ts`
  - 검증 플로우: 추론 실행 → 관계 후보 승인 → rollup 재빌드 → query(provenance) → chat 카드 렌더링

---

## 2) ⚠️ Dead Feature — 구현 완료되었으나 UI 미연결

> P4까지 백엔드 구현이 완료되었으나 프론트엔드에서 호출하지 않아 사용 불가능한 기능 목록.
> 모두 S1(안정화) 단계에서 UI 연결 예정. 상세는 `docs/03-roadmap.md` S1 섹션 참조.

### 2.1 🔴 Critical — 핵심 기능 미활성

| 기능 | 백엔드 API | 프론트엔드 상태 | 해결 계획 |
|------|-----------|---------------|----------|
| **Smart Pipeline (LLM 3-Phase)** | `POST /api/inference/smart` ✅ | 부분 연결 진행 중이나 요구사항과 구현이 불일치하여 재설계 필요 | S1-1a |
| **LLM Boost (코드 의도 분석)** | `POST /api/inference/run` + `llmBoost` ✅ | `llmBoost` 파라미터 미전달 → 항상 DISABLED | S1-1b |
| **LLM Filter (후보 평가)** | `POST /api/inference/llm-filter` ✅ | 승인 UI에서 미호출 | S1-1c |
| **Object 수정 (PATCH)** | `PATCH /api/objects/:id` ✅ | DELETE만 연결, 수정 불가 | S1-2 |

### 2.2 🟡 Moderate — 사용자 경험 저하

| 기능 | 백엔드 API | 프론트엔드 상태 | 해결 계획 |
|------|-----------|---------------|----------|
| **SSE 실시간 갱신** | `GET /api/rollup-events` (SSE) ✅ | EventSource 소비자 없음 | S1-3 |
| **Query Engine 직접 호출** | `POST /api/query` ✅ | Chat에서만 간접 사용 | S1-4 |
| **추론 실행 상세 조회** | `GET /api/inference/runs/:id` ✅ | 목록만 표시, 상세 없음 | S1-5 |
| **후보 목록 Pagination** | `limit/offset` 파라미터 ✅ | 전체 로드, 페이징 없음 | S1-6 |

### 2.3 🟢 Minor

| 기능 | 백엔드 API | 비고 |
|------|-----------|------|
| Rollup 수동 리빌드 트리거 | `POST /api/rollups` | 사용자 수동 갱신 버튼 없음 |
| 도메인 전용 목록 | `GET /api/domains` | `/api/objects?objectType=domain`으로 대체 중 |
| 도메인 추론 Track 선택 | Track A/B 별도 실행 지원 | UI에서 Track 선택 옵션 미노출 |

---

## 3) 추론 엔진 고도화 메모 (P4)

- ✅ Cross-Signal Validation, Inter-procedural AST, LLM 추론 부스터, 프레임워크 플러그인 시스템, Delta Rollup + 실시간 갱신은 구현 완료 상태다.
- ✅ 4-6은 relation feedback canonical key 집계와 next-run-only relation 보정 위에, Track A domain feedback 집계 및 next-run-only domain 보정까지 반영되었다.
- ✅ 후속 specialization으로 code-origin relation feedback key가 `framework/language`를 안정적으로 가지면 v2 key를 사용하고, 없으면 legacy v1로 fallback 하도록 확장되었다.
- ✅ next-run relation 보정 lookup은 `v2 -> legacy v1` dual-read를 사용하며, `GET /api/inference/candidates`는 3-segment/5-segment feedback key를 모두 opaque string으로 수용한다.
- ✅ 공개 프로필 계약은 `relationFeedback*` / `domainFeedback*` 및 `resetRelationFeedback` / `resetDomainFeedback`로 분리되어 있으며, generic alias `feedbackConfig` / `feedbackAdjustments` / `feedbackSummary` / `feedbackEntries` / `resetAll`은 더 이상 public contract가 아니다.
- ⚠️ **UI 미연결**: LLM Boost, LLM Filter, Smart Pipeline, SSE 클라이언트가 프론트엔드에 연결되지 않음 → S1에서 해결
- ⚠️ queued/orchestrated parity는 4-6 완료 기준에 포함하지 않으며, Track B / domain discovery feedback도 여전히 범위 밖이다.
- ⚠️ 4-5의 실시간 계약은 SSE notification 후 refetch 방식이므로, 대형 그래프에서 재조회 비용 최적화 여지는 남아 있다.

---

## 4) 설계 완료 / 구현 대기

> 아래 항목들은 설계 문서(Design + SPEC)가 완료되었다.
> 상세는 `docs/03-roadmap.md` S1/P5 섹션 및 각 SPEC 문서 참조.

### 4.1 S1: 안정화 — Dead Feature 활성화 + UX 기반 구축 (v3.1) — ★ 최우선

| 항목 | 구분 | 상태 |
|------|------|------|
| S1-1. LLM 추론 기능 UI 연결 (Smart/Boost/Filter) | Dead Feature | 🔧 예정 |
| S1-2. Object 수정 기능 연결 | Dead Feature | 🔧 예정 |
| S1-3. SSE 실시간 그래프 갱신 연결 | Dead Feature | 🔧 예정 |
| S1-4. Query Engine 직접 호출 UI | Dead Feature | 🔧 예정 |
| S1-5. 추론 실행 상세 조회 연결 | Dead Feature | 🔧 예정 |
| S1-6. 후보 목록 Pagination | Dead Feature | 🔧 예정 |
| S1-7. Dashboard Home | UX 기반 | 🔧 예정 |
| S1-8. Empty State 가이드 | UX 기반 | 🔧 예정 |
| S1-9. 사이드바 접기/펼치기 | UX 기반 | 🔧 예정 |
| S1-10. Chat Intent Router 개선 | AI 고도화 | 🔧 예정 |
| S1-11. 도메인 해석 정확도 개선 | AI 고도화 | 🔧 예정 |
| S1-12. Evidence Truncation 전략 | AI 고도화 | 🔧 예정 |
| S1-13. 채팅 기록 영속화 | AI 고도화 | 🔧 예정 |
| S1-14. 대형 컴포넌트 분할 | 유지보수성 | 🔧 예정 |
| S1-15. Evidence 중복 제거 | 유지보수성 | 🔧 예정 |

### 4.2 P5: 개발자 생산성 기능 (v3.2+) — S1 완료 후 착수

| 항목 | SPEC | 상태 |
|------|------|------|
| 5-1. Change Impact Preview | `docs/spec/23-change-impact-preview-spec.md` | 📋 Draft |
| 5-2. Architecture Drift Detection | `docs/spec/24-architecture-drift-detection-spec.md` | 📋 Draft |
| 5-3. Personal Architecture Journal | `docs/spec/25-personal-architecture-journal-spec.md` | 📋 Draft |
| 5-4. API Contract Diff | `docs/spec/26-api-contract-diff-spec.md` | 📋 Draft |
| 5-5. Architecture Health Score | `docs/spec/27-architecture-health-score-spec.md` | 📋 Draft |
| 5-6. 구조적 개선 (서비스 레이어/커버리지/공유/Watcher) | `docs/design/08-developer-productivity.md` §7 | 📋 Draft |

---

## 5) 참고: 현재 주요 실행 엔트리포인트

### 5.1 Web API

**정적 추론 (UI 연결됨)**
- `POST /api/scan`
- `POST /api/inference/run` (config/code/db 모드)
- `GET /api/inference/candidates`
- `PATCH /api/inference/candidates/:id`
- `GET /api/inference/candidates/:id/endpoints`
- `POST /api/inference/candidates/:id/map-endpoints`
- `GET /api/inference/domain-candidates`
- `PATCH /api/inference/domain-candidates/:id`
- `POST /api/inference/domain-run`
- `POST /api/chat`

**LLM 추론 (⚠️ UI 미연결 → S1)**
- `POST /api/inference/smart`
- `POST /api/inference/llm-filter`
- `POST /api/inference/run` + `llmBoost` 옵션

**기타 (⚠️ UI 미연결 → S1)**
- `POST /api/query`
- `GET /api/inference/runs/:id`
- `GET /api/rollup-events` (SSE)
- `PATCH /api/objects/:id`
- `GET /api/inference/profiles/default`
- `PUT /api/inference/profiles/default`

**운영**
- `GET /api/inference/runs`
- `POST /api/inference/runs`
- `POST /api/rollups`

### 5.2 CLI

- `anavi up [--port <n>] [--prod]`
- `anavi scan --workspace <id> [--path|--workspace-dir|--github-repo|--github-org]`
- `anavi infer --workspace <id> [--track a|b|all]`
- `anavi rebuild-rollup --workspace <id> [--incremental]`
- `anavi export --workspace <id> --format <json|dot> --output <path>`
- `anavi snapshot <save|restore> ...`
