# 34. Cross-Signal Validation Phase 2D - ORPHAN_FK (SPEC)

상태: Implemented
작성일: 2026-03-20
상위 SPEC: `docs/spec/18-cross-signal-validation-spec.md`
선행 SPEC: `docs/spec/18-cross-signal-validation-spec.md`

## 1. 목적

`C4 ORPHAN_FK` 단일 모순 규칙을 추가한다.
db FK 기반 후보가 존재하지만 code에서 해당 테이블 접근이 확인되지 않는 경우 경고와 penalty를 기록한다.

## 2. 범위

### 포함
- `ORPHAN_FK` 단일 모순 규칙 감지
- `metadata.crossValidation.contradictions` 저장
- 단일 규칙 penalty 적용
- Approval 목록 경고 배지 노출

### 제외
- `STALE_CONFIG`, `PHANTOM_CALL`, `DEAD_TOPIC` 로직 변경
- `domain_inference_profiles` 파라미터화
- Approval 필터/정렬

## 3. 처리 규칙

### 3.1 판정 조건
- 후보의 지지 소스에 `db` 가 포함되어야 한다.
- 대상 object 가 `db_table` 또는 database 계열 데이터 object 여야 한다.
- FK 근거로 후보가 생겼고, 후보의 subject/object `db_table` 어느 쪽에도 code 기반 `read/write` 접근 후보가 없으면 `ORPHAN_FK` 로 판정한다.

### 3.2 penalty
- penalty 는 고정값 `0.15`
- 최종 confidence 는 `clamp(baseConfidence + boost - 0.15, 0.1, 0.99)` 를 사용한다.

## 4. 데이터 모델

```json
{
  "ruleId": "C4",
  "type": "ORPHAN_FK",
  "penalty": 0.15
}
```

## 5. UI

- Approval 목록에서 `ORPHAN_FK 경고` 배지를 표시한다.
- 경고 배지는 기존 지지 배지보다 우선한다.

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | db FK 기반 후보인데 code 테이블 접근 근거가 없으면 `ORPHAN_FK` 가 기록된다 |
| T2 | subject/object table 중 어느 한쪽에 code 테이블 접근 근거가 있으면 `ORPHAN_FK` 가 기록되지 않는다 |
| T3 | `ORPHAN_FK` 가 기록된 후보의 confidence 는 0.15 감소한다 |
| T4 | Approval 목록에서 `ORPHAN_FK 경고` 배지가 표시된다 |
