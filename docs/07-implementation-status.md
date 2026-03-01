# Archi.Navi — 구현 현황 (v2)

> 최종 점검일: 2026-03-01  
> 기준: `apps/web`, `packages/core`, `packages/inference`, `packages/cli` 실코드

---

## 전체 요약

| 영역 | 상태 | 비고 |
|------|------|------|
| Architecture / Mapping UI | ✅ | 레이어드 아키텍처(Cytoscape), 매핑 뷰(D3 Force), rollup 기반 상위 엣지 반영 |
| Query Engine | ✅ | PATH/IMPACT/USAGE/DOMAIN_SUMMARY 구현, `generationVersion` 미지정 시 ACTIVE 자동 적용 |
| Rollup Engine | ✅ | 4단계 rollup + generation 관리 + seed 후 재빌드 |
| Relation 추론 파이프라인 | ⚠️ | `/api/inference/run`으로 config/code/db 실행 가능, 운영 오케스트레이션/증거 승격은 보강 필요 |
| Domain 추론 파이프라인 | ⚠️ | Track A/B 구현 및 승인 API 존재, 실행/운영 UX 고도화 여지 |
| AI Reasoning | ⚠️ | Evidence Assembler/Answer Composer 연동 완료, baseRelation provenance 강화 필요 |
| 문서-실행 예제 정합성 | ⚠️ | 2026-03-01 기준 주요 문서 정리 중, 일부 운영 가이드는 추가 동기화 필요 |

---

## 1) 완료된 핵심 항목

### 1.1 UI / API

- ✅ `Settings > 개발자 도구`
  - `POST /api/dev/seed`: 샘플 주입 + rollup 재빌드
  - `POST /api/dev/reset`: 워크스페이스 데이터 초기화(rollup 포함)
- ✅ `Approval > 관계 후보`
  - `POST /api/inference/run` 호출 버튼 제공
  - 실행 후 PENDING 후보 즉시 재조회
- ✅ `Approval > 도메인 후보`
  - `GET/PATCH /api/inference/domain-candidates*`로 승인/거부 처리

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

### 1.3 Inference

- ✅ Relation 추론(구현 존재)
  - Config 기반: `inferRelationsFromConfig`
  - Code Signal(Regex): `extractCodeSignals`
  - DB Signal: `extractDbSchemaSignals`
- ✅ Domain 추론
  - Track A(Seed-based): `runSeedBasedInference`
  - Track B(Discovery): `runDiscovery`
  - 도메인 후보 승인: `approveDomainCandidate`

### 1.4 AI

- ✅ Chat 스트리밍 API (`/api/chat`)
- ✅ Evidence Assembler / Answer Composer 연동
- ✅ LLM 후보 필터 API (`/api/inference/llm-filter`)

---

## 2) 부분 완료 / 남은 작업

### 2.1 Inference 운영 플로우

- ⚠️ `/api/inference/run`은 구현되었지만, 현재는 로컬 repo 경로(`repoRoots` 또는 `service.metadata.scanPath`) 의존
- ⚠️ 조직 단위/원격 소스까지 포함하는 운영 오케스트레이션은 보강 필요

### 2.2 Evidence-first 체인 강화

- ⚠️ 관계 후보 승인 시 evidence 승격(`relation_candidate_evidences -> relation_evidences`) 미구현
- ⚠️ rollup/query 응답의 `baseRelationIds` provenance 강화 필요

### 2.3 설정 반영

- ⚠️ Settings의 추론 가중치(localStorage)가 추론 실행 프로필(DB)과 직접 연결되지 않음

### 2.4 AST 고도화

- ⚠️ AST 분석 모듈은 존재하나 기본 파이프라인(`extractCodeSignals`)은 현재 Regex 중심

---

## 3) 참고: 현재 주요 실행 엔트리포인트

### 3.1 Web API

- `POST /api/scan`
- `POST /api/inference/run`
- `GET /api/inference/candidates`
- `PATCH /api/inference/candidates/:id`
- `GET /api/inference/domain-candidates`
- `PATCH /api/inference/domain-candidates/:id`
- `POST /api/inference/llm-filter`
- `POST /api/query`
- `POST /api/chat`

### 3.2 CLI

- `anavi scan --workspace <id> [--path|--workspace-dir|--github-repo|--github-org]`
- `anavi infer --workspace <id> [--track a|b|all]`
- `anavi rebuild-rollup --workspace <id> [--incremental]`
- `anavi export --workspace <id> --format <json|dot> --output <path>`
- `anavi snapshot <save|restore> ...`

