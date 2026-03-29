# Archi.Navi — v2+ 로드맵

> 작성일: 2026-02-22 | 최종 갱신: 2026-03-29
> v1 구현 현황: `docs/02-implementation-status.md` 참고
> 추론 엔진 설계: `docs/design/03-inference-engine.md` v3.0, `docs/design/07-inference-engine-advanced.md` v1.0 참고

---

## 우선순위 정의

| 등급 | 의미 | 예상 시기 |
|------|------|----------|
| **P1** | 추론 파이프라인 MVP — 70%+ 자동화 달성 | v2.0 ✅ |
| **P2** | AST 정밀 추출 + AI 고도화 | v2.1 ✅ |
| **P3** | 대규모 그래프 성능 + 추론 고도화 | v2.2 ✅ |
| **P4** | 추론 엔진 고도화 — 90%+ 정밀도 달성 | v3.0 ✅ |
| **S1** | 🔧 안정화 — Dead Feature 활성화 + UX 기반 구축 + AI 고도화 | v3.1 |
| **P5** | 개발자 생산성 기능 + 구조 개선 | v3.2+ |

> **핵심 방향 전환**: P4까지의 백엔드/엔진 구현은 완료되었으나, 다수의 기능이 UI와 연결되지 않아 사용 불가 상태다.
> P5 신규 기능보다 **기존 구현의 활성화와 UX 안정화를 우선** 수행한다.
> 이유: (1) 이미 만든 코드를 살리는 것이 ROI 최대, (2) P5는 정확한 추론 결과에 의존하므로 LLM 추론 활성화가 전제조건.

---

## 현재 상태 요약 (2026-03-29)

| 구간 | 상태 | 비고 |
|------|------|------|
| P1 (1-1 ~ 1-6) | ✅ 완료 | 추론 MVP 기능/승인 플로우 구현 완료 |
| P2 (2-1 ~ 2-7) | ✅ 완료 | AST hybrid, Evidence Assembler, 비동기 run, Atomic 후보 생성 완료 |
| P3 (3-1 ~ 3-7) | ✅ 완료 | 증분 리빌드~3D 렌더러 전환까지 완료 |
| P4 (4-1 ~ 4-6) | ✅ 완료 | Inter-procedural AST, Cross-Validation, LLM Booster, Feedback Loop 구현 완료 |
| **S1 (안정화)** | **🔧 진행 중** | **S1-1~S1-6 Dead Feature 완료, UX 기반/AI 고도화 항목 진행** |
| P5 (5-1 ~ 5-5) | 📋 Draft | 생산성 기능 설계 완료, S1 이후 착수 |

---

## P1: 추론 파이프라인 MVP (v2.0) ✅

> **목표**: Regex + Config 파싱으로 전체 Relation의 60~80% 자동 추론

### ✅ 1-1. Config 기반 Relation 추론 (완료)
- **파일:** `packages/inference/src/relation/configBased.ts`
- **구현 완료:**
  - `application.yml` 파싱 → `spring.datasource.url` → database Object 생성 + `read`/`write` relation
  - `application.yml` 파싱 → `spring.kafka.*` → message_broker/topic Object 생성 + `produce`/`consume` relation
  - `docker-compose.yml` 파싱 → `depends_on` → service간 `depend_on` relation
  - K8s manifest 파싱 → 환경변수의 DB_URL, KAFKA_BROKERS → Object 생성 + relation
- **결과:** relation_candidates 테이블에 PENDING 상태로 저장 (테스트 52개 통과)
- **참조:** 03-inference-engine.md §7 Config 파싱 전략

### ✅ 1-2. Regex 기반 Code Signal 추출 (Phase 1) (완료)
- **파일:** `packages/inference/src/code/` (신규)
- **언어:** Java/Kotlin, TypeScript/JS, Python, MyBatis XML
- **구현 완료:**
  - `@GetMapping`/`@PostMapping` 등 + `@*Exchange` (HttpInterface) → `expose`/`call`
  - `RestTemplate`, `WebClient`, `FeignClient`, `RestClient` → `call`
  - `@KafkaListener`, `kafkaTemplate.send` → `consume`/`produce`
  - MyBatis XML SQL → `db_read`/`db_write`
  - JPA `@Table` → `db_mapping`
- **저장:** `code_artifacts` + `code_call_edges` + `evidences` (SHA256 증분 스캔)
- **테스트:** 46개 통과
- **참조:** 03-inference-engine.md §6.1 Phase 1

### ✅ 1-3. DB 시그널 추출 (완료)
- **파일:** `packages/inference/src/db/dbSchemaSignal.ts` (신규), `seedBased.ts` (수정)
- **구현 완료:**
  - FK 제약조건 → `relation_candidates` (confidence 0.95)
  - 컬럼명 `*_id`/`*_no` 패턴 → implicit FK `relation_candidates` (confidence 0.5)
  - 테이블 prefix → 도메인 매칭 → `dbScore` 실제 계산 (기존 하드코딩 0 → 실제값)
- **테스트:** 20개 통과
- **의존:** DB 스키마 메타데이터가 objects 테이블에 등록되어 있어야 함

### ✅ 1-4. Domain Candidates 승인 API + UI (완료)
- **API:** `GET/PATCH /api/inference/domain-candidates`
- **구현 완료:**
  - `approveDomainCandidate.ts` 승인/거부 로직 → `object_domain_affinities` upsert
  - Approval 페이지에 Relations/Domains 탭 추가 (`DomainApprovalList`, `ApprovalTabs`)
- **테스트:** 6개 통과 (T1~T6)
- **참조:** 03-inference-engine.md §8.2

