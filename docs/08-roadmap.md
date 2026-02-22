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

### 1-4. Domain Candidates 승인 API + UI
- **API:** `GET/PATCH /api/inference/domain-candidates`
- **현재:** 라우트 미존재 (Relation 승인만 있음)
- **구현:** domain_candidates 조회/승인/거부 → object_domain_affinities 확정
- **참조:** 03-inference-engine.md §8.2

### 1-5. Discovery 다중 레이어 통합
- **파일:** `packages/inference/src/domain/discovery.ts`
- **현재:** SERVICE_TO_SERVICE call 엣지만 사용
- **구현:**
  - SERVICE_TO_DB, SERVICE_TO_BROKER rollup을 그래프에 추가
  - `domain_inference_profiles`의 엣지 가중치 (`edge_w_rw`, `edge_w_msg` 등) 적용
  - `enabled_layers` 프로필 설정 반영
- **참조:** 03-inference-engine.md §4.2

### 1-6. 클러스터 Label 자동 추출
- **파일:** `packages/inference/src/domain/discovery.ts`
- **현재:** `labelCandidates: []` 하드코딩
- **구현:** 서비스명/테이블 prefix/Topic prefix 토큰 빈도 → 상위 3개 후보
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

### 2-4. DOMAIN_SUMMARY 쿼리 완성
- **파일:** `packages/core/src/query-engine/executor.ts`
- **현재:** stub 반환
- **구현:** deterministic 집계 + LLM 포맷팅 (도메인별 서비스 수, 관계 밀도, purity 통계)

### 2-5. Message 시그널 추출
- **파일:** `packages/inference/src/domain/seedBased.ts`
- **현재:** msgScore=0 하드코딩
- **구현:** 토픽 네이밍 패턴 분석 → producer/consumer 결합도 → 도메인 affinity

---

## P3: 대규모 그래프 성능 + 추론 고도화 (v2.2+)

### 3-1. 증분 리빌드
- **파일:** `packages/core/src/rollup/builder.ts`
- **현재:** 전체 rebuild (모든 level 재계산)
- **목표:** 변경 영향 범위만 부분 재계산
- **트리거:** 관계 승인/삭제, 부모 변경, expose 변경

### 3-2. Hub 처리 UI
- **기준:** object_graph_stats.inDegree > threshold (기본 200)
- **UI:** Hub 노드 접기/펼치기, 카운트 배지 표시
- **의존:** object_graph_stats 활용 (이미 계산됨)

### 3-3. 프로그레시브 렌더링
- **파일:** `apps/web/src/components/mapping/rollup-graph.tsx`
- **현재:** 전체 엣지 한번에 렌더
- **목표:** 200 엣지/배치 → requestAnimationFrame으로 분할
- **기준:** 2000+ 엣지에서 UI 버벅임 방지

### 3-4. Domain-first 내비게이션
- **현재:** 뷰 레벨 필터는 있으나 drill-down 순서 미강제
- **목표:** DOMAIN_TO_DOMAIN → 클릭 → SERVICE_TO_SERVICE → 클릭 → Atomic 자동 전환
- **UI:** 브레드크럼 내비게이션 + "상위로" 버튼

### 3-5. 증분 추론
- **현재:** 전체 파일 재스캔
- **목표:** SHA256 해시 비교 → 변경된 파일만 재분석, 기존 결과 유지

### 3-6. DB 추론 확장
- **인덱스 패턴:** 복합 인덱스에 포함된 컬럼 → 조인 관계 힌트
- **Unique 제약조건:** 유니크 키 패턴 → 엔티티 식별 관계

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
