# Archi.Navi — v2+ 로드맵

> 작성일: 2026-02-22 | 최종 갱신: 2026-03-22
> v1 구현 현황: `docs/02-implementation-status.md` 참고
> 추론 엔진 설계: `docs/design/03-inference-engine.md` v3.0, `docs/design/07-inference-engine-advanced.md` v1.0 참고

---

## 우선순위 정의

| 등급 | 의미 | 예상 시기 |
|------|------|----------|
| **P1** | 추론 파이프라인 MVP — 70%+ 자동화 달성 | v2.0 ✅ |
| **P2** | AST 정밀 추출 + AI 고도화 | v2.1 ✅ |
| **P3** | 대규모 그래프 성능 + 추론 고도화 | v2.2 ✅ |
| **P4** | 🔥 추론 엔진 고도화 — 90%+ 정밀도 달성 | v3.0 |
| **P5** | 개발자 생산성 기능 + 구조 개선 | v3.1+ |

---

## 현재 상태 요약 (2026-03-22)

| 구간 | 상태 | 비고 |
|------|------|------|
| P1 (1-1 ~ 1-6) | ✅ 완료 | 추론 MVP 기능/승인 플로우 구현 완료 |
| P2 (2-1) | ✅ 완료 | `hybrid/ast/regex` 모드, AST fallback, 요청/실사용 엔진 노출, 기본 UI 설정까지 반영 완료 |
| P2 (2-2 ~ 2-5) | ✅ 완료 | Evidence Assembler/Answer Composer/DOMAIN_SUMMARY/Message 시그널 반영 완료 |
| P2 (2-6) | ✅ 완료 | 비동기 run 생성/목록/상세, source 해석(local/githubRepo/githubOrg), 이벤트/상태 저장 완료 |
| P2 (2-7) | ✅ 완료 | endpoint/topic/queue/db_table 후보 생성과 database parent 보장까지 완료 |
| P3 (3-1 ~ 3-7) | ✅ 완료 | 증분 리빌드~3D 렌더러 전환까지 완료 |
| P4 (4-1 ~ 4-6) | ⚠️ In Progress | 4-2 Cross-Signal Validation 완료, 나머지 항목은 설계/구현 대기 |
| P5 (5-1 ~ 5-5) | 📋 Draft | 생산성 기능 설계 완료, 구현 대기 |

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

## P2: AST 정밀 추출 + AI 고도화 (v2.1)

> **목표**: AST로 추론 정밀도 85~95% 달성, Evidence 기반 AI Chat 고도화

### ✅ 2-1. AST Plugin (Tree-sitter) — Phase 2 (완료)
- **파일:** `packages/inference/src/code/ast/` (신규)
- **SPEC:** `docs/spec/11-ast-default-code-signal-spec.md`
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
- **SPEC:** `docs/spec/13-inference-run-orchestration-spec.md`
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
  - `docs/spec/14-code-based-relation-candidate-spec.md`
  - `docs/spec/15-compound-to-atomic-inference-spec.md`
  - `docs/spec/16-rabbitmq-queue-code-signal-spec.md` (RabbitMQ 우선)
  - `docs/spec/17-db-table-code-signal-spec.md` (db_table은 database 소속 필수)
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
- **SPEC:** `docs/spec/06-incremental-rollup-rebuild-spec.md`
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
- **SPEC:** `docs/spec/07-hub-node-management-spec.md`
- **기준:** `object_graph_stats.inDegree >= threshold` (기본 50, 설정에서 조정 가능)
- **구현 완료:**
  - Mapping 그래프 우상단 `Hub 접기/펼치기` 토글
  - Hub 노드에 in-degree 카운트 배지 표시
  - `/api/rollups` 응답에 `graphStats` 포함하여 UI 판정에 활용

### ✅ 3-3. 프로그레시브 렌더링 (완료)
- **SPEC:** `docs/spec/08-progressive-rendering-spec.md`
- **파일:** `apps/web/src/components/mapping/rollup-graph.tsx`
- **구현 완료:**
  - 2000+ 엣지에서 `requestAnimationFrame` 기반 점진 렌더링 자동 활성화
  - 200 엣지/배치로 렌더링하며 진행 상태(`edge rendered/total`) 표시
  - 소규모 그래프는 기존 즉시 렌더링 경로 유지