### ✅ 1-5. Discovery 다중 레이어 통합 (완료)
- **파일:** `packages/inference/src/domain/discovery.ts`
- **구현 완료:**
  - SERVICE_TO_DATABASE / SERVICE_TO_BROKER rollup 엣지 추가
  - `domain_inference_profiles`의 `enabled_layers` + 엣지 가중치 (`edge_w_call`, `edge_w_rw`, `edge_w_msg`) 적용
  - `addOrMergeEdge` 헬퍼로 동일 노드 쌍 가중치 누적
  - `domainDiscoveryRuns.inputLayers` 실제 사용 레이어 기록
- **테스트:** 7개 통과 (T1~T7)
- **참조:** 03-inference-engine.md §4.2

### ✅ 1-6. 클러스터 Label 자동 추출 (완료)
- **파일:** `packages/inference/src/domain/labelExtractor.ts` (신규), `discovery.ts` (수정)
- **구현 완료:**
  - `tokenize()`: camelCase/PascalCase 분리 + 구분자 분리 + STOP_WORDS 필터
  - `extractLabelCandidates()`: 토큰 빈도 분석 → score = count/totalCount → 상위 3개 후보
  - `discovery.ts`: 클러스터 멤버 이름 DB 조회 → `labelCandidates` metadata 채움
- **테스트:** labelExtractor 8개 + discovery T8 통과
- **참조:** 03-inference-engine.md §4.5

---

## P2: AST 정밀 추출 + AI 고도화 (v2.1) ✅

> **목표**: AST로 추론 정밀도 85~95% 달성, Evidence 기반 AI Chat 고도화

### ✅ 2-1. AST Plugin (Tree-sitter) — Phase 2 (완료)
- **파일:** `packages/inference/src/code/ast/` (신규)
- **SPEC:** `docs/spec/10-ast-default-code-signal-spec.md`
- **언어:** Java/Kotlin, TypeScript/JavaScript, Python
- **구현 완료:**
  - AST 분석 모듈/파서 구현
  - `/api/inference/run` 기본 코드 추출 경로를 `hybrid(AST+Regex 병합)`로 전환
  - `hybrid/ast/regex` 엔진 선택과 `auto -> ast` 정규화 지원
  - 요청 엔진/실사용 엔진/fallback 여부 및 관련 테스트 반영
  - 설정 UI에서 코드 시그널 엔진 기본값 선택 지원
- **Phase 1 대비 개선:**
  - 변수/상수로 지정된 URL 추적 (data-flow analysis)
  - 간접 호출 감지 (인터페이스 구현체 매핑)
  - 멀티라인 패턴 정확 추출
  - 같은 패턴도 confidence +0.1~0.2 상향
- **출력:** Phase 1과 동일 형식 (`code_artifacts`, `code_call_edges`, `code_import_edges`)
- **의존:** tree-sitter 바인딩 + 언어별 grammar
- **참조:** 03-inference-engine.md §6.2
- **후속 고도화:** P4 4-1에서 Inter-procedural 분석으로 확장

### ✅ 2-2. Evidence Assembler (완료)
- **파일:** `packages/core/src/ai/evidence-assembler.ts` (신규)
- **기능:**
  - 쿼리 결과 → 증거 체인 구조화 (max 10개)
  - confidence × weight × hop 거리 기준 우선순위
  - 파일 경로 + 라인 + excerpt 포함
- **연동:** Chat API에서 queryContext 대신 evidence chain 주입

### ✅ 2-3. Answer Composer 템플릿 (완료)
- **파일:** `apps/web/src/app/api/chat/route.ts` 확장
- **구조:** 결론 → 신뢰도 → 증거 목록 → 요약 → deep-link
- **UI:** `floating-chat.tsx`에 evidence 카드 렌더링

### ✅ 2-4. DOMAIN_SUMMARY 쿼리 완성 (완료)
- **파일:** `packages/core/src/query-engine/executor.ts`
- **구현 완료:**
  - deterministic 집계 + LLM 포맷팅 (도메인별 서비스 수, 관계 밀도, purity 통계)
  - Query Engine `DOMAIN_SUMMARY` 실응답 경로 연동

### ✅ 2-5. Message 시그널 추출 (완료)
- **파일:** `packages/inference/src/domain/seedBased.ts`
- **구현 완료:**
  - 토픽 네이밍 패턴 분석 → producer/consumer 결합도 → 도메인 affinity
  - `msgScore` 계산값을 Seed-based 도메인 추론에 실제 반영

### ✅ 2-6. Inference 운영 오케스트레이션 고도화 (완료)
- **SPEC:** `docs/spec/12-inference-run-orchestration-spec.md`
- **구현 완료:**
  - 비동기 실행 API: `POST/GET /api/inference/runs`, `GET /api/inference/runs/:id`
  - 실행 상태 저장 테이블: `inference_runs`, `inference_run_sources`, `inference_run_events`
  - local source 기준 background 실행 + 상태 전이/경고/오류 이력 저장
  - `githubRepo`/`githubOrg` source를 `gh` 기반 clone으로 실행 경로에 연결
  - source별 상태(`QUEUED/RUNNING/SUCCEEDED/FAILED/SKIPPED`) 및 run 이벤트 로그 저장
  - 기존 `/api/inference/run` quick run 경로는 유지
- **후속 고도화(Phase 2+):**
  - 재시도(backoff), 취소, 실행 큐/워커 분리
  - 운영 UI 상태 카드/지표 대시보드

