# 101. Frontier Review / Promotion SPEC

- 작성일: 2026-04-15
- 대상 범위: `apps/web`, `packages/inference`
- 상태: Current (Partial Rollout)
- 상태 메모: Frontier 탭, 목록/상세/patch API, patch 후 refresh/승격 처리까지 구현되었다. reason별 patch form은 alias/provider/endpoint 외 method_path/route_transform까지 확장되었다.

## 1) 배경

현재 proof 파이프라인은 `CLOSED_ATOMIC` 상태만 `relation_candidate`로 projection하고, `FRONTIER`는 run detail 중심으로만 노출된다. 이 때문에 frontier가 실제로 풍부한 단서를 포함해도 승인 업무 플로우(approval)로 연결되지 않는다.

핵심적으로 이미 존재하는 기반은 아래와 같다.

- `proof_frontiers`에 reason/detail 저장
- `proof_patches` 저장
- `validateAndApplyProofPatch()` 기반 deterministic patch 검증 및 즉시 재평가
- accepted patch 반영 후 proof replay

즉, 새로운 엔진보다 **frontier review UX + patch 제출 API/UI**가 우선이다.

## 2) 문제 정의

1. 승인 업무의 기본 단위가 `relation_candidate`에 편중되어 있다.
2. `FRONTIER`는 run detail에서 읽기만 가능하고 조치 플로우가 약하다.
3. 사람이 alias/service/endpoint 판단을 내려도 구조화된 patch로 남기기 어렵다.
4. frontier가 재평가 대신 누락/방치되는 문제가 발생한다.

## 3) 목표

1. frontier를 승인 UI의 독립 검토 대상으로 노출한다.
2. 사람이 frontier에 보정값을 입력할 수 있다.
3. 입력값은 `proof_patch`로 저장된다.
4. patch 적용 후 proof를 즉시 재평가한다.
5. `CLOSED_ATOMIC`이 되면 기존 candidate projection으로 승격한다.

## 3.1) 현재 구현 상태

- 구현 완료
  - Approval의 `Frontiers` 탭
  - `GET /api/inference/frontiers`
  - `GET /api/inference/frontiers/[proofStateId]`
  - `POST /api/inference/frontiers/[proofStateId]/patch`
  - `alias_binding`, `provider_service_selection`, `endpoint_disambiguation` patch 제출
  - patch 후 frontier/candidate refresh
  - `CLOSED_ATOMIC` 승격 시 detail 재조회 대신 시트 종료
- 미구현 또는 부분 구현
  - DB/message/Vert.x 전용 reason patch form
  - 보류/숨김/무시 액션
  - actor 식별 기반 감사 강화

## 4) 비목표

- 모든 frontier reason 동시 지원
- frontier를 곧바로 relation approval과 동일 의미로 처리
- DB/message/Vert.x frontier 1차 지원
- LLM 해소를 완전 대체하는 수동 모드

## 5) 제품 원칙

> frontier를 직접 승인하지 않고, patch를 통해 candidate로 승격한다.

사용자 플로우:

1. frontier 검토
2. 보정 입력
3. patch 저장 + 재평가
4. 성공 시 candidate 생성
5. 기존 candidate 승인 플로우 사용

## 6) 1차 지원 reason / patch 타입

### 6.1 엔진에서 우선 관찰하는 reason (Spring HTTP)

- `CONFIG_BINDING_MISSING`
- `HOST_ALIAS_UNRESOLVED`
- `PATH_ONLY_TARGET_UNRESOLVED`
- `PROVIDER_SERVICE_AMBIGUOUS`
- `PROVIDER_ENDPOINT_NOT_FOUND`
- `PATH_TEMPLATE_UNKNOWN`

### 6.2 현재 UI에서 patch form이 연결된 reason / patch type

- `CONFIG_BINDING_MISSING`, `HOST_ALIAS_UNRESOLVED` -> `alias_binding`
- `PROVIDER_SERVICE_AMBIGUOUS` -> `provider_service_selection`
- `ENDPOINT_MATCH_AMBIGUOUS` -> `endpoint_disambiguation`

추가 확장:
- `PATH_ONLY_TARGET_UNRESOLVED` -> `alias_binding`
- `PROVIDER_ENDPOINT_NOT_FOUND`, `METHOD_UNKNOWN`, `PATH_TEMPLATE_UNKNOWN` -> `method_path_hint`
- `ROUTE_FAMILY_DERIVATION_EMPTY`, `ROUTE_TO_ENDPOINT_COMPOSITION_FAILED` -> `route_transform_patch`
- `PATH_TEMPLATE_UNKNOWN` (gateway route intent) -> `route_transform_patch` 추가 허용

