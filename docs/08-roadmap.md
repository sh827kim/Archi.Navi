# Archi.Navi — v2+ 로드맵

> 작성일: 2026-02-22
> v1 구현 현황: `docs/07-implementation-status.md` 참고
> 추론 엔진 설계: `docs/03-inference-engine.md` v3.0 참고

---

## 우선순위 정의

| 등급 | 의미 | 예상 시기 |
|------|------|----------|
| **P1** | 추론 파이프라인 MVP — 70%+ 자동화 달성 | v2.0 |
| **P2** | AST 정밀 추출 + AI 고도화 | v2.1 |
| **P3** | 대규모 그래프 성능 + 추론 고도화 | v2.2+ |

---

## P1: 추론 파이프라인 MVP (v2.0)

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

### 2-1. AST Plugin (Tree-sitter) — Phase 2
- **파일:** `packages/inference/src/code/ast/` (신규)
- **언어:** Java/Kotlin, TypeScript/JavaScript, Python
- **Phase 1 대비 개선:**
  - 변수/상수로 지정된 URL 추적 (data-flow analysis)
  - 간접 호출 감지 (인터페이스 구현체 매핑)
  - 멀티라인 패턴 정확 추출
  - 같은 패턴도 confidence +0.1~0.2 상향
- **출력:** Phase 1과 동일 형식 (`code_artifacts`, `code_call_edges`, `code_import_edges`)
- **의존:** tree-sitter 바인딩 + 언어별 grammar
- **참조:** 03-inference-engine.md §6.2

### 2-2. Evidence Assembler
- **파일:** `packages/core/src/ai/evidence-assembler.ts` (신규)
- **기능:**
  - 쿼리 결과 → 증거 체인 구조화 (max 10개)
  - confidence × weight × hop 거리 기준 우선순위
  - 파일 경로 + 라인 + excerpt 포함
- **연동:** Chat API에서 queryContext 대신 evidence chain 주입

### 2-3. Answer Composer 템플릿
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

---

## P3: 대규모 그래프 성능 + 추론 고도화 (v2.2+)

### 3-1. 증분 리빌드
- **파일:** `packages/core/src/rollup/builder.ts`
- **현재:** 전체 rebuild (모든 level 재계산)
- **목표:** 변경 영향 범위만 부분 재계산
- **트리거:** 관계 승인/삭제, 부모 변경, expose 변경

### ✅ 3-2. Hub 처리 UI (완료)
- **기준:** `object_graph_stats.inDegree >= threshold` (기본 50, 설정에서 조정 가능)
- **구현 완료:**
  - Mapping 그래프 우상단 `Hub 접기/펼치기` 토글
  - Hub 노드에 in-degree 카운트 배지 표시
  - `/api/rollups` 응답에 `graphStats` 포함하여 UI 판정에 활용

### ✅ 3-3. 프로그레시브 렌더링 (완료)
- **파일:** `apps/web/src/components/mapping/rollup-graph.tsx`
- **구현 완료:**
  - 2000+ 엣지에서 `requestAnimationFrame` 기반 점진 렌더링 자동 활성화
  - 200 엣지/배치로 렌더링하며 진행 상태(`edge rendered/total`) 표시
  - 소규모 그래프는 기존 즉시 렌더링 경로 유지

### ✅ 3-4. Domain-first 내비게이션 (완료)
- **구현 완료:**
  - 기본 진입 레벨을 `DOMAIN_TO_DOMAIN`으로 전환 (도메인 데이터 없으면 `SERVICE_TO_SERVICE` fallback)
  - `DOMAIN_TO_DOMAIN`에서 도메인 클릭 시 `SERVICE_TO_SERVICE` 자동 전환
  - `SERVICE_TO_SERVICE`에서 서비스 클릭 시 Atomic(Roll-down) 자동 전환
  - 브레드크럼 내비게이션 + `상위로` 버튼으로 단계 복귀
  - `object_domain_affinities` 기반 도메인별 서비스 필터링 적용

### ✅ 3-5. 증분 추론 (완료)
- **구현 완료:**
  - Config 추론 경로(`inferRelationsFromConfig`)에 SHA256 기반 파일 변경 감지 적용
  - 변경 없는 설정 파일은 파싱/추론을 건너뛰고 기존 결과를 유지
  - 변경된 설정 파일만 재처리 후 해시 갱신
  - DB 스키마 추론 경로(`extractDbSchemaSignals`)에 db_table 메타 해시 기반 증분 처리 적용
  - 변경된 테이블만 재처리하고, 해당 테이블의 기존 `PENDING fk_reference` 후보를 갱신
  - `/api/inference/run`에서 `incremental` 옵션으로 config/db 증분 추론 동시 제어
  - `/api/inference/run` 응답에 config 스캔 통계(`fileCount`, `processedFileCount`, `skippedFileCount`) 노출

### 3-6. DB 추론 확장
- **인덱스 패턴:** 복합 인덱스에 포함된 컬럼 → 조인 관계 힌트
- **Unique 제약조건:** 유니크 키 패턴 → 엔티티 식별 관계

### 3-7. Object Mapping 3D 렌더러 전환
- **목표 라이브러리:** `3d-force-graph`
- **목표:**
  - 대규모 그래프 탐색성 개선(회전/줌/깊이 분리)
  - 기존 핵심 기능(레벨 전환, Roll-down, 허브 토글) 동등성 유지
- **전환 전략:**
  - 데이터 어댑터 분리 후 2D(D3)/3D 병행 제공
  - feature flag 또는 뷰 토글로 점진 전환
- **참조:** `local-only-docs/plans/2026-03-01-object-mapping-3d-force-graph-plan.md`

---

## 참고 설계 문서

| 로드맵 항목 | 참조 문서 |
|------------|----------|
| Config 기반 추론 | `docs/03-inference-engine.md` §7 Config 파싱 전략 |
| Regex Code Signal | `docs/03-inference-engine.md` §6.1 Phase 1 |
| AST Plugin | `docs/03-inference-engine.md` §6.2 Phase 2 |
| DB 시그널 | `docs/03-inference-engine.md` §5 DB 스키마 신호 추출 |
| Domain 승인 API | `docs/03-inference-engine.md` §8.2 Domain 승인 |
| Discovery 멀티 레이어 | `docs/03-inference-engine.md` §4.2 |
| Evidence Assembler | `docs/archive/ArchiNavi_AI_Reasoning_레이어_설계안_v1.md` §3 |
| Answer Composer | `docs/archive/ArchiNavi_AI_Reasoning_레이어_설계안_v1.md` §4 |
| DOMAIN_SUMMARY | `docs/04-query-engine.md` §4 DOMAIN_SUMMARY |
| 증분 리빌드 | `docs/05-rollup-and-graph.md` §4 Incremental Rebuild |
| Hub 처리 | `docs/archive/ArchiNavi_대규모_그래프_성능_전략_v1.md` §2 |
| 프로그레시브 렌더링 | `docs/archive/ArchiNavi_대규모_그래프_성능_전략_v1.md` §5 |
| Domain-first | `docs/05-rollup-and-graph.md` §6 Navigation Strategy |