### ✅ 2-7. Compound → Atomic 후보 추론 고도화 (완료)
- **SPEC:**
  - `docs/spec/13-code-based-relation-candidate-spec.md`
  - `docs/spec/14-compound-to-atomic-inference-spec.md`
  - `docs/spec/15-rabbitmq-queue-code-signal-spec.md` (RabbitMQ 우선)
  - `docs/spec/16-db-table-code-signal-spec.md` (db_table은 database 소속 필수)
- **목표:** 설정 파일이 없더라도 `mode=code`만으로 Atomic 생성 및 `relation_candidates` 생성이 가능해야 한다.
- **구현 완료:**
  - `expose` 기반 `api_endpoint` Atomic upsert
  - URL(host+path) 기반 `call`의 endpoint 매핑 시도(유일 매칭이면 `service -> api_endpoint`, 실패 시 `service -> service` fallback)
  - `produce/consume` 기반 `service -> topic` 후보 생성
  - RabbitMQ queue 추출/후보 생성(`queue`, produce/consume)
  - `db_table` read/write 후보 생성 및 database parent 연결(항상 parent 보장)
- **후속 고도화:**
  - path-only 호출의 타깃 서비스 식별 정밀도 향상
  - queue/db_table 동적 이름 추적, SQL/프레임워크별 정밀도 강화

---

## P3: 대규모 그래프 성능 + 추론 고도화 (v2.2) ✅

### ✅ 3-1. 증분 리빌드 (완료)
- **SPEC:** `docs/spec/05-incremental-rollup-rebuild-spec.md`
- **파일:** `packages/core/src/rollup/builder.ts`, `apps/web/src/lib/rollup-change-events.ts`
- **구현 완료:**
  - `incrementalRebuild` 기반 영향 범위(level/affected service) 계산 + in-place 갱신
  - API 변경 이벤트 연동:
    - `PATCH /api/inference/candidates/:id` (승인)
    - `PATCH /api/inference/domain-candidates/:id` (승인)
    - `POST /api/relations` (직접 승인 등록)
    - `DELETE /api/relations/:id` (관계 삭제)
  - `expose` 관계는 `EXPOSE_CHANGED` 이벤트로 처리해 caller 역추적 반영
  - 증분 대상이 없거나 ACTIVE generation이 없으면 안전 fallback 처리

### ✅ 3-2. Hub 처리 UI (완료)
- **SPEC:** `docs/spec/06-hub-node-management-spec.md`
- **기준:** `object_graph_stats.inDegree >= threshold` (기본 50, 설정에서 조정 가능)
- **구현 완료:**
  - Mapping 그래프 우상단 `Hub 접기/펼치기` 토글
  - Hub 노드에 in-degree 카운트 배지 표시
  - `/api/rollups` 응답에 `graphStats` 포함하여 UI 판정에 활용

### ✅ 3-3. 프로그레시브 렌더링 (완료)
- **SPEC:** `docs/spec/07-progressive-rendering-spec.md`
- **파일:** `apps/web/src/components/mapping/rollup-graph.tsx`
- **구현 완료:**
  - 2000+ 엣지에서 `requestAnimationFrame` 기반 점진 렌더링 자동 활성화
  - 200 엣지/배치로 렌더링하며 진행 상태(`edge rendered/total`) 표시
  - 소규모 그래프는 기존 즉시 렌더링 경로 유지

### ✅ 3-4. Domain-first 내비게이션 (완료)
- **SPEC:** `docs/spec/08-domain-first-navigation-spec.md`
- **구현 완료:**
  - 기본 진입 레벨을 `DOMAIN_TO_DOMAIN`으로 전환 (도메인 데이터 없으면 `SERVICE_TO_SERVICE` fallback)
  - `DOMAIN_TO_DOMAIN`에서 도메인 클릭 시 `SERVICE_TO_SERVICE` 자동 전환
  - `SERVICE_TO_SERVICE`에서 서비스 클릭 시 Atomic(Roll-down) 자동 전환
  - 브레드크럼 내비게이션 + `상위로` 버튼으로 단계 복귀
  - `object_domain_affinities` 기반 도메인별 서비스 필터링 적용

### ✅ 3-5. 증분 추론 (완료)
- **SPEC:** `docs/spec/09-incremental-inference-spec.md`
- **구현 완료:**
  - Config 추론 경로(`inferRelationsFromConfig`)에 SHA256 기반 파일 변경 감지 적용
  - 변경 없는 설정 파일은 파싱/추론을 건너뛰고 기존 결과를 유지
  - 변경된 설정 파일만 재처리 후 해시 갱신
  - DB 스키마 추론 경로(`extractDbSchemaSignals`)에 db_table 메타 해시 기반 증분 처리 적용
  - 변경된 테이블만 재처리하고, 해당 테이블의 기존 `PENDING fk_reference` 후보를 갱신
  - `/api/inference/run`에서 `incremental` 옵션으로 config/db 증분 추론 동시 제어
  - `/api/inference/run` 응답에 config 스캔 통계(`fileCount`, `processedFileCount`, `skippedFileCount`) 노출

### ✅ 3-6. DB 추론 확장 (완료)
- **구현 완료:**
  - `db_table.metadata.unique_constraints`와 `indexes(unique=true)`에서 FK 유사 컬럼(`*_id`, `*_no`)을 식별하여 `fk_reference` 후보 생성
  - 복합 인덱스(`columns.length >= 2`) 기반으로 조인 관계 힌트 후보 생성
  - 신호 우선순위 적용: `FK(0.95) > Unique(0.85) > Index(0.7) > Column Pattern(0.5)`
  - Evidence kind 확장: `db_schema_unique_hint`, `db_schema_index_hint`
  - 기존 증분 처리 해시/중복 방지 로직과 통합
  - 단위 테스트 보강: unique/index/FK 중복 방지 케이스 추가

