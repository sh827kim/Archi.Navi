# Archi.Navi — 추론 엔진

작성일: 2026-02-22
최종 갱신: 2026-03-31
문서 버전: v4.0

---

## 1. 설계 목적

추론 엔진은 코드, 설정, DB 스키마, OpenAPI 명세에서 구조 신호를 수집해
**승인 가능한 relation/domain 후보**를 만들고, 필요 시 운영 이력과 실행 상태까지 함께 관리한다.

문서 기준의 추론 엔진은 아래 세 가지를 모두 포함한다.

| 축 | 설명 |
|----|------|
| **표준 추론** | config/code/db 기반 deterministic 후보 생성 |
| **Smart 추론** | pair-scoped atomic inference 중심의 LLM 보조 경로 |
| **운영 레이어** | async run, source 상태, 이벤트 로그, 실행 통계 |

기본 원칙은 변하지 않는다.

- 자동 추론 결과는 승인 전까지 `candidate` 상태로만 존재한다.
- 신뢰도는 신호 품질과 교차 검증 결과에 따라 조정된다.
- 실행 기록은 운영 대상이며, 단순한 내부 로그가 아니다.

---

## 2. 아키텍처

```text
Signal Collection
  - code / config / db / openapi
        ↓
Standard Inference
  - relation inference
  - domain inference
  - cross validation / feedback
        ↓
Candidate Store
  - relation_candidates
  - domain_candidates
        ↓
Approval / Mapping
  - approve / reject
  - compound → atomic endpoint mapping
        ↓
Promoted Data
  - object_relations
  - object_domain_affinities
        ↓
Delta Rollup + UI refresh

운영 레이어
  - inference_runs
  - inference_run_sources
  - inference_run_events
  - smartSummary / stats / warnings / errors
```

---

## 3. 실행 모드

## 3.1 Quick Run

- 라우트: `POST /api/inference/run`
- 용도: 즉시 실행이 필요한 표준 추론
- 특징:
  - 빠른 수동 실행에 적합
  - run entity 없이도 사용 가능
  - `config`, `code`, `db` 모드를 직접 조합한다

## 3.2 Async Run

- 라우트: `POST /api/inference/runs`, `GET /api/inference/runs`, `GET /api/inference/runs/:id`
- 용도: 운영형 실행 관리
- 특징:
  - `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELED` 상태 관리
  - source별 상태와 해석된 repo root 추적
  - warnings/errors/event log와 stats 저장

## 3.3 Smart Run

- 라우트: `POST /api/inference/smart`, `GET /api/inference/smart`
- 용도: pair-scoped atomic inference 중심의 고정밀 보조 경로
- 특징:
  - OpenAPI import + code expose bootstrap
  - config 기반 service pair 탐지
  - pair evidence pack 기반 atomic 후보 생성
  - fallback reason과 deep inspection trace 기록
  - sync/async 운용을 모두 지원

---

## 4. 신호 수집 레이어

## 4.1 코드 신호

코드 신호 수집은 `packages/inference/src/code`를 중심으로 동작한다.

| 구성 | 역할 |
|------|------|
| `codeSignalExtractor` | regex 기반 신호 추출 |
| `ast/*` | AST 기반 정밀 추출 |
| `hybridCodeSignalExtractor` | regex + AST 병합 |
| `codeSignalEngine` | `regex`, `ast`, `hybrid`, `auto` 엔진 선택 |
| `plugins/*` | 프레임워크 확장 포인트 |

저장 위치:

- `code_artifacts`
- `code_call_edges`
- `code_import_edges`
- `evidences`

## 4.2 설정 신호

config 기반 추론은 아래 파서를 중심으로 동작한다.

- `applicationYml`
- `dockerCompose`
- `k8sManifest`
- config-code binding

config 신호는 서비스 간 관계, DB/Broker 연결, endpoint binding 보강에 사용된다.

## 4.3 DB 신호

- 모듈: `packages/inference/src/db/dbSchemaSignal.ts`
- 역할:
  - FK/implicit FK 추출
  - DB 테이블 사용 근거 생성
  - relation candidate 및 evidence 저장 보강

## 4.4 OpenAPI 신호

- 모듈: `packages/inference/src/openapi/*`
- 역할:
  - OpenAPI spec import
  - provider endpoint bootstrap
  - Smart pipeline의 Phase 1 입력

---

## 5. 표준 relation 추론 파이프라인

```text
source 해석(local / githubRepo / githubOrg)
  ↓
config/code/db collector 실행
  ↓
candidate 생성
  ↓
config-code binding
  ↓
cross-signal validation
  ↓
relation_candidates 저장
```

### 5.1 source 해석 규칙

- `local`: 허용된 로컬 경로만 실행
- `githubRepo`: `gh repo clone` 후 임시 디렉토리에서 실행
- `githubOrg`: 조직 레포 목록을 해석해 개별 clone 후 실행

### 5.2 표준 추론의 특징

- `config`, `code`, `db` 모드를 독립 또는 조합 실행할 수 있다.
- code engine은 `ast`, `regex`, `hybrid`, `auto` 중 선택 가능하다.
- `crossValidatePendingRelationCandidates`로 support/contradiction 기반 신뢰도 조정이 가능하다.
- config로 생성된 compound 후보는 `configCodeBinding`으로 endpoint 단위로 더 세분화될 수 있다.

### 5.3 저장 단위

| 저장소 | 의미 |
|--------|------|
| `relation_candidates` | 승인 전 relation 후보 |
| `relation_candidate_evidences` | 후보별 evidence 연결 |
| `inference_runs.*` | 실행 상태, source, 이벤트, stats |