### ✅ 3-4. Domain-first 내비게이션 (완료)
- **SPEC:** `docs/spec/09-domain-first-navigation-spec.md`
- **구현 완료:**
  - 기본 진입 레벨을 `DOMAIN_TO_DOMAIN`으로 전환 (도메인 데이터 없으면 `SERVICE_TO_SERVICE` fallback)
  - `DOMAIN_TO_DOMAIN`에서 도메인 클릭 시 `SERVICE_TO_SERVICE` 자동 전환
  - `SERVICE_TO_SERVICE`에서 서비스 클릭 시 Atomic(Roll-down) 자동 전환
  - 브레드크럼 내비게이션 + `상위로` 버튼으로 단계 복귀
  - `object_domain_affinities` 기반 도메인별 서비스 필터링 적용

### ✅ 3-5. 증분 추론 (완료)
- **SPEC:** `docs/spec/10-incremental-inference-spec.md`
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

## 🔥 P4: 추론 엔진 고도화 (v3.0)

> **목표**: 추론 정밀도 90~95% 달성 + 노이즈 50% 이상 감소
> **설계 문서**: `docs/design/07-inference-engine-advanced.md`
> **우선순위**: P2 완료 기반 위에서 가장 먼저 착수할 고도화 영역 — 추론 품질이 전체 시스템 가치를 결정

### 📋 4-1. Inter-procedural AST 분석 (기존 2-1 확장)
- **SPEC:** `docs/spec/18-inter-procedural-ast-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §2
- **핵심:**
  - Multi-file Symbol Table 구축 (클래스/인터페이스/메서드 계보)
  - Call Chain Resolution — 메서드 호출 체인 추적 (최대 depth 3)
  - Spring 프로퍼티 전파 (`@Value` → application.yml 연결 → URL 확정)
  - 인터페이스 → 구현체 매핑 (FeignClient 등)
- **기대 효과:**
  - 현재 미감지 패턴 (간접 호출, 프로퍼티 주입 URL) 커버
  - 기존 AST 분석의 confidence 추가 상향 (+0.05~0.1)
- **의존:** 기존 2-1(AST hybrid) 완료 기반

### ✅ 4-2. Cross-Signal Validation (교차 검증)
- **SPEC:** `docs/spec/19-cross-signal-validation-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §3
- **핵심:**
  - config + code + db 시그널 간 교차 검증
  - 복수 시그널 지지 시 신뢰도 부스트 (Bayesian 업데이트)
  - 모순 감지 (Stale Config, Phantom Call, Dead Topic, Orphan FK)
  - 승인 UI에 교차 검증 배지 표시
- **기대 효과:**
  - 동일 관계 2+ 소스 지지 시 confidence 0.08~0.12 부스트
  - stale config/phantom call 등 노이즈 후보 사전 경고
- **의존:** 추론 실행 시 2+ 모드 동시 실행

### 📋 4-3. LLM 추론 부스터 (기존 LLM 필터 확장)
- **SPEC:** `docs/spec/20-llm-inference-boost-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §4
- **기존 참조:** `docs/spec/04-llm-inference-filtering-spec.md` (post-filter, 구현 완료)
- **핵심:**
  - 코드 의도 분석 (Pre-inference): 동적 URL, 리플렉션 등 미확정 시그널 보완
  - 관계 설명 자동 생성: 각 후보에 "왜 이 관계가 존재하는가" 자연어 생성
  - 도메인 라벨 정제: Track B Discovery의 label_candidates를 자연스러운 이름으로 변환
  - 배치 그룹화 최적화 + 비용 제어 파라미터
- **기대 효과:**
  - Regex/AST 미감지 패턴 5~10% 추가 발견
  - 승인 판단 시간 단축 (설명 제공)
  - 도메인 이름 품질 향상

### 📋 4-4. 프레임워크 플러그인 시스템
- **SPEC:** `docs/spec/21-framework-plugin-system-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §5
- **핵심:**
  - FrameworkPlugin 인터페이스 (regexPatterns, astExtractor, configParsers, detector)
  - PluginRegistry (등록, 자동 감지, 조회)
  - 기존 하드코딩 패턴을 빌트인 플러그인으로 마이그레이션
  - 프로젝트별 자동 플러그인 선택