### ✅ 3-7. Object Mapping 3D 렌더러 전환 (완료)
- **구현 완료:**
  - `3d-force-graph` 기반 3D 렌더러(`rollup-graph-3d.tsx`) 추가
  - Object Mapping 렌더러를 3D 단일 모드로 전환(2D 선택 UI 제거)
  - 기존 핵심 동작(레벨 전환, Domain-first drill-down, Roll-down 패널, Hub 토글) 상태 흐름 유지
  - WebGL 미지원 환경 fallback 메시지 제공
  - e2e 보강: 3D 기본 렌더링 시나리오 추가

---

## 🔥 P4: 추론 엔진 고도화 (v3.0) ✅

> **목표**: 추론 정밀도 90~95% 달성 + 노이즈 50% 이상 감소
> **설계 문서**: `docs/design/07-inference-engine-advanced.md`

### ✅ 4-1. Inter-procedural AST 분석 (기존 2-1 확장)
- **SPEC:** `docs/spec/17-inter-procedural-ast-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §2
- **핵심:**
  - Multi-file Symbol Table 구축 (클래스/인터페이스/메서드 계보)
  - Call Chain Resolution — 메서드 호출 체인 추적 (최대 depth 3)
  - Spring 프로퍼티 전파 (`@Value` → application.yml 연결 → URL 확정)
  - 인터페이스 → 구현체 매핑 (FeignClient 등)
- **구현 범위:**
  - `interProcedural`, `maxCallChainDepth`, `resolveProperties` 요청 옵션/API 전달 경로 반영
  - 프로젝트 단위 Symbol Table / Implementation Map 구축
  - Java/Kotlin AST 경로에서 depth 2~3 call chain 해석 + `maxCallChainDepth` 적용
  - `@Value`/`application*.yml` 기반 property 전파 및 `resolvedUrl`/`resolvedVia` metadata 반영
  - 단일/다중 구현체 interface 호출 해석, `interfaceImpl`/`ambiguous` metadata 및 confidence penalty 반영
  - FeignClient depth-chain 시나리오 및 Symbol Table 성능 검증 테스트 반영
- **후속 범위:**
  - TypeScript/Python inter-procedural 해석
  - multi-module symbol table 연결
  - symbol table 디스크 캐싱

### ✅ 4-2. Cross-Signal Validation (교차 검증)
- **SPEC:** `docs/spec/18-cross-signal-validation-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §3
- **핵심:**
  - config + code + db 시그널 간 교차 검증
  - 복수 시그널 지지 시 신뢰도 부스트 (Bayesian 업데이트)
  - 모순 감지 (Stale Config, Phantom Call, Dead Topic, Orphan FK)
  - 승인 UI에 교차 검증 배지 표시

### ✅ 4-3. LLM 추론 부스터 (기존 LLM 필터 확장)
- **SPEC:** `docs/spec/19-llm-inference-boost-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §4
- **구현 완료 범위:**
  - `POST /api/inference/llm-filter` 에 `generateExplanations` / `maxCalls` 경로 추가
  - 같은 `subjectObjectId` 기준 설명 배치 그룹화
  - `relation_candidates.metadata.llmExplanation` 저장 및 `/api/inference/candidates` 노출
  - Approval 목록 카드에 LLM 설명 표시
  - `POST /api/inference/run` 에 `llmBoost.enabled`, `codeIntentAnalysis`, `generateExplanations`, `maxCalls` 연결
  - unresolved 동적 호출 코드 시그널을 대상으로 `source="LLM_BOOST"` 보완 후보 생성 및 비용 상한 적용
  - `POST /api/inference/domain-run` 에 `llmLabel.enabled` 연결
  - Discovery 도메인 객체 `metadata.llmLabel` 에 한국어/영어 쌍 저장
  - LLM 미설정/실패 시 기존 추론 결과 유지(graceful degradation)
- **⚠️ UI 미연결 (S1에서 해결):** 프론트엔드에서 `llmBoost` 파라미터를 전달하지 않아 기능 비활성 상태

### ✅ 4-4. 프레임워크 플러그인 시스템
- **SPEC:** `docs/spec/20-framework-plugin-system-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §5
- **구현 완료:**
  - `packages/inference/src/code/plugins/`에 plugin type/registry/runtime 추가
  - `spring-boot`, `java-common`, `express`, `nestjs`, `typescript-common`, `fastapi`, `flask`, `python-common` built-in plugin 등록
  - `extractCodeSignals` / `extractHybridCodeSignals` / `extractAstCodeSignals`가 파일별 플러그인 선택 기반으로 동작하도록 전환
  - manifest 기반 detector + 언어별 fallback + registry 확장 테스트 추가

### ✅ 4-5. Delta Rollup + 실시간 그래프 갱신
- **SPEC:** `docs/spec/21-realtime-rollup-spec.md`
- **구현 완료 범위:**
  - 관계 후보 승인, 수동 relation 추가, 승인된 base relation 삭제가 `incrementalRebuild` 기반 delta rollup으로 처리된다.
  - `map-endpoints`는 여러 relation change event를 모아 batch delta로 처리한다.
  - 실시간 반영 계약은 WebSocket이 아니라 `SSE(EventSource) + client refetch + failure 시 polling fallback`이다.
  - 서버는 edge delta payload를 push하지 않고 `rollup-change` notification만 발행한다.
- **⚠️ UI 미연결 (S1에서 해결):** SSE EventSource 소비자가 프론트엔드에 미구현, 수동 새로고침 필요

