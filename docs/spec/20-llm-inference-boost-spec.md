# 20. LLM 추론 부스터 (SPEC) (Roadmap 4-3)

상태: Draft
작성일: 2026-03-08

> 기존 LLM 후보 필터(`docs/spec/04-llm-inference-filtering-spec.md`)의 확장.

## 1. 목적

LLM을 **추론 보완(pre-inference) + 관계 설명 생성 + 도메인 라벨 정제**에 활용하여,
Regex/AST로 잡기 어려운 패턴을 보완하고 승인 UX를 개선한다.

## 2. 범위

### 포함
- 코드 의도 분석 (미확정 시그널 보완, confidence < 0.5)
- 관계 설명 자동 생성 (자연어)
- 도메인 라벨 정제 (Track B Discovery)
- 배치 그룹화 최적화 + 비용 제어

### 제외 (후속)
- LLM 기반 완전 자율 추론
- Fine-tuned 커스텀 모델

## 3. 기능 상세

### 3.1 코드 의도 분석 (Pre-inference)

```
미확정 시그널 수집 (confidence < threshold)
      ↓
코드 컨텍스트 추출 (±30 lines)
      ↓
LLM 호출: "이 코드에서 외부 서비스 호출/DB 접근/메시지 발행 식별"
      ↓
보완 후보 생성 (source: "LLM_BOOST", confidence: 0.5~0.7)
```

**대상:** 동적 URL 구성, 리플렉션, 커스텀 HTTP 클라이언트 등

### 3.2 관계 설명 자동 생성

```
후보 + evidence → 배치 그룹화 (같은 subject 서비스, 5~10건)
      ↓
LLM: "아래 서비스 관계들을 각각 1~2문장으로 설명하세요"
      ↓
metadata.llmExplanation 저장
```

### 3.3 도메인 라벨 정제

```
클러스터 멤버 + label_candidates + prefix 정보
      ↓
LLM: "적합한 도메인 이름을 한국어/영어로 제안"
      ↓
metadata.llmLabel 저장 → 승인 UI에서 제안 표시
```

## 4. 비용 제어

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `llm_boost_enabled` | false | 부스터 활성화 |
| `llm_boost_threshold` | 0.5 | 분석 대상 confidence 임계값 |
| `llm_explanation_enabled` | true | 설명 생성 여부 |
| `llm_label_enabled` | true | 라벨 정제 여부 |
| `llm_max_calls_per_run` | 50 | 최대 LLM 호출 수 |

## 5. API 변경

### POST /api/inference/run 확장

```json
{
  "llmBoost": { "enabled": true, "codeIntentAnalysis": true, "generateExplanations": true, "maxCalls": 50 }
}
```

### POST /api/inference/domain-run 확장

```json
{
  "llmLabel": { "enabled": true }
}
```

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 동적 URL 패턴에서 LLM이 대상 서비스 식별 |
| T2 | LLM 보완 후보의 source = "LLM_BOOST", confidence 0.5~0.7 |
| T3 | 관계 설명이 metadata.llmExplanation에 저장 |
| T4 | 도메인 라벨이 한국어/영어 쌍으로 제안 |
| T5 | `llm_boost_enabled: false` 시 LLM 호출 없음 |
| T6 | `llm_max_calls_per_run` 초과 시 스킵 |
| T7 | 배치 그룹화가 같은 subject 서비스 기준으로 동작 |
| T8 | Approval UI에서 LLM 설명이 후보 카드에 표시 |
| T9 | LLM 호출 실패 시 기존 결과에 영향 없음 (graceful degradation) |

## 7. 후속 범위

- LLM 기반 완전 자율 추론
- Fine-tuned 모델 지원
- 캐싱/임베딩 기반 비용 최적화
