# 33. Cross-Signal Validation Phase 2C - DEAD_TOPIC (SPEC)

상태: Implemented
작성일: 2026-03-20
상위 SPEC: `docs/spec/18-cross-signal-validation-spec.md`
선행 SPEC: `docs/spec/31-cross-signal-validation-common-contract-spec.md`

## 1. 목적

`C3 DEAD_TOPIC` 단일 모순 규칙을 추가한다.
config 기반 topic 설정 후보가 존재하지만 code에서 produce/consume 흔적이 확인되지 않는 경우 경고와 penalty를 기록한다.

## 2. 범위

### 포함
- `DEAD_TOPIC` 단일 모순 규칙 감지
- `metadata.crossValidation.contradictions` 저장
- 단일 규칙 penalty 적용
- Approval 목록 경고 배지 노출

### 제외
- `STALE_CONFIG`, `PHANTOM_CALL`, `ORPHAN_FK` 로직 변경
- `domain_inference_profiles` 파라미터화
- Approval 필터/정렬

## 3. 처리 규칙

### 3.1 판정 조건
- 후보의 `relationType` 이 `produce` 또는 `consume` 여야 한다.
- 후보의 지지 소스에 `config` 가 포함되어야 한다.
- 대상 object 가 `kafka_topic` 또는 `message_broker` 계열 topic object 여야 한다.
- 동일 서비스와 topic 조합에 대해 code 기반 produce/consume 후보가 없으면 `DEAD_TOPIC` 으로 판정한다.

### 3.2 penalty
- penalty 는 고정값 `0.15`
- 최종 confidence 는 `clamp(baseConfidence + boost - 0.15, 0.1, 0.99)` 를 사용한다.

## 4. 데이터 모델

```json
{
  "ruleId": "C3",
  "type": "DEAD_TOPIC",
  "penalty": 0.15
}
```

## 5. UI

- Approval 목록에서 `DEAD_TOPIC 경고` 배지를 표시한다.
- 경고 배지는 기존 지지 배지보다 우선한다.

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | config 기반 topic 후보인데 code produce/consume 근거가 없으면 `DEAD_TOPIC` 이 기록된다 |
| T2 | code produce/consume 후보가 있으면 `DEAD_TOPIC` 이 기록되지 않는다 |
| T3 | `DEAD_TOPIC` 이 기록된 후보의 confidence 는 0.15 감소한다 |
| T4 | Approval 목록에서 `DEAD_TOPIC 경고` 배지가 표시된다 |