### ✅ 4-6. 추론 피드백 루프
- **SPEC:** `docs/spec/22-inference-feedback-loop-spec.md`
- **후속 SPEC:** `docs/spec/36-relation-feedback-key-specialization-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §6
- **구현 완료 범위:**
  - relation candidate 승인/거절을 `relationType:sourceFamily:signalKind` canonical key 기준으로 집계
  - 누적 결과를 기존 relation 후보에 소급하지 않고 다음 inference run부터만 base confidence 보정에 반영
  - `GET/PUT /api/inference/profiles/default` public contract가 `relationFeedback*` / `domainFeedback*` 및 `resetRelationFeedback` / `resetDomainFeedback`로 분리됨
  - Settings가 relation/domain summary, detail, reset 흐름을 분리해 노출함
  - domain candidate 승인/거절이 Track A only domain feedback를 집계함
  - domain key는 `TRACK_A:{primaryDomainId}:{purityBucket}`
  - domain 보정은 승인 직후 소급 적용하지 않고 다음 Track A domain run부터만 반영
  - `GET /api/inference/domain-candidates`가 Track A domain feedback metadata를 함께 노출함
  - code-origin relation feedback가 `framework/language`를 안정적으로 가지면 `relationType:sourceFamily:signalKind:framework:language` specialized key를 사용함
  - framework/language가 없으면 legacy v1 key로 fallback 하며, next-run apply lookup은 `v2 -> legacy v1` dual-read를 사용함
  - `GET /api/inference/candidates` public contract가 3-segment/5-segment feedback key를 opaque string으로 모두 수용함
  - generic alias `feedbackConfig` / `feedbackAdjustments` / `feedbackSummary` / `feedbackEntries` / `resetAll`은 public contract가 아님
- **범위 제외 / 비주장:**
  - Track B / domain discovery feedback 집계 및 적용
  - queued/orchestrated parity claim

---

## 🔧 S1: 안정화 — Dead Feature 활성화 + UX 기반 구축 (v3.1)

> **목표**: P4까지 구현된 백엔드 기능을 UI에 연결하고, UX 기반을 다져 P5의 토대를 만든다.
> **원칙**: 신규 백엔드 로직 최소화, 프론트엔드 연결 및 UX 개선에 집중.
> **이유**: (1) LLM 추론 활성화 없이 P5를 만들면 부정확한 데이터 위에 기능이 구축됨,
>           (2) Object 수정, Pagination 등 기본 UX가 불완전한 상태에서 고급 기능은 실용성이 낮음.

### Phase 1: Dead Feature 활성화 (높은 ROI — API 이미 완성)

#### ✅ S1-1. LLM 추론 기능 재정렬 ★ (완료)

> 가장 핵심적인 개선 — Smart를 먼저 요구사항에 맞게 재설계하고, 그 위에 LLM 기능 UI를 안정적으로 연결한다.

**S1-1a. Smart Pipeline 재설계 및 재활성화 (완료)**
- **현황:** `POST /api/inference/smart` 재설계 범위를 완료했다. Phase 1.5 bootstrap, pair-scoped evidence pack, atomic inference 재작성, fallback observability/UI 노출, optional deep inspection, deterministic tool-assisted deep inspection(1차/2차), trace/observability viewer(`deepInspectionTrace.details` pair drill-down), `no_result` pass-through 표시 보정까지 반영했다.
- **검증(최종):**
  - `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/orchestration/smartPipeline.test.ts` → `1 file, 22 tests passed`
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/smart.route.test.ts src/__tests__/approval-list.test.tsx` → `2 files, 25 tests passed`
- **SPEC:** `docs/spec/37-smart-pipeline-atomic-redesign-spec.md`
- **목표:** `config -> candidate service pair -> pair-scoped source analysis -> atomic relation` 흐름으로 재구성
- **핵심 작업 순서:**
  - OpenAPI import 뒤에 `Phase 1.5 endpoint bootstrap` 추가 (`expose -> api_endpoint`)
  - pair-scoped evidence pack assembler 구현
  - Smart Phase 3를 atomic inference 중심으로 재작성
  - fallback reason / run detail observability 추가
  - deterministic tool-assisted deep inspection 1차/2차 반영
  - `deepInspectionTrace.details` 기반 pair drill-down viewer 반영
- **UI:** Smart 실행 UI는 summary에 atomic/fallback/bootstrap 통계를 노출하며, Approval fallback 후보 카드에 시도 호출/근거 요약을 표시한다. deep inspection 전용 viewer도 Approval 화면에 연결됐다.

**S1-1b. LLM Boost 옵션 UI 연결 (완료)**
- **백엔드:** `POST /api/inference/run` + `llmBoost` 파라미터 (구현 완료)
- **상태:** 기존 추론 실행 UI에서 `llmBoost.enabled: true` 옵션을 토글해 호출한다.
- **기능:** 정적 분석 + LLM 코드 의도 분석 병행 실행
- **UI:** Approval 추론 실행 흐름에서 `정적 + LLM 보강` 모드로 연결됨

**S1-1c. LLM Filter UI 연결 (완료)**
- **백엔드:** `POST /api/inference/llm-filter` (구현 완료)
- **상태:** 승인 화면에서 LLM 필터 실행 버튼이 API 호출로 연결됨
- **기능:** PENDING 후보를 LLM이 평가 (LIKELY_VALID/UNCERTAIN/FALSE_POSITIVE), 설명 자동 생성
- **UI:** 승인 목록 상단 "LLM 평가 실행" 버튼으로 연결됨

**S1-1 종료 판정**
- `S1-1a/b/c`를 모두 완료했으며, `S1-1`은 종료로 판정한다.
- 단, `S1` 전체 완료를 의미하지는 않으며 다음 우선순위는 `S1-7` 이후 UX/AI 항목이다.

