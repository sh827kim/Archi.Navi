# 30. Cross-Signal Validation Phase 2A - STALE_CONFIG (SPEC)

상태: Implemented
작성일: 2026-03-20
상위 SPEC: `docs/spec/18-cross-signal-validation-spec.md`
선행 SPEC: `docs/spec/18-cross-signal-validation-spec.md`

## 1. 목적

`Cross-Signal Validation`의 다음 작은 PR로 `C1 STALE_CONFIG` 단일 모순 규칙만 추가한다.

이번 범위에서는 config 로 발견된 DB 연결 후보가 실제 코드 DB 사용 흔적과 연결되지 않을 때 경고를 남기고
confidence 를 보수적으로 낮춘다.

## 2. 범위

### 포함
- `STALE_CONFIG` 단일 모순 규칙 감지
- `relation_candidates.metadata.crossValidation.contradictions` 저장
- 단일 모순에 대한 confidence penalty 적용
- Approval 목록 경고 배지 노출

### 제외
- `PHANTOM_CALL`, `DEAD_TOPIC`, `ORPHAN_FK`
- `domain_inference_profiles` 파라미터 조정
- Approval 필터/정렬

## 3. 처리 규칙

### 3.1 판정 조건
- 후보의 `relationType` 이 `read` 또는 `write` 여야 한다.
- 후보의 지지 소스에 `config` 가 포함되어야 한다.
- 후보의 대상 object 가 `database` 여야 한다.
- 동일 서비스(`subjectObjectId`)에 대해, 해당 database 를 parent 로 가지는 `db_table` 대상의 code 기반 `read/write` 후보가 없으면 `STALE_CONFIG` 로 판정한다.

### 3.2 penalty
- penalty 는 고정값 `0.15` 를 사용한다.
- `metadata.crossValidation.originalConfidence` 가 있으면 이를 기준 confidence 로 사용한다.
- 최종 confidence 는 다음으로 계산한다.

```ts
adjusted = clamp(baseConfidence + boost - 0.15, 0.1, 0.99)
```

- `boost` 는 Phase 1 규칙을 그대로 사용한다.
- contradiction 이 있으면 `metadata.crossValidation.contradictions` 배열에 저장한다.

## 4. 데이터 모델

`relation_candidates.metadata.crossValidation`

```json
{
  "validated": false,
  "supportingSources": ["config"],
  "contradictions": [
    { "ruleId": "C1", "type": "STALE_CONFIG", "penalty": 0.15 }
  ],
  "originalConfidence": 0.9,
  "adjustedConfidence": 0.75,
  "validatedAt": "2026-03-20T12:00:00Z"
}
```

## 5. UI

- Approval 목록에서 `contradictions.length > 0` 이면 `STALE_CONFIG 경고` 배지를 표시한다.
- 경고 배지는 기존 `2+ 소스 지지` / `단일 소스` 배지보다 우선한다.

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | config 기반 `service -> database` read/write 후보에 대응하는 code 기반 `db_table` 접근 후보가 없으면 `STALE_CONFIG` 가 기록된다 |
| T2 | `STALE_CONFIG` 가 기록된 후보의 confidence 는 0.15 penalty 만큼 감소한다 |
| T3 | 동일 서비스가 같은 database 하위 `db_table` 을 code 로 접근하면 `STALE_CONFIG` 가 기록되지 않는다 |
| T4 | Approval 목록에서 `STALE_CONFIG 경고` 배지가 표시된다 |
| T5 | 기존 Phase 1 다중 소스 부스트 동작에 회귀가 없다 |

## 7. DB 마이그레이션

- 없음
- 기존 `relation_candidates.metadata` JSONB 필드를 사용한다