- **기대 효과:**
  - gRPC, GraphQL, tRPC, Quarkus 등 새 프레임워크 지원 용이
  - 오픈소스 커뮤니티 기여 진입 장벽 대폭 감소

### 📋 4-5. Delta Rollup + 실시간 그래프 갱신
- **SPEC:** `docs/spec/22-realtime-rollup-spec.md`
- **핵심:**
  - 관계 승인/삭제 시 해당 rollup 엣지만 delta update (full rebuild 없이)
  - WebSocket으로 프론트엔드에 그래프 변경 push
  - 일괄 승인 시 배치 delta 처리
- **기대 효과:**
  - 대규모 코드베이스에서 수백 건 일괄 승인 시 성능 향상
  - 실시간 시각적 피드백

### 📋 4-6. 추론 피드백 루프
- **SPEC:** `docs/spec/23-inference-feedback-loop-spec.md`
- **설계:** `docs/design/07-inference-engine-advanced.md` §6
- **핵심:**
  - 승인/거절 패턴을 시그널 유형별로 집계
  - 기본 신뢰도 자동 보정 (최소 10건 이상 축적 시)
  - domain_inference_profiles에 피드백 데이터 저장
- **기대 효과:**
  - 사용할수록 노이즈 감소 (반복 거절 패턴 학습)
  - 워크스페이스별 맞춤 신뢰도 프로필 자동 형성

---

## P5: 개발자 생산성 기능 + 구조 개선 (v3.1+)

> **목표**: 추론 엔진의 아키텍처 지식을 일상 개발 워크플로우에 직접 연결
> **설계 문서**: `docs/design/08-developer-productivity.md`

### 📋 5-1. Change Impact Preview (변경 영향도 미리보기)
- **SPEC:** `docs/spec/24-change-impact-preview-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §2
- **핵심:**
  - `git diff` → 변경 파일 → code_artifacts 매핑 → 영향받는 서비스/API/토픽 식별
  - CLI: `anavi impact --workspace <id> --diff HEAD~1`
  - Query Engine IMPACT_ANALYSIS 연동
- **기대 효과:** PR 리뷰 시 변경 영향도 즉시 파악

### 📋 5-2. Architecture Drift Detection (드리프트 감지)
- **SPEC:** `docs/spec/25-architecture-drift-detection-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §3
- **핵심:**
  - rollup generation 간 diff → 새 의존성/소멸/순환 의존 감지
  - 심각도 판정 (INFO/WARNING/CRITICAL)
  - CLI: `anavi drift --workspace <id>`
- **기대 효과:** 아키텍처 변화를 능동적으로 감지

### 📋 5-3. Personal Architecture Journal (개인 아키텍처 저널)
- **SPEC:** `docs/spec/26-personal-architecture-journal-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §5
- **핵심:**
  - 서비스/관계에 개인 메모/태그 연결 (warning, tip, todo, context, decision)
  - Object Mapping 그래프에 메모 아이콘 표시
  - export/import 지원
- **기대 효과:** 암묵지 체계화 → 온보딩 자료 자동 축적

### 📋 5-4. API Contract Diff (API 계약 변경 감지)
- **SPEC:** `docs/spec/27-api-contract-diff-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §6
- **핵심:**
  - expose 시그널 버전별 비교 → 엔드포인트 추가/삭제/변경 감지
  - 삭제된 endpoint의 caller 자동 경고
- **기대 효과:** API 호환성 파괴 사전 감지