#### ✅ S1-2. Object 수정 기능 연결 (완료)
- **백엔드:** `PATCH /api/objects/:id` (구현 완료)
- **현황:** 서비스 상세 Sheet에서 `displayName`/`description` 인라인 편집과 `visibility` 토글이 `PATCH /api/objects/:id`로 연결되어 있다. 목록 카드 visibility 토글도 같은 PATCH 경로를 사용한다.
- **검증(최종):**
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/objects-id.route.test.ts src/__tests__/service-list-client.test.tsx` → `2 files, 7 tests passed`
- **완료 범위:**
  - `PATCH /api/objects/:id` route 계약 회귀 테스트 추가
  - `ServiceListClient`의 `displayName`/`description`/`visibility` 편집 흐름 회귀 테스트 추가
  - `workspaceId` payload와 `where(id + workspaceId)` update scope 회귀 고정
- **기대 효과:** 잘못 등록된 서비스명을 삭제/재생성 없이 바로 수정 가능

#### ✅ S1-3. SSE 실시간 그래프 갱신 연결 (완료)
- **백엔드:** `GET /api/rollup-events` SSE 스트림 (구현 완료)
- **현황:** Mapping 화면(`rollup-graph.tsx`)과 Architecture 화면(`layered-architecture-view.tsx`) 모두 `subscribeToRollupEvents` 소비가 연결되어 `rollup-change` 수신 시 자동 refetch가 동작한다.
- **검증(최종):**
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/rollup-event-source.test.ts src/__tests__/rollup-graph.test.tsx src/__tests__/layered-architecture-view.test.tsx` → `3 files, 10 tests passed`
- **완료 범위:**
  - SSE/polling fallback 유틸 계약 회귀(`rollup-event-source.test.ts`)
  - Mapping SSE wiring 회귀(`rollup-graph.test.tsx`)
  - Architecture SSE wiring 회귀(`layered-architecture-view.test.tsx`)

#### ✅ S1-4. Query Engine 직접 호출 UI (완료)
- **백엔드:** `POST /api/query` (구현 완료 — IMPACT_ANALYSIS, PATH_DISCOVERY, USAGE_DISCOVERY, DOMAIN_SUMMARY)
- **현황:** `/query` 페이지가 `QueryClient`를 렌더링하며, UI에서 `POST /api/query`를 직접 호출해 `IMPACT_ANALYSIS`, `PATH_DISCOVERY`, `USAGE_DISCOVERY`, `DOMAIN_SUMMARY`를 실행할 수 있다.
- **검증(최종):**
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/query-client.test.tsx src/__tests__/query-page.test.tsx` → `2 files, 7 tests passed`
- **완료 범위:**
  - `QueryClient` 타입별 파라미터 검증/요청 payload/결과 렌더링/실패 처리 회귀 테스트 추가
  - `/query` 페이지의 `QueryClient` 렌더링 smoke test 추가
- **기대 효과:** Chat 없이도 구조화된 쿼리를 직접 실행하고 결과를 즉시 확인 가능

#### ✅ S1-5. 추론 실행 상세 조회 연결 (완료)
- **백엔드:** `GET /api/inference/runs/:id` (구현 완료)
- **현황:** 추론 이력 항목 확장 시 개별 실행 상세, source 목록, event 로그를 즉시 조회해 표시한다.
- **검증(최종):**
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/inference-run-list.test.tsx src/__tests__/inference-runs-id.route.test.ts` → `2 files, 12 tests passed`
- **완료 범위:**
  - `InferenceRunList` 상세 조회, 캐시 재사용, 실패 toast 흐름 회귀 테스트 추가
  - `null` 상세 응답 시 확장 상태를 접고 캐시 오염 없이 재조회 가능하도록 보정
  - `GET /api/inference/runs/:id`의 `401/400/200/404/500` 회귀 테스트 추가
- **기대 효과:** 추론 실행 목록에서 개별 run의 source/event 상세를 바로 추적 가능

#### ✅ S1-6. 후보 목록 Pagination (완료)
- **백엔드:** `limit/offset` 파라미터 지원 (구현 완료)
- **현황:** 승인 목록이 `CANDIDATE_PAGE_SIZE=200` 기준으로 페이지 단위 fetch를 수행하고, `더 보기` 버튼으로 다음 페이지를 append 로드한다.
- **검증(최종):**
  - `pnpm --filter @archi-navi/web exec vitest run src/__tests__/approval-list.test.tsx src/__tests__/inference-candidates.route.test.ts` → `2 files, 29 tests passed`
- **완료 범위:**
  - `ApprovalList`가 `limit/offset` 기반으로 후보 목록을 페이지 단위 조회
  - `더 보기`로 다음 페이지 append 로드 후 기존 정렬/교차 검증 필터 흐름 유지
  - `GET /api/inference/candidates`의 `limit/offset` contract 회귀 테스트 유지
- **기대 효과:** 대규모 워크스페이스에서도 승인 목록의 초기 로드 비용을 제한할 수 있음

### Phase 2: UX 기반 구축

#### 🔧 S1-7. Dashboard Home
- **현재 문제:** 워크스페이스 선택 후 바로 빈 그래프 → 사용자 이탈
- **작업:** 대시보드 홈 화면 신규 추가
- **표시 항목:**
  - 총 서비스/오브젝트 수
  - 미승인 후보 수 (관계 + 도메인)
  - 최근 추론 실행 결과 요약
  - 빠른 액션 (추론 실행, 코드 스캔, 승인 이동)