---

## 6. Smart 추론 파이프라인

shipped Smart 설계는 “서비스 후보 요약”이 아니라
**service pair 단위 atomic inference**를 중심으로 한다.

## 6.1 단계

```text
Phase 1   OpenAPI import
Phase 1.5 Code expose 기반 endpoint bootstrap
Phase 2   Config → LLM → candidate service pairs
Phase 2.5 Pair-scoped evidence pack assembly
Phase 3   Pair → LLM → atomic relation inference
Phase 3.5 Optional deep inspection
```

## 6.2 Phase별 역할

| 단계 | 역할 |
|------|------|
| `Phase 1` | provider endpoint를 OpenAPI에서 확보 |
| `Phase 1.5` | OpenAPI가 부족한 서비스에 code expose 기반 endpoint bootstrap 적용 |
| `Phase 2` | config 파일로 서비스 쌍과 힌트를 추출 |
| `Phase 2.5` | consumer/provider 양쪽 파일과 endpoint 정보를 pair pack으로 구성 |
| `Phase 3` | pair 단위로 `service -> api_endpoint` 후보를 생성 |
| `Phase 3.5` | 낮은 confidence 또는 부족한 맥락에 대해서만 deep inspection 수행 |

## 6.3 Smart 후보 metadata의 의미

Smart 후보는 일반 후보와 달리 아래 정보를 함께 가진다.

- `signalKind = smart_pair_atomic`
- `targetType = api_endpoint | service`
- `targetServiceId`
- `analysisMode = pair_pack | agent_assisted | full_agent`
- `fallbackReason?`
- `fallbackContext?`

### fallback reason

- `NO_ENDPOINT_OBJECTS`
- `PATH_NOT_MATCHED`
- `METHOD_NOT_MATCHED`
- `INSUFFICIENT_CONTEXT`

즉, Smart가 service-level fallback을 만들더라도
“왜 atomic으로 승격되지 못했는지”를 운영자가 추적할 수 있어야 한다.

---

## 7. Domain 추론

도메인 추론은 relation 추론과 별도로 유지되며, 두 축을 가진다.

| 축 | 설명 |
|----|------|
| Seed-based | 사용자가 정의한 named domain 기준 affinity 계산 |
| Discovery | 그래프 구조 기반 discovered domain 추출 |

구현 모듈:

- `domain/seedBased.ts`
- `domain/discovery.ts`
- `domain/labelExtractor.ts`
- `domain/approveDomainCandidate.ts`
- `domain/feedbackLoop.ts`

방향은 단일 라벨 강제가 아니라 **affinity 분포 기반 소속**을 유지하는 것이다.

---

## 8. 승인, 매핑, 승격

추론 엔진의 끝은 후보 생성이 아니라 **검토 가능한 승격 흐름**이다.

## 8.1 관계 후보

```text
relation_candidates
  → Approval UI
  → approve / reject
  → 필요 시 map-endpoints
  → object_relations
  → delta rollup
```

Approval UI는 아래를 함께 다룬다.

- 표준 추론 후보
- Smart fallback 힌트
- compound-to-atomic endpoint 매핑
- Smart trace viewer

## 8.2 도메인 후보

```text
domain_candidates
  → Approval UI
  → object_domain_affinities
```

---

## 9. 운영/관측성

inference는 실행 운영성이 중요하므로, 아래 데이터가 핵심이다.

| 테이블 | 역할 |
|--------|------|
| `inference_runs` | 실행 상태, 요청 파라미터, 집계 stats |
| `inference_run_sources` | source별 상태와 repo root |
| `inference_run_events` | 상태 전이와 경고/오류 이벤트 |

운영 UI에서 실제로 필요한 정보는 아래다.

- 실행 상태와 자동 새로고침
- 생성 후보 수
- Smart run 요약
- source message / resolved repo root
- warnings / errors / event log

즉, inference는 “엔진 내부 처리”가 아니라
**운영자 관점에서 추적 가능한 실행 단위**여야 한다.

---

## 10. 설계 방향

## 10.1 유지하는 방향

- **Atomic relation 우선**: 상위 관계는 가능한 rollup으로 파생한다.
- **Pair-scoped Smart 보강**: Smart는 서비스 목록 요약이 아니라 atomic 후보 정확도를 올리는 경로다.
- **실행 상태 표면화**: run/source/event를 제품 UI에서 읽을 수 있어야 한다.
- **승인 친화적 metadata**: fallback reason, evidence summary, cross validation 결과를 검토에 활용한다.

## 10.2 아직 의도적으로 제한하는 범위

- 자동 승인
- 무제한 agent 탐색
- 벡터 검색/임베딩 중심 전면 재설계
- 별도 job worker 인프라 필수화

---

## 11. 관련 문서

- [07-inference-engine-advanced.md](./07-inference-engine-advanced.md)
- [../spec/12-inference-run-orchestration-spec.md](../spec/12-inference-run-orchestration-spec.md)
- [../spec/37-smart-pipeline-atomic-redesign-spec.md](../spec/37-smart-pipeline-atomic-redesign-spec.md)
- [../spec/40-inference-scan-smart-async-spec.md](../spec/40-inference-scan-smart-async-spec.md)
- [../spec/42-agent-assisted-smart-atomic-spec.md](../spec/42-agent-assisted-smart-atomic-spec.md)
- [../spec/43-inference-run-ops-ux-spec.md](../spec/43-inference-run-ops-ux-spec.md)
- [../spec/47-zuul-route-aware-smart-atomic-spec.md](../spec/47-zuul-route-aware-smart-atomic-spec.md)
