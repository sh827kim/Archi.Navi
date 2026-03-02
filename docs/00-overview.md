# Archi.Navi — 프로젝트 개요

작성일: 2026-02-22
문서 버전: v2.0

---

## 1. 제품 개요

Archi.Navi는 분산 서비스 환경의 구조 지식을 **수집/추론/승인/시각화**하는 **Local-first 아키텍처 내비게이션 도구**다.

### 핵심 목표

1. 배포된 서비스와 객체(Object) 간 관계를 **신뢰 가능한 방식**으로 관리한다.
2. 사람이 이해 가능한 **구조 뷰(Roll-up)**와 **상세 뷰(Roll-down)**를 함께 제공한다.
3. 모든 자동 추론 결과를 **승인 기반**으로 반영해 운영 신뢰도를 확보한다.

---

## 2. 문제 정의

MSA/멀티 레포 환경에서는 아래 문제가 반복된다.

- 서비스 간 의존 관계를 정확히 모른다.
- 메시지/DB/API 경로가 문서와 실제가 다르다.
- 영향도 분석이 사람 기억과 경험에 의존한다.
- 지식이 흩어져 온보딩과 변경 검토 비용이 높다.

---

## 3. 제품 원칙

| # | 원칙 | 설명 |
|---|------|------|
| 1 | **단일 Object 모델** | 모든 자산은 `Object`로 통합 관리한다 |
| 2 | **승인 우선** | 추론 결과는 승인 전 반영하지 않는다 |
| 3 | **탐색 이중화** | 기본은 Roll-up, 필요 시 Roll-down |
| 4 | **근거 중심** | UI와 AI 응답 모두 Evidence 기반으로 제공한다 |
| 5 | **로컬 우선** | 개발자 개인 로컬 사용을 기본 전제로 시작한다 |
| 6 | **기존 UX 유지** | Architecture View, Service List, Tag, Visibility는 Object 모델에 통합해 유지한다 |

---

## 4. 사용자 및 시나리오

### 4.1 1차 사용자

- 백엔드/플랫폼 엔지니어
- 아키텍트/테크리드
- 신규 온보딩 개발자

### 4.2 핵심 시나리오

| 시나리오 | 설명 |
|----------|------|
| **영향도 분석** | 특정 서비스 변경 시 영향 범위를 확인한다 |
| **사용 주체 추적** | 특정 topic/db_table/api_endpoint의 사용 주체를 추적한다 |
| **추론 결과 검토** | 자동 추론된 관계를 검토하고 일괄 승인/반려한다 |
| **AI Chat 질의** | 구조 질의를 하고 근거 링크를 따라 확인한다 |

---

## 5. v1 범위 정의

### 5.1 In Scope

1. 서비스 의존 관계 추적/시각화
2. 서비스 도메인 추론/시각화 (Language-agnostic + AST 보강)
3. DB 스키마 기반 엔티티/도메인 추론 및 관계 시각화
4. Object Mapping View 단일 화면 (drill-down/roll-down)
5. Architecture View (roll-up preset) 유지
6. Service List + CSV Export 유지
7. Tag + Visibility (`VISIBLE/HIDDEN`) 유지
8. 지식 편집 UI (수동 오버라이드)
9. AI Chat 질의 (Evidence 필수)
10. 멀티 워크스페이스 확장 가능한 데이터 모델

### 5.2 Out of Scope (v1)

- 중앙 멀티유저 협업/권한 시스템
- 런타임 tracing 기반 실시간 자동 의존성 확정
- 완전 자동 반영(무승인) 운영 모드

---

## 6. 기능 요구사항 요약

### 6.1 의존성 추적/시각화

- Roll-up 그래프를 기본 뷰로 제공
- Roll-down은 특정 Object 선택 시 상세 표시
- 성능 목표: Roll-up 기준 **2,000 edges** 탐색 가능
- 롤업 방식: **저장형(Materialized Roll-up)**

### 6.2 기존 UX 통합 유지