#### 🔧 S1-8. Empty State 가이드
- **현재 문제:** 그래프/목록이 비어 있을 때 "다음에 뭘 해야 하는지" 안내 부족
- **작업:** 주요 화면에 Empty State 액션 카드 추가
- **대상 화면:**
  - Architecture View: "서비스를 등록하고 추론을 실행하세요" + 바로가기
  - Mapping Graph: "코드 스캔으로 시작하기" 또는 "샘플 데이터 로드"
  - Approval: (이미 부분 구현) 강화 — 추론 미실행 시 안내 문구

#### 🔧 S1-9. 사이드바 접기/펼치기
- **현재 문제:** 256px 고정 너비 → 그래프 뷰 공간 부족
- **작업:** 아이콘 모드로 사이드바를 축소/확장하는 토글 버튼 추가
- **기대:** 그래프 탐색 시 화면 활용도 대폭 향상

### Phase 3: AI 고도화

#### 🔧 S1-10. Chat Intent Router 개선
- **현재 문제:** "영향"→IMPACT, "경로"→PATH 등 키워드 매칭 기반으로 자연어 의도 파싱이 약함
- **작업:** LLM 기반 Intent 분류로 전환 (소형 모델로 비용 절감)
- **기대:** "결제 서비스 바꾸면 어디가 터져?" 같은 자연어도 정확하게 IMPACT_ANALYSIS로 라우팅

#### 🔧 S1-11. 도메인 해석 정확도 개선
- **현재 문제:** `resolveDomainId()`가 substring 매칭 → "order" 도메인이 "reorder-service"도 매칭
- **작업:** 단어 경계 매칭 또는 edit distance 기반으로 전환
- **기대:** false positive 도메인 해석 제거

#### 🔧 S1-12. Evidence Truncation 전략
- **현재 문제:** `maxOutputTokens: 2048` 하드코딩, 긴 증거 체인이 LLM 토큰 한계 초과 가능
- **작업:** confidence 상위 N개만 컨텍스트에 포함, 나머지는 "N개 추가 증거 있음"으로 요약
- **기대:** 대규모 워크스페이스에서도 Chat 응답 안정성 확보

#### 🔧 S1-13. 채팅 기록 영속화
- **현재 문제:** 새로고침 시 채팅 소실
- **작업:** localStorage 또는 DB 저장으로 대화 이력 보존
- **기대:** 이전 질의/답변 참조 가능

### Phase 4: 코드 유지보수성

#### 🔧 S1-14. 대형 컴포넌트 분할
- **대상:** `rollup-graph.tsx` (1,448줄)
- **작업:** 렌더링 / 데이터 페칭 / 컨트롤 패널 / 이벤트 핸들링으로 모듈 분리
- **기대:** 유지보수성 향상, P5 기능 추가 시 변경 범위 축소

#### 🔧 S1-15. Evidence 중복 제거
- **현재 문제:** 동일 코드 패턴이 다중 파일에서 탐지 시 evidence 중복 → confidence 인플레이션
- **작업:** content hash(SHA256) 기반 중복 제거 로직 추가
- **기대:** 추론 신뢰도 정확성 향상

---

## P5: 개발자 생산성 기능 + 구조 개선 (v3.2+)

> **목표**: 추론 엔진의 아키텍처 지식을 일상 개발 워크플로우에 직접 연결
> **전제 조건**: S1 완료 (LLM 추론 활성화 + UX 안정화)
> **설계 문서**: `docs/design/08-developer-productivity.md`

### 📋 5-1. Change Impact Preview (변경 영향도 미리보기)
- **SPEC:** `docs/spec/23-change-impact-preview-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §2
- **핵심:**
  - `git diff` → 변경 파일 → code_artifacts 매핑 → 영향받는 서비스/API/토픽 식별
  - CLI: `anavi impact --workspace <id> --diff HEAD~1`
  - Query Engine IMPACT_ANALYSIS 연동
- **기대 효과:** PR 리뷰 시 변경 영향도 즉시 파악
- **S1 의존:** S1-1(LLM 추론 활성화)로 추론 정확도 확보 후 착수

### 📋 5-2. Architecture Drift Detection (드리프트 감지)
- **SPEC:** `docs/spec/24-architecture-drift-detection-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §3
- **핵심:**
  - rollup generation 간 diff → 새 의존성/소멸/순환 의존 감지
  - 심각도 판정 (INFO/WARNING/CRITICAL)
  - CLI: `anavi drift --workspace <id>`
- **기대 효과:** 아키텍처 변화를 능동적으로 감지
- **S1 의존:** S1-3(SSE 실시간 갱신)으로 실시간 알림 인프라 확보 후 착수

### 📋 5-3. Personal Architecture Journal (개인 아키텍처 저널)
- **SPEC:** `docs/spec/25-personal-architecture-journal-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §5
- **핵심:**
  - 서비스/관계에 개인 메모/태그 연결 (warning, tip, todo, context, decision)
  - Object Mapping 그래프에 메모 아이콘 표시
  - export/import 지원
- **기대 효과:** 암묵지 체계화 → 온보딩 자료 자동 축적

### 📋 5-4. API Contract Diff (API 계약 변경 감지)
- **SPEC:** `docs/spec/26-api-contract-diff-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §6
- **핵심:**
  - expose 시그널 버전별 비교 → 엔드포인트 추가/삭제/변경 감지
  - 삭제된 endpoint의 caller 자동 경고
- **기대 효과:** API 호환성 파괴 사전 감지

