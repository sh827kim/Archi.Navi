# 22. 추론 피드백 루프 (SPEC) (Roadmap 4-6)

상태: Draft
작성일: 2026-03-08

## 1. 목적

승인/거절 패턴을 **시그널 유형별 집계** → 기본 신뢰도 자동 보정. 사용할수록 노이즈 감소.

## 2. 범위

### 포함
- 승인/거절 이벤트 집계, 시그널 유형별 승인율 계산
- 신뢰도 자동 보정 (최소 10건 축적 시)
- domain_inference_profiles에 피드백 데이터 저장
- Settings UI에 보정 통계 표시

### 제외: ML 모델 학습, 사용자별 개인화, 실시간 보정

## 3. 처리 규칙

### 피드백 수집
```
key = "{signalKind}:{source}:{framework}:{language}"
예: "call:code:spring-boot:java", "fk_reference:db:*:*"
```

### 보정 규칙
```typescript
const MIN_SAMPLES = 10;
const MAX_ADJUSTMENT = 0.15;

function computeAdjustment(stats: FeedbackStats): number {
  if (stats.total < MIN_SAMPLES) return 0;
  return (stats.approvalRate - 0.5) * MAX_ADJUSTMENT;
}
```

### 적용
추론 실행 시: `adjustedConfidence = clamp(base + feedbackAdjustment, 0.1, 0.99)`

## 4. 데이터 모델

### domain_inference_profiles 확장
```json
{
  "feedbackAdjustments": {
    "call:code:spring-boot:java": {
      "approved": 45, "rejected": 5, "total": 50,
      "approvalRate": 0.9, "adjustment": 0.06
    }
  },
  "feedbackConfig": { "minSamples": 10, "maxAdjustment": 0.15, "enabled": true }
}
```

## 5. UI 변경

- Settings > 추론 프로필: 피드백 통계 테이블, 보정 토글, 초기화 버튼
- Approval 페이지: 후보 카드에 피드백 보정 힌트 표시

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 승인/거절 시 피드백 통계 올바르게 집계 |
| T2 | MIN_SAMPLES 미만 시 보정 미적용 |
| T3 | 승인율 90% → confidence 상향 보정 |
| T4 | 승인율 30% → confidence 하향 보정 |
| T5 | MAX_ADJUSTMENT 초과하지 않음 |
| T6 | Settings에서 통계 확인/초기화 가능 |
| T7 | `enabled: false` 시 보정 미적용 |
