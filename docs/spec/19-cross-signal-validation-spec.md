# 19. Cross-Signal Validation (SPEC) (Roadmap 4-2)

상태: Implemented
작성일: 2026-03-08

## 1. 목적

config, code, db 시그널 수집기가 **독립 생성한 후보를 교차 검증**하여,
복수 시그널 지지 관계의 신뢰도를 올리고, 모순 관계의 신뢰도를 내린다.

## 2. 범위

### 포함
- 동일 관계의 다중 시그널 소스 그룹화
- 지지/모순 판정 로직 + Bayesian 신뢰도 업데이트
- 모순 감지 (Stale Config, Phantom Call, Dead Topic, Orphan FK)
- 교차 검증 메타데이터 저장 및 UI 배지 표시

### 제외 (후속)
- 시그널 소스 간 가중치 학습 (피드백 루프에서 처리)
- 시간 기반 decay

## 3. 처리 규칙

### 3.1 실행 시점

모든 모드 완료 후 자동 실행. 2개 이상 모드 실행 시에만 동작.

### 3.2 그룹화

`GROUP BY (subjectObjectId, objectId, relationType)` → 소스별 evidence 수집

### 3.3 모순 판정

| 규칙 ID | 조건 | 판정 |
|---------|------|------|
| C1 | config에서 DB 연결 발견 + code에서 미사용 | STALE_CONFIG |
| C2 | code에서 HTTP call + 대상 endpoint 미존재 | PHANTOM_CALL |
| C3 | config에서 topic 설정 + code에서 produce/consume 미발견 | DEAD_TOPIC |
| C4 | db FK 존재 + code에서 해당 테이블 미접근 | ORPHAN_FK |

### 3.4 신뢰도 재계산

```typescript
function crossValidate(group: CandidateGroup): number {
  const prior = Math.max(...group.candidates.map(c => c.confidence));
  const supportCount = group.sources.length;
  const contradictions = detectContradictions(group);

  const boost = supportCount > 1
    ? 1 - Math.pow(1 - 0.3, supportCount - 1)   // boostFactor=0.3
    : 0;

  const penalty = contradictions.length > 0
    ? 1 - Math.pow(0.85, contradictions.length)   // penaltyFactor=0.85
    : 0;

  return clamp(prior + boost - penalty, 0.1, 0.99);
}
```

## 4. 데이터 모델

### 4.1 relation_candidates.metadata 확장

```json
{
  "crossValidation": {
    "validated": true,
    "supportingSources": ["config", "code"],
    "contradictions": [{ "ruleId": "C1", "type": "STALE_CONFIG", "penalty": 0.15 }],
    "originalConfidence": 0.8,
    "adjustedConfidence": 0.92,
    "validatedAt": "2026-03-08T12:00:00Z"
  }
}
```

### 4.2 domain_inference_profiles 확장

```json
{ "crossValidation": { "enabled": true, "boostFactor": 0.3, "penaltyFactor": 0.85 } }
```

## 5. UI 변경

- Approval 페이지: 교차 검증 배지 (🟢 2+ 소스 지지 / 🟡 단일 / 🔴 모순 감지)
- 교차 검증 상태별 필터/정렬

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | config + code 동시 발견 시 신뢰도 부스트 (0.8 → 0.92+) |
| T2 | config only + code 미발견 시 STALE_CONFIG 감지 |
| T3 | 모드 1개만 실행 시 교차 검증 스킵 |
| T4 | 파라미터가 domain_inference_profiles에서 조정 가능 |
| T5 | Approval UI에서 배지 올바르게 표시 |
| T6 | 기존 단일 모드 실행에 회귀 없음 |

## 7. 후속 범위

- 시간 기반 시그널 decay
- 교차 검증 결과를 피드백 루프에 반영
