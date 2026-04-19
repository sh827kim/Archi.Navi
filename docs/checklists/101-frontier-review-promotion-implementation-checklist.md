# 101 Frontier Review / Promotion 구현 체크리스트

- 작성일: 2026-04-15
- 상위 SPEC: [101-frontier-review-promotion-spec.md](../spec/101-frontier-review-promotion-spec.md)
- 대상 범위: `apps/web`, `packages/inference`

## 0. 목표

`FRONTIER` proof를 승인 UI에서 검토하고, 사람이 patch를 제출해
`CLOSED_ATOMIC -> relation_candidate` 승격으로 이어지게 한다.

---

## 1. 구현 범위 체크

- [x] GET `/api/inference/frontiers`
- [x] GET `/api/inference/frontiers/[proofStateId]`
- [x] POST `/api/inference/frontiers/[proofStateId]/patch`
- [x] Approval 탭에 `Frontiers` 탭 추가
- [x] frontier 목록/상세/patch form UI
- [x] patch 후 replay + candidate refresh
- [x] review defer(`보류 저장`) action

제외(이번 단계):
- DB/message/Vert.x 전용 form
- direct manual promotion
- ignore/pin/archive persistence

---

## 2. API 구현 순서

### 2.1 Read path

- [x] `apps/web/src/app/api/inference/frontiers/route.ts` 생성
- [x] `workspaceId` 필수 검증
- [x] optional `reason`, `sourceServiceId` 필터 적용
- [x] `proof_states` + `proof_frontiers` + `objects` 조인
- [x] frontier 없는 proof 제외
- [x] 최소 응답 필드 제공 (`proofStateId`, `intentId`, `frontierReason`, `detail`, `confidence`, `latestPatch` 등)

### 2.2 Detail path

- [x] `apps/web/src/app/api/inference/frontiers/[proofStateId]/route.ts` 생성
- [x] frontier 기본 정보 + 최근 proof steps 반환
- [x] patchable actions 계산
- [x] 후보 목록 계산
- [x] service 후보: `candidateProviderIds`
- [x] endpoint 후보: `candidateObjectIds`
- [x] alias 보정용 service suggestion(없어도 허용)

### 2.3 Patch apply path

- [x] `apps/web/src/app/api/inference/frontiers/[proofStateId]/patch/route.ts` 생성
- [x] body 검증 (`workspaceId`, `patchType`, `payload`, `applyMode`)
- [x] `validateAndApplyProofPatch()` 호출
- [x] `sourceKind='manual'` 보장
- [x] replay 결과/후보 반영 상태 응답
- [x] malformed request(400) vs rejected patch(200) 분리
- [x] defer request는 `PENDING` patch 저장 후 replay 생략

---

## 3. UI 구현 순서

### 3.1 탭/목록

- [x] `approval-tabs.tsx`에 `Frontiers` 탭 추가
- [x] `frontier-approval-list.tsx`(또는 동등 컴포넌트) 추가
- [x] 목록 로딩/빈 상태/에러 상태 처리
- [x] reason/source service 필터 제공

### 3.2 카드/상세

- [x] 카드에 필수 필드 노출
- [x] source service
- [x] intent type
- [x] frontier reason
- [x] provider service
- [x] method/path
- [x] priority
- [x] latest patch 상태 badge
- [x] 상세 sheet/dialog
- [x] frontier 요약
- [x] detail payload
- [x] recent proof steps
- [x] patch form

### 3.3 patch form

- [x] alias_binding form
- [x] 노출 reason: `CONFIG_BINDING_MISSING`, `HOST_ALIAS_UNRESOLVED`, `PATH_ONLY_TARGET_UNRESOLVED`
- [x] 입력: `aliasKey`, `aliasValue`, `resolvedServiceId`
- [x] provider_service_selection form
- [x] 노출 reason: `PROVIDER_SERVICE_AMBIGUOUS`
- [x] 입력: `selectedServiceId`
- [x] endpoint_disambiguation form
- [x] 노출 reason: `ENDPOINT_MATCH_AMBIGUOUS`
- [x] 입력: `endpointId`
- [x] method_path_hint form
- [x] 노출 reason: `PROVIDER_ENDPOINT_NOT_FOUND`, `METHOD_UNKNOWN`, `PATH_TEMPLATE_UNKNOWN`
- [x] 입력: `method`, `externalPath`
- [x] route_transform_patch form
- [x] 노출 reason: `ROUTE_FAMILY_DERIVATION_EMPTY`, `ROUTE_TO_ENDPOINT_COMPOSITION_FAILED`
- [x] gateway route `PATH_TEMPLATE_UNKNOWN`에서 추가 허용
- [x] 입력: `targetServiceHint`, `targetHostAlias`
- [x] 미지원 reason은 read-only 안내

---

## 4. 상태 갱신 규칙

patch apply 이후:
- [x] frontier 목록 refresh
- [x] candidate 목록 refresh
- [x] 결과 toast
- [x] `CLOSED_ATOMIC`: `Frontier를 승격했습니다. candidate로 이동했습니다.`
- [x] frontier 유지: `Patch를 적용했지만 아직 frontier 상태입니다.`
- [x] rejected: `Patch가 거절되었습니다. 입력값을 확인하세요.`
- [x] `PENDING`: `Patch를 보류로 저장했습니다. 수동 검토 대기 상태입니다.`

---

## 5. 테스트 체크

### 5.1 API 테스트

- [x] frontier list 조회
- [x] frontier detail 조회
- [x] `provider_service_selection` patch apply
- [x] `PENDING` defer 응답 회귀
- [x] invalid payload -> rejected/malformed 처리

### 5.2 UI 테스트

- [x] Frontiers 탭 렌더링
- [x] frontier 카드 렌더링
- [x] latest patch badge 렌더링
- [x] patch submit 후 refresh
- [x] 승격 시 candidate refresh 호출
- [x] defer 저장 시 detail refresh / candidate refresh 생략

---

## 6. 수동 검증 체크

대상 예시: `k-raas-dev`

- [ ] frontier 수가 UI에 표시됨
- [ ] `PROVIDER_SERVICE_AMBIGUOUS` 보정 가능
- [ ] patch 후 frontier 감소 또는 candidate 생성
- [ ] `CONFIG_BINDING_MISSING` alias binding 보정 가능

---

## 7. 금지사항 확인

- [x] frontier를 candidate 없이 직접 approved relation으로 저장하지 않음
- [x] 서버 상태 변경 없이 로컬 상태만 갱신하지 않음
- [x] `validateAndApplyProofPatch()` 우회 DB insert 금지
