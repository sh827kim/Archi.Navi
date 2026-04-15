# 101 Frontier Review / Promotion 구현 체크리스트

- 작성일: 2026-04-15
- 상위 SPEC: [101-frontier-review-promotion-spec.md](../spec/101-frontier-review-promotion-spec.md)
- 대상 범위: `apps/web`, `packages/inference`

## 0. 목표

`FRONTIER` proof를 승인 UI에서 검토하고, 사람이 patch를 제출해
`CLOSED_ATOMIC -> relation_candidate` 승격으로 이어지게 한다.

---

## 1. 구현 범위 체크

- [ ] GET `/api/inference/frontiers`
- [ ] GET `/api/inference/frontiers/[proofStateId]`
- [ ] POST `/api/inference/frontiers/[proofStateId]/patch`
- [ ] Approval 탭에 `Frontiers` 탭 추가
- [ ] frontier 목록/상세/patch form UI
- [ ] patch 후 replay + candidate refresh

제외(이번 단계):
- [ ] DB/message/Vert.x 전용 form
- [ ] direct manual promotion
- [ ] ignore/pin/archive persistence

---

## 2. API 구현 순서

### 2.1 Read path

- [ ] `apps/web/src/app/api/inference/frontiers/route.ts` 생성
- [ ] `workspaceId` 필수 검증
- [ ] optional `reason`, `sourceServiceId` 필터 적용
- [ ] `proof_states` + `proof_frontiers` + `objects` 조인
- [ ] frontier 없는 proof 제외
- [ ] 최소 응답 필드 제공 (`proofStateId`, `intentId`, `frontierReason`, `detail`, `confidence`, `latestPatch` 등)

### 2.2 Detail path

- [ ] `apps/web/src/app/api/inference/frontiers/[proofStateId]/route.ts` 생성
- [ ] frontier 기본 정보 + 최근 proof steps 반환
- [ ] patchable actions 계산
- [ ] 후보 목록 계산
  - [ ] service 후보: `candidateProviderIds`
  - [ ] endpoint 후보: `candidateObjectIds`
  - [ ] alias 보정용 service suggestion(없어도 허용)

### 2.3 Patch apply path

- [ ] `apps/web/src/app/api/inference/frontiers/[proofStateId]/patch/route.ts` 생성
- [ ] body 검증 (`workspaceId`, `patchType`, `payload`)
- [ ] `validateAndApplyProofPatch()` 호출
- [ ] `sourceKind='human_review'` 보장
- [ ] replay 결과/후보 반영 상태 응답
- [ ] malformed request(400) vs rejected patch(200) 분리

---

## 3. UI 구현 순서

### 3.1 탭/목록

- [ ] `approval-tabs.tsx`에 `Frontiers` 탭 추가
- [ ] `frontier-approval-list.tsx`(또는 동등 컴포넌트) 추가
- [ ] 목록 로딩/빈 상태/에러 상태 처리
- [ ] reason/source service 필터 제공

### 3.2 카드/상세

- [ ] 카드에 필수 필드 노출
  - [ ] source service
  - [ ] intent type
  - [ ] frontier reason
  - [ ] provider service
  - [ ] method/path
  - [ ] priority
- [ ] 상세 sheet/dialog
  - [ ] frontier 요약
  - [ ] detail payload
  - [ ] recent proof steps
  - [ ] patch form

### 3.3 patch form

- [ ] alias_binding form
  - [ ] 노출 reason: `CONFIG_BINDING_MISSING`, `HOST_ALIAS_UNRESOLVED`
  - [ ] 입력: `aliasKey`, `aliasValue`, `resolvedServiceId`
- [ ] provider_service_selection form
  - [ ] 노출 reason: `PROVIDER_SERVICE_AMBIGUOUS`
  - [ ] 입력: `selectedServiceId`
- [ ] endpoint_disambiguation form
  - [ ] 노출 reason: `ENDPOINT_MATCH_AMBIGUOUS`
  - [ ] 입력: `endpointId`
- [ ] 미지원 reason은 read-only 안내

---

## 4. 상태 갱신 규칙

patch apply 이후:
- [ ] frontier 목록 refresh
- [ ] candidate 목록 refresh
- [ ] 결과 toast
  - [ ] `CLOSED_ATOMIC`: `Frontier를 승격했습니다. candidate로 이동했습니다.`
  - [ ] frontier 유지: `Patch를 적용했지만 아직 frontier 상태입니다.`
  - [ ] rejected: `Patch가 거절되었습니다. 입력값을 확인하세요.`

---

## 5. 테스트 체크

### 5.1 API 테스트

- [ ] frontier list 조회
- [ ] frontier detail 조회
- [ ] `alias_binding` patch apply
- [ ] `provider_service_selection` patch apply
- [ ] `endpoint_disambiguation` patch apply
- [ ] invalid payload -> rejected/malformed 처리

### 5.2 UI 테스트

- [ ] Frontiers 탭 렌더링
- [ ] frontier 카드 렌더링
- [ ] reason별 form 렌더링
- [ ] patch submit 후 refresh
- [ ] candidate refresh 호출

---

## 6. 수동 검증 체크

대상 예시: `k-raas-dev`

- [ ] frontier 수가 UI에 표시됨
- [ ] `PROVIDER_SERVICE_AMBIGUOUS` 보정 가능
- [ ] patch 후 frontier 감소 또는 candidate 생성
- [ ] `CONFIG_BINDING_MISSING` alias binding 보정 가능

---

## 7. 금지사항 확인

- [ ] frontier를 candidate 없이 직접 approved relation으로 저장하지 않음
- [ ] 서버 상태 변경 없이 로컬 상태만 갱신하지 않음
- [ ] `validateAndApplyProofPatch()` 우회 DB insert 금지
