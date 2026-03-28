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
| 추론 엔진 고도화 (P4) | ✅ | Cross-Signal Validation, Inter-procedural AST, LLM 추론 부스터, 프레임워크 플러그인 시스템, Delta Rollup + 실시간 갱신 구현 완료. 4-6은 후속 고도화 범위 |
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
  - 클라이언트는 EventSource 구독 후 현재 Mapping 뷰를 refetch
  - `EventSource` 미지원/생성 실패/연결 에러 시 polling fallback 적용
- ✅ `Approval > 관계 후보`
  - `POST /api/inference/run` 호출 버튼 제공
  - 실행 후 PENDING 후보 즉시 재조회
  - cross-validation 배지/경고 표시, 필터/정렬, endpoint 세부 매핑 제공
- ✅ `Approval > 도메인 후보`
  - `GET/PATCH /api/inference/domain-candidates*`로 승인/거부 처리
- ✅ Inference Run 운영 UI/API
  - `GET/POST /api/inference/runs`, `GET /api/inference/runs/:id`
  - quick run과 queued run 모두 binding/cross-validation 최종화 반영
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

### 1.3 Inference

- ✅ Relation 추론(구현 존재)
  - Config 기반: `inferRelationsFromConfig`
  - Code Signal(AST/Regex): `extractCodeSignalsWithEngine` (`hybrid` 기본, `ast`는 AST 실패 시 Regex fallback)
  - Code Signal 기반 후보 생성: `mode=code`로 `relation_candidates` 생성 (endpoint/topic/queue/db_table 포함, SPEC: `docs/spec/13-*`, `docs/spec/14-*`, `docs/spec/15-*`, `docs/spec/16-*`)
  - DB Signal: `extractDbSchemaSignals` (FK/implicit 후보 + schema evidence 연결)
  - Cross-Signal Validation: `crossValidatePendingRelationCandidates` (boost/penalty, repo-scoped rerun, contradiction rule finalization)
  - Config↔Code endpoint binding: `bindConfigToCodeEndpoints` (service→endpoint 후보 분해, stale metadata 정리)
  - 비동기 실행 오케스트레이션: `createInferenceRun` / `executeInferenceRun` / `listInferenceRuns` / `getInferenceRunDetail`
- ✅ Domain 추론
  - Track A(Seed-based): `runSeedBasedInference`
  - Track B(Discovery): `runDiscovery`
  - 도메인 후보 승인: `approveDomainCandidate`

### 1.4 AI

- ✅ Chat 스트리밍 API (`/api/chat`)
- ✅ Evidence Assembler / Answer Composer 연동
- ✅ LLM 후보 필터 API (`/api/inference/llm-filter`)

### 1.5 E2E 시나리오 테스트

- ✅ Playwright 시나리오 추가
  - 파일: `apps/web/tests/e2e/inference-approval-rollup-query-chat.spec.ts`
  - 검증 플로우: 추론 실행 → 관계 후보 승인 → rollup 재빌드 → query(provenance) → chat 카드 렌더링

---

## 2) 후속 고도화 메모

### 2.1 추론 엔진 품질 고도화 (P4)

- ✅ Cross-Signal Validation, Inter-procedural AST, LLM 추론 부스터, 프레임워크 플러그인 시스템, Delta Rollup + 실시간 갱신은 구현 완료되었고, 4-6 피드백 루프가 다음 고도화 범위로 남아 있다.
- ⚠️ 4-5의 실시간 계약은 SSE notification 후 refetch 방식이므로, 대형 그래프에서 재조회 비용 최적화 여지는 남아 있다.

### 2.2 실행 오케스트레이션 Phase 2+

- 📋 `cancel/retry`, 큐/워커 분리, 운영 대시보드는 `docs/spec/12-inference-run-orchestration-spec.md`의 후속 범위로 남아 있다.

### 2.3 도메인 추론 운영 UX

- ⚠️ Track A/B 실행 UX와 운영 가시성은 더 개선할 여지가 있지만, 구현 상태 자체는 P2 블로커가 아니다.

---

## 3) 설계 완료 / 구현 대기 (P4, P5)

> 아래 항목들은 설계 문서(Design + SPEC)가 완료되었고, 일부는 구현까지 완료되었다.
> 상세는 `docs/03-roadmap.md` P4/P5 섹션 및 각 SPEC 문서 참조.

### 3.1 P4: 추론 엔진 고도화 (v3.0) — ★ 최우선

| 항목 | SPEC | 상태 |
|------|------|------|
| 4-1. Inter-procedural AST 분석 | `docs/spec/17-inter-procedural-ast-spec.md` | ✅ Implemented |
| 4-2. Cross-Signal Validation | `docs/spec/18-cross-signal-validation-spec.md` | ✅ Implemented |
| 4-2a. Approval Mapping / Cross-validation UI 정합성 | `docs/spec/28-approval-mapping-ui-consistency-spec.md` | ✅ Implemented |
| 4-3. LLM 추론 부스터 | `docs/spec/19-llm-inference-boost-spec.md` | ✅ Implemented |
| 4-4. 프레임워크 플러그인 시스템 | `docs/spec/20-framework-plugin-system-spec.md` | ✅ Implemented |
| 4-5. Delta Rollup + 실시간 갱신 | `docs/spec/21-realtime-rollup-spec.md` | ✅ Implemented |
| 4-6. 추론 피드백 루프 | `docs/spec/22-inference-feedback-loop-spec.md` | 📋 Draft |

### 3.2 P5: 개발자 생산성 기능 (v3.1+)

| 항목 | SPEC | 상태 |
|------|------|------|
| 5-1. Change Impact Preview | `docs/spec/23-change-impact-preview-spec.md` | 📋 Draft |
| 5-2. Architecture Drift Detection | `docs/spec/24-architecture-drift-detection-spec.md` | 📋 Draft |
| 5-3. Personal Architecture Journal | `docs/spec/25-personal-architecture-journal-spec.md` | 📋 Draft |
| 5-4. API Contract Diff | `docs/spec/26-api-contract-diff-spec.md` | 📋 Draft |
| 5-5. Architecture Health Score | `docs/spec/27-architecture-health-score-spec.md` | 📋 Draft |
| 5-6. 구조적 개선 (서비스 레이어/커버리지/공유/Watcher) | `docs/design/08-developer-productivity.md` §7 | 📋 Draft |

---

## 4) 참고: 현재 주요 실행 엔트리포인트

### 4.1 Web API

- `POST /api/scan`
- `POST /api/inference/run`
- `GET /api/inference/runs`
- `POST /api/inference/runs`
- `GET /api/inference/runs/:id`
- `GET /api/inference/candidates`
- `PATCH /api/inference/candidates/:id`
- `GET /api/inference/candidates/:id/endpoints`
- `POST /api/inference/candidates/:id/map-endpoints`
- `GET /api/inference/domain-candidates`
- `PATCH /api/inference/domain-candidates/:id`
- `POST /api/inference/domain-run`
- `POST /api/inference/llm-filter`
- `POST /api/inference/smart`
- `GET /api/inference/profiles/default`
- `PUT /api/inference/profiles/default`
- `POST /api/query`
- `POST /api/chat`
- `POST /api/rollups`

### 4.2 CLI

- `anavi up [--port <n>] [--prod]`
- `anavi scan --workspace <id> [--path|--workspace-dir|--github-repo|--github-org]`
- `anavi infer --workspace <id> [--track a|b|all]`
- `anavi rebuild-rollup --workspace <id> [--incremental]`
- `anavi export --workspace <id> --format <json|dot> --output <path>`
- `anavi snapshot <save|restore> ...`