- **Architecture View**: Object 모델의 Roll-up preset으로 유지
- **Service List**: `object_type=service` projection으로 유지
- **CSV Export**: Service List 기준으로 유지
- **Tag/Visibility**: 기존 방식과 유사하게 유지

### 6.3 추론 및 승인

- 추론 결과는 모두 **승인 큐**로 적재
- 승인 전 반영 금지
- 승인 UX: 전체 선택 / 부분 선택 해제 / 일괄 승인·반려

### 6.4 도메인 추론

- Affinity 분포 기반 (primary + secondary)
- **Track A**: Seed 기반 Named Domain
- **Track B**: Seed-less Discovery (레거시 부트스트랩)
- AST는 선택 플러그인 (1차: Java/Kotlin, TypeScript/JS, Python)

### 6.5 DB 추론/ERD

- FK + 컬럼명 유사도 + 식별자 접미사 패턴 + 조인 패턴 활용
- 기본 접미사: `*_id`, `*_no`, `*_uid`, `*_key`, `*_code`, `*id`, `*no`, `*uid`
- 기본 제외: `created_by`, `updated_by`, `deleted_by`, `created_at`, `updated_at`
- ERD는 선택 Object 기반 Roll-down 표시를 기본으로 사용

### 6.6 Object Mapping View

- Kafka 전용 화면 없음
- Object Mapping 단일 화면에서 타입 필터 + drill-down/roll-down으로 탐색

### 6.7 지식 편집

- 편집 허용: `display_name`, `parent_id`, `metadata`, `relation_type`, `visibility`, 태그, 수동 관계 추가/삭제
- 우선순위: **수동 오버라이드 > 자동 추론**
- 변경 이력: 객체/관계 단위 **append-only** 로그

### 6.8 AI Chat

- 응답 형식: 결론 + Evidence + Confidence + Deep-link
- Evidence 없는 확정형 답변 금지
- 1차 질의 유형: 영향도 분석, 경로 탐색, 객체 사용 주체, 도메인 요약

### 6.9 멀티 워크스페이스

- 데이터 격리: 단일 DB + `workspace_id`
- UX 방향: Slack 스타일 workspace switch
- v1 운영 전제: 개발자 개인 로컬 사용

---

## 7. 비기능 요구사항

| 항목 | 목표 |
|------|------|
| **데이터 신뢰성** | 승인 전 반영 금지 원칙 준수 |
| **성능** | Roll-up 2,000 edges에서 탐색 가능한 응답성 유지 |
| **추적성** | 관계 생성 근거(Evidence) 저장 |
| **확장성** | Object type/Relation type 추가 시 기존 뷰 재사용 가능 |

---

## 8. 성공 지표

| 지표 | 설명 |
|------|------|
| 승인 처리 리드타임 | 추론 후보 생성 후 승인 완료까지 소요 시간 |
| 구조 질의 해결 시간 | 영향도/경로 질의 평균 해결 시간 |
| 탐색 품질 | 잘못된 관계 신고율 (오탐 비율) |
| 사용성 | 핵심 플로우(탐색/승인/질의) 완료율 |

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [01-architecture.md](./design/01-architecture.md) | 시스템 아키텍처, 기술스택, 배포 전략 |
| [02-data-model.md](./design/02-data-model.md) | Object/Relation 모델, DB 스키마 |
| [03-inference-engine.md](./design/03-inference-engine.md) | Relation/Domain 추론 엔진 |
| [04-query-engine.md](./design/04-query-engine.md) | Deterministic Query Engine + AI 레이어 |
| [05-rollup-and-graph.md](./design/05-rollup-and-graph.md) | Roll-up 전략, 그래프 성능 |
| [docs/README.md](./README.md) | 문서 분류 기준(Design / SPEC / Guide) |
| [docs/spec/README.md](./spec/README.md) | 기능별 SPEC 인덱스 |
| [01-development-guide.md](./01-development-guide.md) | 개발 가이드, CLI, 컨벤션 |
| [05-npm-distribution.md](./05-npm-distribution.md) | npm 배포/설치 절차, `anavi up` 실행 가이드 |
