# Archi.Navi 보강 제안서

작성일: 2026-02-21 문서 버전: v1.0

------------------------------------------------------------------------

## 1. 문서 목적

본 문서는 Archi.Navi PRD 및 Object SPEC을 기반으로 한 구조적 보강
제안서이다. 기존 설계의 강점을 유지하면서 확장성, 성능, 추론 정확도,
장기 진화 가능성을 강화하는 것을 목표로 한다.

------------------------------------------------------------------------

# 2. Relation 모델 고도화 제안

## 2.1 Semantic Axis 분리

Relation Type에 다음과 같은 의미 축을 추가한다.

-   interaction_kind: CONTROL \| DATA \| ASYNC \| STATIC
-   direction: IN \| OUT

예:

  relation   interaction_kind   direction
  ---------- ------------------ -----------
  call       CONTROL            OUT
  read       DATA               IN
  write      DATA               OUT
  produce    ASYNC              OUT
  consume    ASYNC              IN

### 기대 효과

-   새로운 relation type 추가 시 확장 용이
-   UI 필터링 단순화
-   AI reasoning 단순화
-   Roll-up 계산 구조 단순화

------------------------------------------------------------------------

# 3. Roll-up 저장 전략 보강

## 3.1 Incremental Rebuild 전략

Materialized Roll-up은 다음 이벤트에서 재계산된다.

-   relation 승인
-   relation 삭제
-   object parent 변경

### 전략

1.  승인/삭제 시 영향받는 상위 노드만 부분 재계산
2.  CLI를 통한 전체 재빌드 기능 제공
3.  rollup_generation_version 필드 도입

------------------------------------------------------------------------

# 4. Object URN 확장 제안

기존: urn:{org}:{category}:{type}:{name}

제안: urn:{workspace}:{category}:{type}:{normalized_path}

예: urn:team-a:compute:service:order-service
urn:team-a:storage:table:customer-db.customer

### 기대 효과

-   rename 대응
-   merge 대응
-   federation 확장 가능

------------------------------------------------------------------------

# 5. Domain 추론 고도화

## 5.1 Domain 메타데이터 확장

-   primary_domain
-   secondary_domains
-   domain_confidence
-   domain_source (AST \| heuristic \| manual)

## 5.2 Domain을 Object로 승격

type=domain object 추가 가능 service -\> domain 관계 모델링 가능

### 기대 효과

-   Domain 중심 Roll-up
-   Bounded Context 시각화
-   Domain violation 탐지 가능

------------------------------------------------------------------------

# 6. AI Chat 고도화 제안

## 6.1 Reasoning Graph 노출

AI가 탐색한 경로를 시각적으로 노출

예: A -\> call -\> B -\> write -\> table C

## 6.2 Query Type Enum 정의

-   IMPACT_ANALYSIS
-   PATH_DISCOVERY
-   USAGE_DISCOVERY
-   DOMAIN_SUMMARY

### 기대 효과

-   Deterministic Query Engine 확장 가능
-   LLM 제거 전략 가능
-   Explainable AI 구조 확보

------------------------------------------------------------------------

# 7. Temporal Architecture 제안

object 및 relation에 다음 필드 추가:

-   valid_from
-   valid_to

### 기대 효과

-   특정 시점 구조 재현
-   릴리즈 기준 비교
-   구조 변화 이력 분석 가능

------------------------------------------------------------------------

# 8. 승인 워크플로우 고도화

-   그룹 기반 승인
-   confidence threshold 기반 자동 승인 옵션

------------------------------------------------------------------------

# 9. Relation Metadata 확장

relation에 metadata(JSON) 필드 추가

예: - protocol - http_method - status_code - join_type

------------------------------------------------------------------------

# 10. DB 추론 강화

추가 분석 대상:

-   인덱스 패턴
-   unique constraint
-   MyBatis XML 분석
-   JPA mapping 분석

------------------------------------------------------------------------

# 11. CLI 확장 전략

-   anavi scan
-   anavi infer
-   anavi rebuild-rollup
-   anavi export
-   anavi snapshot

------------------------------------------------------------------------

# 12. 대규모 그래프 대응 전략

-   roll-up 기본 표시
-   edge weight 표현
-   degree threshold 필터
-   granularity_level 도입

------------------------------------------------------------------------

# 13. 전략적 방향성

Archi.Navi는 단순 시각화 도구가 아니라:

Local-first Architecture Knowledge Graph + Deterministic Reasoning
Engine

으로 진화 가능하다.

------------------------------------------------------------------------

# 14. 다음 단계

1.  데이터베이스 스키마 정밀 설계
2.  Roll-up 계산 알고리즘 설계
3.  Deterministic Query Engine 설계
4.  AI Reasoning 레이어 설계
5.  Domain Inference 고도화 설계
6.  대규모 그래프 성능 전략