### 📋 5-5. Architecture Health Score (아키텍처 건강도)
- **SPEC:** `docs/spec/28-architecture-health-score-spec.md`
- **설계:** `docs/design/08-developer-productivity.md` §4
- **핵심:**
  - 6개 지표 (결합도, 도메인 순수도, 순환 의존, Hub 집중도, Evidence 커버리지, Approval 비율)
  - 서비스별/워크스페이스별 점수 산출 + 등급 판정
  - CLI: `anavi health --workspace <id>`
- **기대 효과:** 아키텍처 품질 수치화 + 개선 방향 제시

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
P2 완료 기반                   P4 고도화 (★ 최우선)
──────────────────────────────────────────────────
2-1 AST/hybrid 운영 완료 ──→ 4-1 Inter-procedural AST
2-6 비동기 run 오케스트레이션 → 4-6 피드백 루프
2-7 Atomic 후보 생성 완료 ─→ 4-2 Cross-Signal Validation
                              4-3 LLM 추론 부스터
                              4-4 플러그인 시스템
                              4-5 Delta Rollup
                              ─────────────────────
                              P5 생산성 기능
                              5-1 Change Impact
                              5-2 Drift Detection
                              5-5 Health Score
                              5-3 Journal
                              5-4 API Contract Diff
                              5-6 구조 개선
```

> **핵심**: P2는 완료되었고, 이제 4-1 → 4-2 → 4-3이 추론 품질을 구조적으로 끌어올리는 핵심 3요소다.
> 특히 4-1은 현재 AST/hybrid 기반 위에 추가되는 다음 단계 고도화다.

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
| 증분 리빌드(3-1) | `docs/spec/06-incremental-rollup-rebuild-spec.md` |
| Hub 처리(3-2) | `docs/spec/07-hub-node-management-spec.md` |
| 프로그레시브 렌더링(3-3) | `docs/spec/08-progressive-rendering-spec.md` |
| Domain-first(3-4) | `docs/spec/09-domain-first-navigation-spec.md` |
| 증분 추론(3-5) | `docs/spec/10-incremental-inference-spec.md` |
| AST 기본 경로 전환(2-1 Phase 1) | `docs/spec/11-ast-default-code-signal-spec.md` |
| AST+Regex 하이브리드 모드(2-1 확장) | `docs/spec/12-ast-regex-hybrid-code-signal-spec.md` |
| DOMAIN_SUMMARY | `docs/design/04-query-engine.md` §4 DOMAIN_SUMMARY |
| DB 추론 확장(3-6) | `docs/spec/01-db-inference-index-unique-spec.md` |
| 3D 렌더러 전환(3-7) | `docs/spec/02-object-mapping-3d-renderer-spec.md` |
| Domain-first | `docs/design/05-rollup-and-graph.md` §6 Navigation Strategy |
| **Inter-procedural AST(4-1)** | `docs/spec/18-inter-procedural-ast-spec.md` |
| **Cross-Signal Validation(4-2)** | `docs/spec/19-cross-signal-validation-spec.md` |
| **LLM 추론 부스터(4-3)** | `docs/spec/20-llm-inference-boost-spec.md` |
| **플러그인 시스템(4-4)** | `docs/spec/21-framework-plugin-system-spec.md` |
| **Delta Rollup(4-5)** | `docs/spec/22-realtime-rollup-spec.md` |
| **피드백 루프(4-6)** | `docs/spec/23-inference-feedback-loop-spec.md` |
| **Change Impact(5-1)** | `docs/spec/24-change-impact-preview-spec.md` |
| **Drift Detection(5-2)** | `docs/spec/25-architecture-drift-detection-spec.md` |
| **Journal(5-3)** | `docs/spec/26-personal-architecture-journal-spec.md` |
| **API Contract Diff(5-4)** | `docs/spec/27-api-contract-diff-spec.md` |
| **Health Score(5-5)** | `docs/spec/28-architecture-health-score-spec.md` |
| **추론 엔진 고도화(P4 전체)** | `docs/design/07-inference-engine-advanced.md` |
| **생산성 기능(P5 전체)** | `docs/design/08-developer-productivity.md` |
