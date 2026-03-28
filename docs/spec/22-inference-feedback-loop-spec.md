# 22. 추론 피드백 루프 (SPEC) (Roadmap 4-6)

상태: Draft
작성일: 2026-03-08

## 1. 목적

relation candidate 승인/거절 패턴을 고정된 feedback key 단위로 집계하고, 그 결과를 **다음 inference run의 base confidence 보정값**으로 사용한다.

## 2. 범위

### 포함
- relation candidate 승인/거절 이벤트 집계
- feedback key 단위 승인율 계산
- 다음 inference run에서의 base confidence 자동 보정
- domain_inference_profiles에 피드백 데이터 저장
- Settings UI 필수 범위: `enabled`, `minSamples`, `maxAdjustment`, `summary`, `reset-all`

### 제외
- domain candidate 집계/보정 적용
- Approval UI hint
- per-key 상세 통계 테이블
- 기존 후보 confidence의 즉시 재계산 또는 소급 보정
- ML 모델 학습, 사용자별 개인화, 실시간 보정

## 3. 얼린 계약

### 3.1 피드백 대상
- 집계 대상은 relation candidate only 이다.
- 승인/거절에 따라 feedback 통계를 누적하지만, 이미 생성된 후보의 confidence는 그 자리에서 바꾸지 않는다.
- 누적된 통계는 승인 이후의 **다음 inference run부터** 새로 생성되거나 재계산되는 후보에만 적용한다.

### 3.2 feedback key
```
key = "{relationType}:{sourceFamily}:{signalKind}"
예: "CALL:code:call", "DEPENDS_ON:config:dependency_decl"
```

- `relationType`: 후보 relation type
- `sourceFamily`: 시그널 계열 (`code`, `config`, `db` 등)
- `signalKind`: 해당 계열 내부의 세부 signal kind
- 프레임워크, 언어, 개별 소스 위치는 이번 계약의 key 차원에 포함하지 않는다.

### 3.3 보정 규칙
```typescript
const MIN_SAMPLES = 10;
const MAX_ADJUSTMENT = 0.15;

function computeAdjustment(stats: FeedbackStats): number {
  if (stats.total < MIN_SAMPLES) return 0;
  return (stats.approvalRate - 0.5) * MAX_ADJUSTMENT;
}
```

### 3.4 confidence 적용 순서
1. inference가 산출한 `baseConfidence`를 계산한다.
2. feedback stats가 있으면 `feedbackAdjustment`를 적용해 `feedbackAdjustedConfidence`를 계산한다.
3. cross-validation은 그 다음 단계에서 `feedbackAdjustedConfidence`를 입력으로 사용한다.

```typescript
const feedbackAdjustedConfidence = clamp(
  baseConfidence + feedbackAdjustment,
  0.1,
  0.99,
);
```

- cross-validation은 feedback보다 뒤 단계이며, feedback 결과를 덮어쓰는 별도 선행 단계로 취급하지 않는다.

## 4. 데이터 모델

### domain_inference_profiles 확장
```json
{
  "feedbackAdjustments": {
    "CALL:code:call": {
      "approved": 45,
      "rejected": 5,
      "total": 50,
      "approvalRate": 0.9,
      "adjustment": 0.06
    }
  },
  "feedbackConfig": {
    "enabled": true,
    "minSamples": 10,
    "maxAdjustment": 0.15
  }
}
```

## 5. UI 변경

- Settings > 추론 프로필
  - `enabled` 토글
  - `minSamples` 입력
  - `maxAdjustment` 입력
  - 전체 집계 summary
  - `reset-all` 액션
- Approval hint와 per-key 상세 테이블은 후속 범위다.

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | relation candidate 승인/거절 시 `relationType + sourceFamily + signalKind` key로 통계가 집계된다 |
| T2 | domain candidate는 집계 및 보정 대상에 포함되지 않는다 |
| T3 | `MIN_SAMPLES` 미만 key는 다음 inference run에서도 보정이 적용되지 않는다 |
| T4 | 승인율 90% key는 다음 inference run의 base confidence를 상향 보정한다 |
| T5 | 승인율 30% key는 다음 inference run의 base confidence를 하향 보정한다 |
| T6 | 보정은 승인 직후 기존 후보 confidence를 바꾸지 않고 이후 inference run부터만 적용된다 |
| T7 | feedback 보정은 cross-validation보다 먼저 적용되고, cross-validation은 그 결과를 입력으로 사용한다 |
| T8 | Settings에서 `enabled`, `minSamples`, `maxAdjustment`, `summary`, `reset-all`을 제공한다 |
| T9 | Approval hint 및 per-key 상세 통계 테이블이 없어도 계약을 충족한다 |