### 📋 5-5. Architecture Health Score (아키텍처 건강도)
- **SPEC:** `docs/spec/27-architecture-health-score-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §4
- **핵심:**
  - 6개 지표 (결합도, 도메인 순수도, 순환 의존, Hub 집중도, Evidence 커버리지, Approval 비율)
  - 서비스별/워크스페이스별 점수 산출 + 등급 판정
  - CLI: `anavi health --workspace <id>`
- **기대 효과:** 아키텍처 품질 수치화 + 개선 방향 제시
- **S1 의존:** S1-7(Dashboard Home)에 건강 점수 위젯으로 통합

### 📋 5-6. 구조적 개선
- **설계:** `docs/design/08-developer-productivity.md` §7
- **항목:**
  - **서비스 레이어 분리**: API route를 thin HTTP 어댑터로, 비즈니스 로직을 패키지로 완전 분리
  - **추론 커버리지 리포트**: 분석 성공/실패 비율 + 언어별 커버리지 노출
  - **Workspace 공유**: snapshot export/import/merge 확장
  - **파일 시스템 Watcher**: `anavi watch` — chokidar 기반 자동 증분 추론

---

## 구현 순서 가이드

```
P1~P4 완료 기반              S1 안정화 (★ 최우선)
─────────────────────────────────────────────────
4-3 LLM Booster 구현 ──────→ S1-1 LLM 추론 UI 연결 ★
4-5 SSE 서버 구현 ─────────→ S1-3 SSE 클라이언트 연결
PATCH API 구현 ────────────→ S1-2 Object 수정 UI 연결
Query Engine 구현 ─────────→ S1-4 Query UI 연결
                              S1-5~6 추론 상세 + Pagination
                              S1-7~9 Dashboard + Empty State + 사이드바
                              S1-10~13 AI 고도화
                              S1-14~15 코드 정리
                              ─────────────────────
                              P5 생산성 기능 (S1 완료 후)
                              5-1 Change Impact
                              5-2 Drift Detection
                              5-5 Health Score
                              5-3 Journal
                              5-4 API Contract Diff
                              5-6 구조 개선
```

> **핵심**: P4까지 백엔드 구현은 완료되었으나, UI 미연결로 사용 불가능한 기능이 다수 존재한다.
> S1은 "이미 만든 것을 살리는" 단계로 ROI가 가장 높고, P5의 신뢰도 전제조건을 충족시킨다.
> 특히 S1-1(LLM 추론 UI 연결)은 전체 시스템 가치를 결정하는 최우선 과제다.

---

## 참고 설계 문서

| 로드맵 항목 | 참조 문서 |
|------------|----------|
| Config 기반 추론 | `docs/design/03-inference-engine.md` §7 Config 파싱 전략 |
| Regex Code Signal | `docs/design/03-inference-engine.md` §6.1 Phase 1 |
| AST Plugin | `docs/design/03-inference-engine.md` §6.2 Phase 2 |
| DB 시그널 | `docs/design/03-inference-engine.md` §5 DB 스키마 신호 추출 |
| Domain 승인 API | `docs/design/03-inference-engine.md` §8.2 Domain 승인 |
| Discovery 멀티 레이어 | `docs/design/03-inference-engine.md` §4.2 |
| 증분 리빌드(3-1) | `docs/spec/05-incremental-rollup-rebuild-spec.md` |
| Hub 처리(3-2) | `docs/spec/06-hub-node-management-spec.md` |
| 프로그레시브 렌더링(3-3) | `docs/spec/07-progressive-rendering-spec.md` |
| Domain-first(3-4) | `docs/spec/08-domain-first-navigation-spec.md` |
| 증분 추론(3-5) | `docs/spec/09-incremental-inference-spec.md` |
| AST 기본 경로 전환(2-1 Phase 1) | `docs/spec/10-ast-default-code-signal-spec.md` |
| AST+Regex 하이브리드 모드(2-1 확장) | `docs/spec/11-ast-regex-hybrid-code-signal-spec.md` |
| DOMAIN_SUMMARY | `docs/design/04-query-engine.md` §4 DOMAIN_SUMMARY |
| DB 추론 확장(3-6) | `docs/spec/01-db-inference-index-unique-spec.md` |
| 3D 렌더러 전환(3-7) | `docs/spec/02-object-mapping-3d-renderer-spec.md` |
| Domain-first | `docs/design/05-rollup-and-graph.md` §6 Navigation Strategy |
| **Inter-procedural AST(4-1)** | `docs/spec/17-inter-procedural-ast-spec.md` |
| **Cross-Signal Validation(4-2)** | `docs/spec/18-cross-signal-validation-spec.md` |
| **LLM 추론 부스터(4-3)** | `docs/spec/19-llm-inference-boost-spec.md` |
| **플러그인 시스템(4-4)** | `docs/spec/20-framework-plugin-system-spec.md` |
| **Delta Rollup(4-5)** | `docs/spec/21-realtime-rollup-spec.md` |
| **피드백 루프(4-6)** | `docs/spec/22-inference-feedback-loop-spec.md` |
| **피드백 키 세분화(4-6 후속)** | `docs/spec/36-relation-feedback-key-specialization-spec.md` |
| **Change Impact(5-1)** | `docs/spec/23-change-impact-preview-spec.md` |
| **Drift Detection(5-2)** | `docs/spec/24-architecture-drift-detection-spec.md` |
| **Journal(5-3)** | `docs/spec/25-personal-architecture-journal-spec.md` |
| **API Contract Diff(5-4)** | `docs/spec/26-api-contract-diff-spec.md` |
| **Health Score(5-5)** | `docs/spec/27-architecture-health-score-spec.md` |
| **추론 엔진 고도화(P4 전체)** | `docs/design/07-inference-engine-advanced.md` |
| **생산성 기능(P5 전체)** | `docs/design/08-developer-productivity.md` |
