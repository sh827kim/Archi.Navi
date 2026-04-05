# 18. Cross-Signal Validation (SPEC) (Roadmap 4-2)

상태: Implemented (canonical)
작성일: 2026-03-08
최종 정리: 2026-04-05

> Note (2026-04-05): 이 문서는 cross-signal validation의 단일 현행 기준 문서다.
> 이전 단계 문서였던 `29`, `31`, `35`는 이 문서에 흡수되었고, 상세 규칙 문서는 [30-cross-signal-validation-stale-config-phase2a-spec.md](./30-cross-signal-validation-stale-config-phase2a-spec.md), [32-cross-signal-validation-phantom-call-spec.md](./32-cross-signal-validation-phantom-call-spec.md), [33-cross-signal-validation-dead-topic-spec.md](./33-cross-signal-validation-dead-topic-spec.md), [34-cross-signal-validation-orphan-fk-spec.md](./34-cross-signal-validation-orphan-fk-spec.md)를 참조한다.

## 1. 목적

config, code, db 시그널 수집기가 독립 생성한 후보를 교차 검증해,

1. 복수 시그널 지지 관계의 신뢰도를 올리고
2. 모순 관계의 신뢰도를 내리며
3. Approval UI에서 운영자가 그 상태를 빠르게 읽을 수 있게 한다.

## 2. 범위

### 포함
- 동일 관계 후보의 다중 소스 그룹화
- 지지 신호 부스트
- contradiction 공통 계약
- `STALE_CONFIG`, `PHANTOM_CALL`, `DEAD_TOPIC`, `ORPHAN_FK` 규칙
- `domain_inference_profiles.crossValidation` 파라미터
- Approval 배지, 필터, 정렬

### 제외
- 시그널 소스 간 가중치 학습
- 시간 기반 decay
- Approval 서버 사이드 검색/필터 API
- 새로운 contradiction 규칙 추가

## 3. 문서 구조

- 이 문서: 현행 공통 계약과 제품 기준
- [30-cross-signal-validation-stale-config-phase2a-spec.md](./30-cross-signal-validation-stale-config-phase2a-spec.md): C1 `STALE_CONFIG`
- [32-cross-signal-validation-phantom-call-spec.md](./32-cross-signal-validation-phantom-call-spec.md): C2 `PHANTOM_CALL`
- [33-cross-signal-validation-dead-topic-spec.md](./33-cross-signal-validation-dead-topic-spec.md): C3 `DEAD_TOPIC`
- [34-cross-signal-validation-orphan-fk-spec.md](./34-cross-signal-validation-orphan-fk-spec.md): C4 `ORPHAN_FK`

## 4. 처리 규칙

### 4.1 실행 시점

- `/api/inference/run` 완료 시점
- inference run orchestration 완료 시점
- `modes`에 포함된 유효 모드가 2개 이상일 때만 실행

### 4.2 그룹화

동일 후보는 아래 키로 그룹화한다.

`(subjectObjectId, objectId, relationType)`

소스 판정은 `relation_candidate_evidences`와 `evidences`를 기준으로 한다.

- `evidenceType=CONFIG` -> `config`
- `evidenceType=FILE` -> `code`
- `evidenceType=SCHEMA` -> `db`

### 4.3 모순 판정

| 규칙 ID | 타입 | 상세 문서 | 요약 |
|---|---|---|---|
| `C1` | `STALE_CONFIG` | [30](./30-cross-signal-validation-stale-config-phase2a-spec.md) | config 기반 DB 연결 후보인데 code 기반 테이블 접근 근거가 없음 |
| `C2` | `PHANTOM_CALL` | [32](./32-cross-signal-validation-phantom-call-spec.md) | code 기반 service call 후보인데 endpoint 근거가 닫히지 않음 |
| `C3` | `DEAD_TOPIC` | [33](./33-cross-signal-validation-dead-topic-spec.md) | config 기반 topic 후보인데 code produce/consume 근거가 없음 |
| `C4` | `ORPHAN_FK` | [34](./34-cross-signal-validation-orphan-fk-spec.md) | FK 기반 후보인데 code 테이블 접근 근거가 없음 |

