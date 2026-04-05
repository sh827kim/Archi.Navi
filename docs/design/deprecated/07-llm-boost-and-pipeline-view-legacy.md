# [Deprecated] LLM 추론 부스터 + 통합 파이프라인 뷰

> **상태: Deprecated (2026-04-05)**
> 이 문서는 `07-inference-engine-advanced.md`에서 분리된 레거시 설계다.
> - **섹션 4 (LLM 추론 부스터)**: Smart Proof Engine의 Category A/B로 대체됨 → [13-smart-proof-engine-escalation.md](../13-smart-proof-engine-escalation.md)
> - **섹션 7 (전체 파이프라인 통합 뷰)**: Intent-Centric Proof Engine 파이프라인으로 대체됨 → [12-intent-centric-proof-engine-adoption-plan.md](../12-intent-centric-proof-engine-adoption-plan.md)

---

## 대체 사유

### LLM 추론 부스터 → Smart Proof Engine

| 07 기능 | 13 대체 |
|---|---|
| 코드 의도 분석 (Pre-inference LLM) | Category A: Pre-Resolution Enhancement (function summary LLM 보강) |
| 관계 설명 자동 생성 | proof reasoning (Smart frontier resolution의 부산물) |
| 도메인 라벨 정제 | 범위 외 (domain은 proof engine 밖) |
| 비용 제어 (`llm_max_calls_per_run`) | SmartBudgetTracker (maxLlmCallsPerRun, maxTotalTokensPerRun 등) |

### 통합 파이프라인 뷰 → proof engine 실행 순서

07의 Signal→Feedback→Cross-validation→Candidate→LLM Filter 흐름은
12의 extraction→cache→intent→proof→frontier→agent→projection 흐름으로 대체되었다.

---

## (아래는 원본 내용)

## LLM 추론 부스터 (기존 LLM 필터 확장)

### 기존 vs 확장

| 구분 | 기존 (후보 필터링) | 확장 (추론 부스터) |
|------|-------------------|-------------------|
| 실행 시점 | 후보 생성 후 | 후보 생성 전/후 모두 |
| 역할 | 후보 타당성 판정 | 의도 분석 + 설명 생성 + 라벨 정제 |
| 입력 | 후보 + evidence | 코드 컨텍스트 + 후보 + 프로젝트 구조 |
| 출력 | accept/reject | 관계 설명, 도메인 라벨, 보완 후보 |

### LLM 부스터 기능 3가지

#### 코드 의도 분석 (Pre-inference LLM)

Regex/AST로 잡기 어려운 패턴을 LLM이 보완한다.

**대상 패턴:**
- 동적 URL 구성: `baseUrl + "/" + serviceName + "/api/orders"`
- 리플렉션 기반 호출
- 커스텀 HTTP 클라이언트 래퍼

**실행 방식:**
```
1. AST 분석에서 "미확정" 시그널 수집 (confidence < 0.5)
       ↓
2. 해당 파일의 관련 코드 컨텍스트 추출 (±30 lines)
       ↓
3. LLM 호출 → 보완 후보 생성
   - confidence: 0.5~0.7 (LLM 기반이므로 중간 수준)
   - metadata.source: "LLM_BOOST"
```

#### 관계 설명 자동 생성

각 relation_candidate에 "왜 이 관계가 존재하는가"를 자연어로 생성.

```
입력: subject, object, relationType, evidences
LLM 출력: "order-service는 주문 결제 시 payment-service의 charge API를 호출합니다."
저장: relation_candidates.metadata.llmExplanation
```

#### 도메인 라벨 정제

Track B Discovery의 label_candidates를 자연스러운 이름으로 변환.

```
입력: cluster members + label_candidates + table/topic prefixes
LLM 출력: { "suggestedName": "주문 관리", "suggestedEnglishName": "Order Management" }
저장: domain_discovery_memberships.metadata.llmLabel
```

### 배치 최적화

```
기존: 후보 1건씩 개별 LLM 호출
개선: 같은 subject 서비스의 후보들을 그룹화 → 맥락 포함 배치 호출
배치 크기: 5~10 후보/호출 (토큰 제한 고려)
```

### 비용 제어

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `llm_boost_enabled` | false | LLM 부스터 활성화 여부 |
| `llm_boost_threshold` | 0.5 | 이 confidence 미만 시그널만 LLM 분석 |
| `llm_explanation_enabled` | true | 관계 설명 생성 여부 |
| `llm_label_enabled` | true | 도메인 라벨 정제 여부 |
| `llm_max_calls_per_run` | 50 | 추론 1회당 최대 LLM 호출 수 |

---

## 전체 파이프라인 통합 뷰

```
┌─────────────────────────────────────────────────────────────┐
│                    Enhanced Pipeline                         │
│                                                             │
│  ① Signal Collection (기존 + 확장)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Code     │ │ Config   │ │ DB Schema│ │ LLM Boost    │   │
│  │ (Inter-  │ │ Signals  │ │ Signals  │ │ (미확정 시그널│   │
│  │ procedural)│          │ │          │ │  보완)       │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
│       │             │            │               │          │
│       ▼             ▼            ▼               ▼          │
│  ② Feedback Adjustment (relation/domain 분리)              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ relation/domain별 독립 feedback adjustment           │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ③ Cross-Signal Validation                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 동일 관계 그룹화 → 지지/모순 판정 → 신뢰도 재계산    │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ④ Candidate Generation + LLM Explanation                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ relation_candidates + 자연어 설명 + 교차 검증 정보    │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ⑤ LLM Candidate Filter (기존)                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 배치 그룹화 → 맥락 포함 평가 → accept/reject         │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ⑥ Approval + Feedback Loop                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 승인 UI → 확정 → rollup rebuild                       │   │
│  │       → relation/domain 분리 집계                     │   │
│  │       → 다음 run부터만 반영                           │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 관련 레거시 SPEC

- [../spec/19-llm-inference-boost-spec.md](../../spec/deprecated/19-llm-inference-boost-spec.md)