## 7) UX 설계

### 7.1 Approval 탭 확장

기존:
- 관계 후보
- 도메인 후보

변경:
- 관계 후보
- **Frontiers**
- 도메인 후보

### 7.2 Frontier 카드 최소 정보

- source service / source function
- intent type
- frontier reason / class
- provider service(현재/후보)
- method/path 힌트
- detail 요약
- confidence
- patch 적용 여부

### 7.3 카드 액션

1차 MVP:
- 보정
- 보류(옵션)
- 숨김/무시(옵션, 1차에서는 미구현 가능)

### 7.4 reason별 폼 매핑

- `CONFIG_BINDING_MISSING`, `HOST_ALIAS_UNRESOLVED` -> `alias_binding`
- `PROVIDER_SERVICE_AMBIGUOUS` -> `provider_service_selection`
- `ENDPOINT_MATCH_AMBIGUOUS` -> `endpoint_disambiguation`
- 미지원 reason은 read-only 안내 메시지

## 8) API 설계

### 8.1 GET `/api/inference/frontiers`

입력:
- `workspaceId`(필수)
- `reason`(optional)
- `sourceServiceId`(optional)

출력(최소):
- `proofStateId`, `intentId`, `intentType`
- `sourceServiceId/name`, `sourceFunctionId/name`
- `providerServiceId/name`
- `status`, `frontierReason`, `frontierClass`, `retryStrategy`, `priority`
- `detail`, `methodResolved`, `externalPathResolved`, `internalPathResolved`
- `confidence`, `latestPatch`

권장 구현:
- `proof_states` + `proof_frontiers` + `objects` 이름 조인
- frontier 없는 proof 제외

### 8.2 GET `/api/inference/frontiers/[proofStateId]`

출력(최소):
- frontier 기본 정보
- 최근 proof steps
- patchable actions
- candidate service list / endpoint list

후보 리스트 원칙:
- `provider_service_selection`: `detail.candidateProviderIds`
- `endpoint_disambiguation`: `detail.candidateObjectIds`
- `alias_binding`: workspace service 목록 기반 제안 허용

### 8.3 POST `/api/inference/frontiers/[proofStateId]/patch`

입력 body:
- `workspaceId`
- `patchType`
- `payload`

동작:
1. `validateAndApplyProofPatch()` 호출
2. `sourceKind = 'manual'`
3. replay 결과 반환
4. candidate 반영 상태 반환

응답(권장):
- `patchId`, `validationStatus`, `errors`
- `resolution`, `proofStatus`, `createdOrUpdatedCandidateIds`

정책:
- malformed request는 400
- patch validation reject는 200 + 명시적 상태

### 8.4 patch 적용 후 상태 갱신

- `validationStatus = REJECTED`
  - warning toast 노출
  - frontier 목록 refresh
  - 현재 detail 재조회
- `proofStatus = CLOSED_ATOMIC`
  - success toast 노출
  - frontier 목록 refresh
  - detail sheet 닫기
  - candidate refresh event dispatch
- 그 외 frontier 유지
  - warning toast 노출
  - frontier 목록 refresh
  - 현재 detail 재조회
  - candidate refresh event dispatch

## 9) Projection 규칙

- frontier를 직접 relation approval 대상으로 만들지 않는다.
- `patched proof -> CLOSED_ATOMIC`일 때만 기존 `relation_candidate` projection을 사용한다.

## 10) 감사/권한

`proof_patch`는 사람 판단이므로 최소 아래 감사 정보가 필요하다.

- 현재 구현 값은 `sourceKind = manual`
- 장기적으로는 사람이 가한 patch임을 더 명시적으로 식별할 source kind/actor 모델이 필요하다.
- actor 식별 정보(최소 API layer event log)
- `createdAt`, payload, validationStatus

## 11) 완료 기준

1. Frontiers 탭으로 frontier를 별도 조회 가능
2. 3종 patch type 제출 가능
3. 제출 patch가 deterministic validation + replay를 거침
4. replay 결과 `CLOSED_ATOMIC`이면 candidate 생성
5. 기존 candidate 승인 흐름과 충돌 없음

## 12) 연계 문서

- 구현 체크리스트: `docs/checklists/101-frontier-review-promotion-implementation-checklist.md`
