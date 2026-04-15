# [Deprecated] 31. Cross-Signal Validation Common Contract (SPEC)

> **상태: Deprecated (2026-04-05)**
> 이 문서는 contradiction payload와 Approval badge 공통 계약을 고정하던 중간 단계 문서였다.
> 현재 현행 공통 계약은 [18-cross-signal-validation-spec.md](../18-cross-signal-validation-spec.md)에 완전히 흡수되었다.

---

## 대체 사유

- contradiction item shape, badge 우선순위, parser/helper pass-through 계약은 이제 `18`에서 직접 읽을 수 있다.
- `31`을 별도 공통 계약 문서로 유지할 이유보다 `18` 단일 기준의 일관성이 더 중요해졌다.
- 현재 읽는 순서는 `18 -> 규칙별 상세(30/32/33/34)`가 더 명확하다.

---

## (아래는 원본 내용)

# 31. Cross-Signal Validation Common Contract (SPEC)

상태: Implemented
작성일: 2026-03-20
상위 SPEC: `docs/spec/18-cross-signal-validation-spec.md`
선행 SPEC: `docs/spec/18-cross-signal-validation-spec.md`

## 1. 목적

`4-2 Cross-Signal Validation`의 남은 규칙 `C2/C3/C4`를 병렬로 구현하기 전에,
공통 contradiction 계약과 Approval 소비자 계약을 먼저 고정한다.

이번 PR은 새 모순 규칙을 추가하지 않고, 이후 작은 PR들이 같은 데이터 계약을 공유하게 만드는 것이 목표다.

## 2. 범위

### 포함
- `crossValidation.contradictions` 공통 타입 확장
- C1~C4 rule/type 표현을 위한 parser/helper/UI 계약 고정
- Approval badge 우선순위 정책 고정
- 규칙별 구현이 추가돼도 회귀하지 않는 테스트 보강

### 제외
- `PHANTOM_CALL`, `DEAD_TOPIC`, `ORPHAN_FK` 탐지 로직
- `domain_inference_profiles` 파라미터 적용
- Approval 필터/정렬

## 3. 처리 규칙

### 3.1 contradiction 데이터 계약
- `relation_candidates.metadata.crossValidation.contradictions` 는 아래 shape 배열을 사용한다.

```json
{
  "ruleId": "C1",
  "type": "STALE_CONFIG",
  "penalty": 0.15
}
```

- `ruleId` 는 `C1 | C2 | C3 | C4`
- `type` 은 `STALE_CONFIG | PHANTOM_CALL | DEAD_TOPIC | ORPHAN_FK`
- `penalty` 는 숫자이며 규칙별 감점값을 나타낸다.

### 3.2 web parser/helper 계약
- candidates API 는 알려진 contradiction 타입을 그대로 응답에 보존한다.
- helper 는 contradiction 배열을 손실 없이 pass-through 한다.
- UI 는 contradiction 존재 여부와 타입을 기준으로 경고 배지를 계산한다.

### 3.3 Approval badge 정책
- `contradictions.length > 0` 이면 경고 배지가 지지 배지보다 우선한다.
- 경고 배지 라벨은 type 별로 구분한다.
  - `STALE_CONFIG 경고`
  - `PHANTOM_CALL 경고`
  - `DEAD_TOPIC 경고`
  - `ORPHAN_FK 경고`

## 4. 수용 기준

| ID | 기준 |
|----|------|
| T1 | web parser/helper/UI 타입이 `C1~C4` contradiction shape(`ruleId`, `type`, `penalty`)를 모두 보존한다 |
| T2 | Approval 목록에서 contradiction 이 있으면 해당 규칙 라벨의 경고 배지가 지지 배지보다 우선한다 |
| T3 | 기존 `STALE_CONFIG` 동작과 테스트에 회귀가 없다 |

## 5. DB 마이그레이션

- 없음
- 기존 `relation_candidates.metadata` JSONB 필드를 사용한다
