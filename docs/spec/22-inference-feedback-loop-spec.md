# 22. 추론 피드백 루프 (SPEC) (Roadmap 4-6)

상태: Partially Deprecated
작성일: 2026-03-08
최종 정합화: 2026-04-19

> **⚠️ Deprecation 배너 (2026-04-19, PR #69)**
>
> **Domain feedback 부분은 폐기되었다.** 도메인 추론 엔진 재설계(PR #67/#68/#69)로 다음 계약이 모두 제거되었다.
> - `PATCH /api/inference/domain-candidates/:id` 승인/거부 API
> - `TRACK_A:{primaryDomainId}:{purityBucket}` feedback key
> - Track A seed-based / Track B Louvain 도메인 추론 파이프라인과 관련 테이블(`domain_candidates`, `domain_discovery_runs`, `domain_discovery_memberships`, `domain_inference_profiles`)
>
> 신엔진(Phase 1 발견 = `POST /api/domains/discover` / `POST /api/domains/approve`, Phase 2 의미 추출 = `POST /api/domains/[id]/extract-semantic`)에는 **아직 피드백 루프가 없다**. 신엔진용 피드백 루프 설계는 후속 과제로 [docs/03-roadmap.md](../03-roadmap.md)에서 추적한다.
>
> **Relation feedback 부분은 여전히 유효하며 Implemented 상태이다.** 본 문서의 §3 이하 항목 중 "Track A domain", "domain candidate", "primaryDomainId" 등 도메인 관련 모든 절은 역사적 기록으로만 읽고, 현재 시스템 동작의 근거로 사용하지 말 것.

후속 relation feedback key specialization은 [docs/spec/36-relation-feedback-key-specialization-spec.md](./36-relation-feedback-key-specialization-spec.md)에서 별도 고정한다.

## 1. 목적

현재 코드베이스에는 relation candidate 승인/거절을 기반으로 한 feedback 루프가 존재한다. 이번 closure의 목적은 여기에 domain feedback를 섞어 확장하는 것이 아니라, **relation feedback와 domain feedback를 분리된 계약으로 재정렬**하고, 그중 domain feedback는 **Track A 전용**으로만 고정하는 것이다.

즉 이번 문서는 다음 두 가지를 동시에 고정한다.

- relation feedback는 relation 전용 저장 필드/초기화 경로를 사용한다.
- domain feedback는 Track A domain candidate 승인/거절을 집계해 **다음 domain run부터만** 반영한다.

## 2. shipped 기준선

- relation feedback는 relation candidate 승인/거절 집계와 다음 relation inference run 반영까지 구현되어 있다.
- domain feedback는 `PATCH /api/inference/domain-candidates/:id` 승인/거부 집계와 Track A seed-based domain run의 next-run-only 반영까지 구현되어 있다.
- `GET/PUT /api/inference/profiles/default` 공개 계약은 relation/domain feedback config, summary, opt-in detail entries, reset action을 각각 분리해 노출한다.
- Track B / domain discovery는 별도 저장 모델과 실행 흐름을 사용하며, domain feedback 집계/적용 대상이 아니다.

이번 closure의 판단 기준은 **공개 계약 분리**다. 내부 relation 저장 컬럼의 generic 명명(`feedback_config`, `feedback_adjustments`)은 구현 세부사항으로 남을 수 있지만, 공개 API에서는 더 이상 generic alias를 계약으로 보지 않는다.

## 3. 범위

### 포함

- Track A domain candidate 승인/거절 이벤트 집계
- relation feedback와 domain feedback의 저장 필드 분리
- relation feedback와 domain feedback의 reset 동작 분리
- domain key를 `TRACK_A:{primaryDomainId}:{purityBucket}` 형식으로 고정
- domain feedback를 승인 직후 소급 적용하지 않고 다음 Track A domain run부터만 반영
- Domain 후보 API/승인 경로 연동
- Settings에서 relation/domain summary를 분리 노출

### 제외

- Track B / domain discovery feedback 집계 및 보정
- 승인 직후 기존 domain candidate, affinity, membership의 소급 재계산
- detail table, approval hint 등 추가 observability UI를 필수 범위로 두는 것
- framework/language별 key 세분화
  - 후속 구현/계약은 `docs/spec/36-relation-feedback-key-specialization-spec.md` 참조
- ML 학습, 사용자별 개인화, 실시간 보정

## 4. 얼린 계약

### 4.1 적용 대상

- domain feedback의 집계/반영 대상은 **Track A only** 이다.
- 집계 이벤트는 `PATCH /api/inference/domain-candidates/:id`를 통해 승인 또는 거부된 Track A domain candidate다.
- Track B / domain discovery 결과(`domain_discovery_runs`, `domain_discovery_memberships`)는 이번 계약에서 feedback 소스가 아니다.

### 4.2 공개 계약과 reset 분리

`GET/PUT /api/inference/profiles/default` 공개 계약은 relation feedback와 domain feedback를 같은 generic 응답으로 합치지 않는다.

```json
{
  "relationFeedbackConfig": {
    "enabled": true,
    "minSamples": 10,
    "maxAdjustment": 0.15
  },
  "relationFeedbackSummary": {
    "totalKeys": 0,
    "eligibleKeys": 0,
    "approvedCount": 0,
    "rejectedCount": 0,
    "totalSamples": 0
  },
  "domainFeedbackConfig": {
    "enabled": true,
    "minSamples": 10,
    "maxAdjustment": 0.15
  },
  "domainFeedbackSummary": {
    "totalKeys": 0,
    "eligibleKeys": 0,
    "approvedCount": 0,
    "rejectedCount": 0,
    "totalSamples": 0
  }
}
```

- 공개 응답/요청의 계약은 `relationFeedbackConfig`, `relationFeedbackSummary`, `domainFeedbackConfig`, `domainFeedbackSummary`, `resetRelationFeedback`, `resetDomainFeedback` 기준이다.
- generic `feedbackConfig`, `feedbackAdjustments`, `feedbackSummary`, `feedbackEntries`, `resetAll`은 public contract가 아니다.
- relation feedback 초기화와 domain feedback 초기화는 별도 액션이어야 한다.
- Settings summary/detail도 relation/domain을 합산하지 않고 각각 별도 요약으로 보여준다.
- relation 측 내부 저장 필드명이 generic `feedback*`로 남아 있더라도 이는 구현 세부사항이며, public contract 판단 기준이 아니다.

### 4.3 domain feedback key

```text
TRACK_A:{primaryDomainId}:{purityBucket}
```

예:

```text
TRACK_A:domain-order:HIGH
TRACK_A:domain-payment:MEDIUM
```

- `primaryDomainId`: 승인/거부 대상 Track A candidate의 `primaryDomainId`
- `purityBucket`: candidate의 `purity`를 버킷화한 값
- `primaryDomainId`가 비어 있으면 해당 이벤트는 집계하지 않는다.
- key prefix는 반드시 `TRACK_A`로 고정하며, Track B 또는 discovery 계열 prefix를 추가하지 않는다.

### 4.4 domain 보정 시점

- 승인/거부 이벤트는 통계를 누적하지만, 이미 생성된 domain candidate나 기존 affinity 결과를 즉시 다시 계산하지 않는다.
- 누적된 domain feedback는 **다음 Track A domain run부터만** 반영된다.
- 이번 closure는 `POST /api/inference/domain-run`의 Track A 경로에 대한 next-run-only 적용만 고정한다.
- queued/orchestrated parity는 이번 closure의 public claim이 아니다.
- Track B run은 domain feedback를 읽거나 적용하지 않는다.

### 4.5 보정 규칙

기본 설정은 relation feedback와 같은 최소 계약을 따른다.

```typescript
const MIN_SAMPLES = 10;
const MAX_ADJUSTMENT = 0.15;

function computeAdjustment(stats: FeedbackStats): number {
  if (stats.total < MIN_SAMPLES) return 0;
  return (stats.approvalRate - 0.5) * MAX_ADJUSTMENT;
}
```

- `approved`, `rejected`, `total`, `approvalRate`, `adjustment` 산식은 relation/domain 모두 동일한 집계 규칙을 사용해도 된다.
- 다만 relation과 domain의 통계 저장소는 절대 공유하지 않는다.
- domain run 내부에서 adjustment를 어느 score 단계에 적용할지는 구현 세부이지만, 적용 시점은 Track A scoring 파이프라인 내부의 단일 단계로 고정해야 한다.

### 4.6 UI/API 최소 범위

- `PATCH /api/inference/domain-candidates/:id`
  - 승인/거부 시 domain feedback 집계 훅을 연결한다.
- `GET/PUT /api/inference/profiles/default`
  - relation/domain feedback config 및 summary를 분리해 반환/저장한다.
  - `includeFeedbackEntries=true`일 때만 relation/domain detail entries를 각각 opt-in 반환한다.
  - generic alias/resetAll은 public request/response contract로 허용하지 않는다.
- Settings
  - relation feedback summary와 domain feedback summary를 분리 표시한다.
  - relation/domain detail table은 각각 분리된 데이터 소스로 렌더링한다.
  - relation reset과 domain reset을 분리한다.
- Approval
  - domain 후보 승인 경로에 feedback 집계만 연결하면 된다.
  - hint, detail table, 후보별 보정 설명은 이번 closure의 필수 acceptance가 아니다.

## 5. 공개 응답 shape

### 5.1 `GET /api/inference/profiles/default`

```json
{
  "relationFeedbackConfig": {
    "enabled": true,
    "minSamples": 10,
    "maxAdjustment": 0.15
  },
  "relationFeedbackSummary": {
    "totalKeys": 0,
    "eligibleKeys": 0,
    "approvedCount": 0,
    "rejectedCount": 0,
    "totalSamples": 0
  },
  "domainFeedbackConfig": {
    "enabled": true,
    "minSamples": 10,
    "maxAdjustment": 0.15
  },
  "domainFeedbackSummary": {
    "totalKeys": 0,
    "eligibleKeys": 0,
    "approvedCount": 0,
    "rejectedCount": 0,
    "totalSamples": 0
  }
}
```

- `relationFeedbackEntries[]`, `domainFeedbackEntries[]`는 후속 확장용 opt-in 응답으로 둘 수 있으나 이번 closure의 필수 shape는 아니다.
- `includeFeedbackEntries=true`일 때는 opt-in으로 `relationFeedbackEntries[]`, `domainFeedbackEntries[]`를 각각 반환할 수 있다.

### 5.2 `PUT /api/inference/profiles/default`

- relation/domain feedback config는 각각 독립적으로 저장된다.
- relation/domain reset은 각각 `resetRelationFeedback`, `resetDomainFeedback`로 독립 동작한다.
- 한쪽 reset이 다른 쪽 통계나 설정을 지우면 안 된다.
- generic alias인 `feedbackConfig`, `feedbackAdjustments`, `feedbackSummary`, `feedbackEntries`, `resetAll`은 public contract가 아니다.

## 6. 수용 기준

| ID | 기준 |
|----|------|
| D1 | domain feedback는 Track A domain candidate 승인/거부 이벤트만 집계한다 |
| D2 | Track B / domain discovery 결과는 domain feedback 집계 및 적용 대상에서 제외된다 |
| D3 | relation feedback와 domain feedback는 저장 필드가 분리되어 있고 서로의 reset 동작에 영향을 주지 않는다 |
| D4 | domain feedback key는 `TRACK_A:{primaryDomainId}:{purityBucket}` 형식만 사용한다 |
| D5 | `primaryDomainId`가 없는 domain candidate 승인/거부는 domain feedback 통계에 누적되지 않는다 |
| D6 | domain feedback는 승인 직후 기존 결과를 소급 변경하지 않고 다음 Track A domain run부터만 반영된다 |
| D7 | Settings는 relation/domain feedback summary와 reset 경로를 분리해 제공한다 |
| D8 | domain 후보 API/승인 경로에 feedback 집계가 연결되어 있다 |
| D9 | approval hint, per-key detail table 확장이 없어도 이번 closure acceptance를 충족할 수 있다 |
