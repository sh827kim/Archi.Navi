# 36. Relation Feedback Key Specialization (SPEC)

상태: Implemented
작성일: 2026-03-28
최종 정합화: 2026-03-28

## 1. 목적

기존 relation feedback loop는 `relationType:sourceFamily:signalKind` v1 canonical key만 사용했다. 이번 후속 SPEC의 목적은 **code-origin relation feedback에 한해 framework/language 차원을 안전하게 세분화**하면서도, 이미 저장된 legacy v1 bucket을 깨지 않고 다음 run 보정 흐름을 유지하는 것이다.

이번 문서는 domain feedback 확장을 다루지 않는다. `docs/spec/22-inference-feedback-loop-spec.md`가 relation/domain public contract 분리와 Track A domain feedback를 고정했다면, 본 문서는 그 위에 **relation feedback key specialization**만 후속으로 고정한다.

## 2. shipped 기준선

- relation feedback approval/rejection 누적과 next-run-only relation confidence 보정은 이미 구현돼 있다.
- `GET /api/inference/candidates`와 profile/settings public contract는 feedback key를 공개 문자열로 노출한다.
- code signal evidence에는 이미 `language`가 공통 저장되고, 일부 scanner/plugin 경로는 `framework`도 evidence metadata에 저장한다.

이번 closure의 판단 기준은 아래 세 가지다.

- code-origin relation candidate가 framework/language를 안정적으로 가지면 v2 key를 사용한다.
- framework/language가 없거나 불안정하면 v1 key로 fallback 한다.
- lookup은 `v2 -> legacy v1` 순서의 dual-read를 사용하고, public API는 key를 opaque string으로 유지한다.

## 3. 범위

### 포함

- code-origin relation feedback key v2 도입
- framework/language metadata를 relation candidate metadata에 승격 및 보존
- next-run apply lookup의 `v2 -> legacy v1` dual-read
- approval 누적과 apply lookup의 공통 key derivation 규칙
- public API의 3-segment/5-segment key 수용

### 제외

- domain feedback key 세분화
- Track B / domain discovery feedback
- legacy v1 bucket rewrite, replay, backfill
- `keyVersion` 같은 신규 public field 추가

## 4. 얼린 계약

### 4.1 key 형식

- 기존 canonical key v1은 유지한다.

```text
{relationType}:{sourceFamily}:{signalKind}
```

- 신규 canonical key v2는 code-origin relation에만 적용한다.

```text
{relationType}:{sourceFamily}:{signalKind}:{framework}:{language}
```

예:

```text
CALL:code:call:spring_boot:java
CALL:code:call:express:typescript
```

### 4.2 specialization 조건

- `sourceFamily=code` 이고 `framework`, `language`가 둘 다 안정적으로 있을 때만 v2를 만든다.
- 둘 중 하나라도 비어 있거나 불안정하면 v1로 fallback 한다.
- `sourceFamily=config|db|unknown` 은 계속 v1만 사용한다.

### 4.3 dual-read migration

- approval/rejection 누적은 새 derivation 규칙으로 단일 key를 저장한다.
- next-run apply lookup은 아래 우선순위를 따른다.
  1. specialized v2 key
  2. legacy v1 key
- 이미 저장된 v1 bucket은 rewrite 하지 않는다.
- replay/backfill은 이번 범위에 포함하지 않는다.
- reset은 기존 relation feedback reset 한 번으로 충분하지만, 결과적으로 v1/v2 bucket을 모두 비워야 한다.

### 4.4 metadata source-of-truth

- code evidence metadata의 `framework`, `language`를 relation candidate metadata로 승격한다.
- pending candidate merge/update 이후에도 `framework`, `language`, specialized `feedback.key` 가 손실되면 안 된다.
- config-code binding / endpoint mapping은 원본 candidate metadata를 보존하는 경로로 유지한다.

### 4.5 public contract

- 공개 API는 feedback key를 opaque string으로 취급한다.
- 3-segment와 5-segment key를 모두 수용한다.
- `keyVersion`, `framework`, `language`를 feedback public field로 강제 노출하지 않는다.
- `GET /api/inference/candidates`의 feedback hint는 key와 observability 최소 필드만 유지한다.

## 5. 수용 기준

| ID | 기준 |
|----|------|
| K1 | code-origin relation candidate가 framework/language를 가지면 v2 key를 생성한다 |
| K2 | framework/language가 없으면 v1 key로 fallback 한다 |
| K3 | config/db relation feedback는 계속 v1 key만 사용한다 |
| K4 | next-run apply lookup은 `v2 -> legacy v1` 순서의 dual-read를 사용한다 |
| K5 | approval 누적과 apply lookup은 동일한 key derivation 규칙을 사용한다 |
| K6 | pending merge/update 이후에도 framework/language와 specialized key가 손실되지 않는다 |
| K7 | public API는 3-segment와 5-segment key를 모두 수용한다 |
| K8 | `keyVersion` 같은 새 공개 필드는 추가하지 않는다 |

## 6. 검증 메모

- inference unit test
  - v2 생성
  - v1 fallback
  - config/db v1 유지
  - dual-read 우선순위
  - pending merge 보존
- web contract test
  - 5-segment key 노출
  - 3-segment backward compatibility
  - opaque string 유지 및 내부 observability 필드 비노출
