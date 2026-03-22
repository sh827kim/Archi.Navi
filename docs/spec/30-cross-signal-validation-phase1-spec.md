# 30. Cross-Signal Validation Phase 1 (SPEC)

상태: Implemented
작성일: 2026-03-20
상위 SPEC: `docs/spec/19-cross-signal-validation-spec.md`

## 1. 목적

`config`, `code`, `db` 중 둘 이상의 소스가 동일 관계 후보를 지지할 때,
작은 PR 범위에서 바로 사용할 수 있는 교차 검증 기초 레이어를 추가한다.

이번 Phase 1 은 "지지 신호 부스트 + Approval 가시화"까지만 구현한다.

## 2. 범위

### 포함
- `relation_candidates.metadata.crossValidation` 저장
- 다중 소스 지지 시 confidence 재계산
- 단일 소스 후보의 교차 검증 no-op 처리
- Approval 목록 배지 노출

### 제외
- 모순 판정 규칙(C1~C4)
- `domain_inference_profiles` 파라미터 조정
- Approval 필터/정렬

## 3. 처리 규칙

### 3.1 실행 시점
- `/api/inference/run` 완료 시점
- inference run orchestration 완료 시점
- `modes` 에 포함된 유효 모드가 2개 이상일 때만 실행

### 3.2 소스 판정
- `relation_candidate_evidences` 와 `evidences` 를 조인하여 소스를 판정한다.
- `evidenceType=CONFIG` → `config`
- `evidenceType=FILE` → `code`
- `evidenceType=SCHEMA` → `db`

### 3.3 confidence 재계산
- 기준 confidence 는 현재 후보 confidence 가 아니라 `metadata.crossValidation.originalConfidence` 가 있으면 그 값을 우선 사용한다.
- 다중 소스 지지 시 다음 공식을 사용한다.

```ts
boost = 1 - Math.pow(1 - 0.3, supportCount - 1)
adjusted = clamp(originalConfidence + boost, originalConfidence, 0.99)
```

- 단일 소스면 confidence 를 변경하지 않는다.

## 4. 데이터 모델

`relation_candidates.metadata.crossValidation`

```json
{
  "validated": true,
  "supportingSources": ["config", "code"],
  "originalConfidence": 0.7,
  "adjustedConfidence": 0.91,
  "validatedAt": "2026-03-20T12:00:00Z"
}
```

## 5. UI

- Approval 목록에서 `supportingSources.length >= 2` 이면 `2+ 소스 지지` 배지 표시
- 그 외 후보는 `단일 소스` 배지 표시

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 동일 후보가 `config + code` 또는 `config + db` 등 2개 이상 소스로 지지되면 confidence 가 1회만 부스트되고 `metadata.crossValidation.validated=true` 로 저장된다 |
| T2 | 동일 후보가 단일 소스만 가지면 confidence 는 변하지 않고 기존 동작에 회귀가 없다 |
| T3 | 교차 검증을 여러 번 실행해도 `originalConfidence` 기준으로 같은 `adjustedConfidence` 가 유지된다 |
| T4 | `/api/inference/run` 과 orchestration run 에서 `modes` 가 1개면 교차 검증을 수행하지 않는다 |
| T5 | Approval 목록에서 다중 소스 후보는 `2+ 소스 지지`, 나머지는 `단일 소스` 배지가 표시된다 |

## 7. DB 마이그레이션

- 없음
- 기존 `relation_candidates.metadata` JSONB 필드를 사용한다