### 4.4 신뢰도 재계산

- 기준 confidence는 현재 후보 confidence가 아니라 `metadata.crossValidation.originalConfidence`가 있으면 그 값을 우선 사용한다.
- 다중 소스 지지 시 부스트를 적용한다.
- contradiction이 있으면 penalty를 적용한다.
- `enabled=false`이면 no-op이다.

```ts
boost = supportCount > 1
  ? 1 - Math.pow(1 - boostFactor, supportCount - 1)
  : 0;

penalty = contradictions.length > 0
  ? 1 - Math.pow(penaltyFactor, contradictions.length)
  : 0;

adjusted = clamp(originalConfidence + boost - penalty, 0.1, 0.99);
```

기본값:

- `boostFactor = 0.3`
- `penaltyFactor = 0.85`

현재 shipped 규칙은 실질적으로 후보당 단일 contradiction 기준으로 계산한다.

## 5. 데이터 계약

### 5.1 `relation_candidates.metadata.crossValidation`

```json
{
  "crossValidation": {
    "validated": true,
    "supportingSources": ["config", "code"],
    "contradictions": [{ "ruleId": "C1", "type": "STALE_CONFIG", "penalty": 0.15 }],
    "originalConfidence": 0.8,
    "adjustedConfidence": 0.92,
    "validatedAt": "2026-04-05T12:00:00Z"
  }
}
```

### 5.2 contradiction item shape

```json
{
  "ruleId": "C1",
  "type": "STALE_CONFIG",
  "penalty": 0.15
}
```

허용값:

- `ruleId`: `C1 | C2 | C3 | C4`
- `type`: `STALE_CONFIG | PHANTOM_CALL | DEAD_TOPIC | ORPHAN_FK`

### 5.3 profile 계약

```json
{ "crossValidation": { "enabled": true, "boostFactor": 0.3, "penaltyFactor": 0.85 } }
```

## 6. UI 계약

### 6.1 badge 우선순위

- `contradictions.length > 0` 이면 경고 배지가 지지 배지보다 우선한다.
- 다중 소스 지지면 `2+ 소스 지지` 배지를 표시한다.
- 그 외는 `단일 소스` 배지를 표시한다.

### 6.2 경고 배지 라벨

- `STALE_CONFIG 경고`
- `PHANTOM_CALL 경고`
- `DEAD_TOPIC 경고`
- `ORPHAN_FK 경고`

### 6.3 Approval 필터 / 정렬

최소 필터:

- `전체`
- `경고만`
- `다중 소스`
- `단일 소스`

최소 정렬:

- `교차 검증 우선`
- `신뢰도 높은순`
- `신뢰도 낮은순`

## 7. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 유효 모드가 2개 이상일 때만 교차 검증이 수행된다 |
| T2 | 다중 소스 후보는 `originalConfidence` 기준으로 1회만 부스트된다 |
| T3 | `enabled=false` profile에서는 후보 confidence/metadata가 변경되지 않는다 |
| T4 | `C1~C4` contradiction shape가 API/helper/UI를 거쳐 손실 없이 유지된다 |
| T5 | contradiction이 있으면 경고 배지가 지지 배지보다 우선한다 |
| T6 | Approval 목록에서 `전체/경고만/다중 소스/단일 소스` 필터와 `교차 검증 우선/신뢰도 높은순/신뢰도 낮은순` 정렬이 동작한다 |

## 8. 구현 메모

- 초기 구현 단계 문서였던 `29`, 공통 계약 정리 문서였던 `31`, 마감 단계 문서였던 `35`는 현재 기준에서 이 문서에 흡수됐다.
- 구현 세부 조건과 규칙별 판정 로직은 `30`, `32`, `33`, `34`를 참조한다.
