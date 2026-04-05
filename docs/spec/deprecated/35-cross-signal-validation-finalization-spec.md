# [Deprecated] 35. Cross-Signal Validation Finalization (SPEC)

> **상태: Deprecated (2026-04-05)**
> 이 문서는 cross-signal validation 마감 단계의 통합 PR 계약이었다.
> 현재 현행 기준은 [18-cross-signal-validation-spec.md](../18-cross-signal-validation-spec.md)에 흡수되었고, 규칙별 상세는 [30-cross-signal-validation-stale-config-phase2a-spec.md](../30-cross-signal-validation-stale-config-phase2a-spec.md)부터 [34-cross-signal-validation-orphan-fk-spec.md](../34-cross-signal-validation-orphan-fk-spec.md)까지를 참조한다.

---

## 대체 사유

- profile 파라미터, Approval 필터/정렬, 최종 운영 기준은 이제 `18` 한 문서에서 읽을 수 있다.
- 마감용 PR 문서를 현행 기준으로 계속 유지할 이유가 줄었다.
- 현재 기준에서는 `18`이 공통 규칙, `30~34`가 규칙별 상세라는 구조가 더 명확하다.

---

## (아래는 원본 내용)

# 35. Cross-Signal Validation Finalization (SPEC)

상태: Implemented
작성일: 2026-03-20
상위 SPEC: `docs/spec/18-cross-signal-validation-spec.md`
선행 SPEC:
- `docs/spec/29-cross-signal-validation-phase1-spec.md`
- `docs/spec/30-cross-signal-validation-stale-config-phase2a-spec.md`
- `docs/spec/31-cross-signal-validation-common-contract-spec.md`
- `docs/spec/32-cross-signal-validation-phantom-call-spec.md`
- `docs/spec/33-cross-signal-validation-dead-topic-spec.md`
- `docs/spec/34-cross-signal-validation-orphan-fk-spec.md`

## 1. 목적

`4-2 Cross-Signal Validation`을 종료 가능한 상태로 마감한다.

이번 PR에서는 남아 있던 `domain_inference_profiles` 기반 파라미터화와 Approval 필터/정렬/UI 마감을 구현하고,
중복 SPEC을 정리해 문서 기준을 하나로 고정한다.

## 2. 범위

### 포함
- `domain_inference_profiles.crossValidation` 설정 추가
- cross-validation 계산에서 `enabled`, `boostFactor`, `penaltyFactor` 반영
- Approval 목록의 교차 검증 상태 필터/정렬 UI
- 중복 SPEC 정리와 구현 상태 문서 갱신

### 제외
- 새로운 contradiction 규칙 추가
- 다중 contradiction 우선순위 정책 확장
- Approval 서버 사이드 검색/필터 API

## 3. 처리 규칙

### 3.1 profile 파라미터
- `domain_inference_profiles.crossValidation` JSON은 아래 shape 을 사용한다.

```json
{
  "enabled": true,
  "boostFactor": 0.3,
  "penaltyFactor": 0.85
}
```

- 값이 없으면 기본값은 위와 동일하다.
- `enabled=false` 이면 교차 검증은 no-op 으로 동작한다.

### 3.2 confidence 계산
- 지지 부스트는 `boostFactor` 를 사용한다.
- 단일 contradiction penalty 는 `1 - penaltyFactor` 를 사용한다.
- 현재 규칙들은 한 후보당 단일 contradiction 기준으로 계산한다.

### 3.3 Approval UI
- 최소 필터:
  - `전체`
  - `경고만`
  - `다중 소스`
  - `단일 소스`
- 최소 정렬:
  - `교차 검증 우선`
  - `신뢰도 높은순`
  - `신뢰도 낮은순`

## 4. 중복 SPEC 정리 원칙

- `docs/spec/30-cross-signal-validation-stale-config-phase2a-spec.md` 를 C1 정식 문서로 유지한다.
- `docs/spec/31-cross-signal-validation-stale-config-phase2-spec.md` 는 제거한다.
- `docs/spec/31-cross-signal-validation-common-contract-spec.md` 를 공통 계약 문서로 유지한다.
- `docs/spec/32-cross-signal-validation-contract-freeze-spec.md` 는 제거한다.

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 기본 profile API가 `crossValidation` 설정을 GET/PUT 할 수 있다 |
| T2 | `enabled=false` profile 에서는 교차 검증이 수행되지 않고 기존 후보 confidence/metadata 에 변화가 없다 |
| T3 | `boostFactor`, `penaltyFactor` 값을 바꾸면 cross-validation 결과 confidence 가 그 값에 맞게 달라진다 |
| T4 | Approval 목록에서 `전체/경고만/다중 소스/단일 소스` 필터가 동작한다 |
| T5 | Approval 목록에서 `교차 검증 우선/신뢰도 높은순/신뢰도 낮은순` 정렬이 동작한다 |
| T6 | 중복 SPEC 제거 후 `docs/02-implementation-status.md` 에서 `4-2` 상태가 구현 완료로 갱신된다 |
